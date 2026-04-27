//! v2.6.3 — End-to-end encryption round-trip across two simulated
//! devices using a `file://` bare remote.
//!
//! Verifies the invariant the threat model promises: ciphertext lives
//! on the remote, plaintext only ever exists on the device's local
//! workspace. Walks through:
//!   1. Device A sets passphrase, encrypts workspace, pushes shadow
//!   2. The bare repo's HEAD tree contains *only* `.enc` files plus
//!      assets/binaries — no plaintext leaks
//!   3. Device B sets the SAME passphrase and pulls; its workspace
//!      ends up with the original plaintext content

use app_lib::crypto::{crypto_encrypt_for_push, crypto_set_passphrase};
use app_lib::github_sync::{github_pull_inner, github_push_inner};
use git2::{Repository, Signature};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn fresh(label: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let p = std::env::temp_dir().join(format!("solomd-e2ee-{label}-{nanos}"));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
}

fn write_sync_json(folder: &Path, remote_url: &str) {
    let cfg_dir = folder.join(".solomd");
    fs::create_dir_all(&cfg_dir).unwrap();
    let body = format!(
        r#"{{"remote_url":"{}","auto_push":true,"auto_pull_minutes":0,"last_push_at":null,"last_pull_at":null,"encrypted":true,"provider":"github"}}"#,
        remote_url
    );
    fs::write(cfg_dir.join("sync.json"), body).unwrap();
    fs::write(folder.join(".gitignore"), ".solomd/\n.solomd-encrypted/\n").unwrap();
}

fn init_shadow_with_remote(folder: &Path, remote_url: &str) {
    let shadow = folder.join(".solomd-encrypted");
    fs::create_dir_all(&shadow).unwrap();
    let repo = Repository::init(&shadow).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Test").ok();
    cfg.set_str("user.email", "test@local").ok();
    let needs_switch = {
        let head = repo.find_reference("HEAD").unwrap();
        head.symbolic_target() == Some("refs/heads/master")
    };
    if needs_switch {
        repo.reference_symbolic("HEAD", "refs/heads/main", true, "switch to main")
            .unwrap();
    }
    repo.remote("origin", remote_url).unwrap();
    // Initial empty commit so HEAD exists before push/pull primitives run.
    let sig = Signature::now("Test", "test@local").unwrap();
    let tree_oid = repo.index().unwrap().write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "init shadow", &tree, &[])
        .unwrap();
}

#[test]
fn e2ee_full_round_trip_two_devices() {
    let bare = fresh("bare");
    Repository::init_bare(&bare).unwrap();
    let bare_url = format!("file://{}", bare.display());

    // ---- Device A ----
    let dev_a = fresh("devA");
    fs::write(dev_a.join("note.md"), "# Hello\n\nplain on device A\n").unwrap();
    fs::create_dir_all(dev_a.join("assets")).unwrap();
    fs::write(dev_a.join("assets/img.png"), b"\x89PNG fake bytes").unwrap();
    crypto_set_passphrase(dev_a.to_string_lossy().into_owned(), "hunter2".into()).unwrap();
    write_sync_json(&dev_a, &bare_url);
    init_shadow_with_remote(&dev_a, &bare_url);

    let folder_a = dev_a.to_string_lossy().to_string();
    github_push_inner(folder_a.clone(), "ignored".into())
        .expect("device A: encrypted push to bare");

    // The bare's `main` ref should hold ciphertext only — no plaintext
    // leaks. Inspect the tree directly so the test doesn't depend on
    // libgit2's default-branch handling at clone time.
    {
        let bare_repo = Repository::open(&bare).unwrap();
        let main_ref = bare_repo.find_reference("refs/heads/main").unwrap();
        let main_commit = main_ref.peel_to_commit().unwrap();
        let tree = main_commit.tree().unwrap();
        let mut paths_in_tree: Vec<String> = vec![];
        tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
            if let Some(name) = entry.name() {
                paths_in_tree.push(format!("{}{}", dir, name));
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        assert!(
            !paths_in_tree.iter().any(|p| p == "note.md"),
            "plaintext note.md leaked into the remote — E2EE FAILED. tree: {:?}",
            paths_in_tree
        );
        assert!(
            paths_in_tree.iter().any(|p| p == "note.md.enc"),
            "ciphertext note.md.enc missing on remote. tree: {:?}",
            paths_in_tree
        );
        let enc_entry = tree.get_path(Path::new("note.md.enc")).unwrap();
        let enc_blob = bare_repo.find_blob(enc_entry.id()).unwrap();
        assert_eq!(&enc_blob.content()[..4], b"SLMD", "ciphertext magic missing");
        let bin_entry = tree.get_path(Path::new("assets/img.png")).unwrap();
        let bin_blob = bare_repo.find_blob(bin_entry.id()).unwrap();
        assert_eq!(bin_blob.content(), b"\x89PNG fake bytes");
    }

    // ---- Device B (bootstrap flow) ----
    let dev_b = fresh("devB");
    write_sync_json(&dev_b, &bare_url);
    init_shadow_with_remote(&dev_b, &bare_url);
    let folder_b = dev_b.to_string_lossy().to_string();

    // 1) Pull first — no key yet, decrypt is a soft no-op. The pull
    //    populates the shadow with the synced salt + ciphertext.
    let r = github_pull_inner(folder_b.clone(), "ignored".into())
        .expect("device B: bootstrap pull from bare");
    assert!(
        r.kind == "merged" || r.kind == "fast_forward",
        "expected merged/ff, got {} (conflicts: {:?})",
        r.kind,
        r.conflicts
    );
    // No key set yet, so plaintext shouldn't be present.
    assert!(
        !dev_b.join("note.md").exists(),
        "plaintext should not be decrypted before passphrase is set"
    );
    assert!(
        dev_b.join(".solomd-encrypted").join(".solomd-vault.json").exists(),
        "synced salt file should have arrived in the shadow"
    );

    // 2) Set passphrase — picks up the synced salt, derives the same key.
    crypto_set_passphrase(folder_b.clone(), "hunter2".into())
        .expect("device B: set passphrase using synced salt");

    // 3) Trigger decrypt explicitly. (In the live app the user clicks a
    //    "decrypt now" button after passphrase entry; the same outcome
    //    is reached by calling the helper directly.)
    app_lib::crypto::crypto_decrypt_after_pull(folder_b.clone()).unwrap();

    let plain_b = dev_b.join("note.md");
    assert!(plain_b.exists(), "decrypted plaintext should land in workspace");
    let body = fs::read_to_string(&plain_b).unwrap();
    assert!(body.contains("plain on device A"), "decrypt produced wrong content: {}", body);
    let bin_b = dev_b.join("assets/img.png");
    assert!(bin_b.exists());
    assert_eq!(fs::read(&bin_b).unwrap(), b"\x89PNG fake bytes");

    // ---- Round-trip the other way: B edits and pushes, A pulls ----
    fs::write(dev_b.join("note.md"), "# Hello\n\nedited on device B\n").unwrap();
    github_push_inner(folder_b, "ignored".into()).expect("device B push");

    let r2 = github_pull_inner(folder_a, "ignored".into()).expect("device A pull");
    assert!(r2.kind == "fast_forward" || r2.kind == "merged");
    let body_a = fs::read_to_string(dev_a.join("note.md")).unwrap();
    assert!(
        body_a.contains("edited on device B"),
        "device A should see B's edit decrypted, got: {}",
        body_a
    );

    // Sanity check: the encrypt-for-push helper returns the absolute
    // shadow path (used by the frontend to display "encrypted under
    // ...").
    let shadow = crypto_encrypt_for_push(dev_a.to_string_lossy().into_owned()).unwrap();
    assert!(shadow.ends_with(".solomd-encrypted"));
}
