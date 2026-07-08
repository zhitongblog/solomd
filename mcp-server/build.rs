// build.rs — minimal Windows-only link config so vendored libgit2 picks
// up the legacy CryptoAPI symbols it needs (CryptGenRandom / CryptReleaseContext).
//
// libgit2's internal random number generator on Windows links against
// advapi32 (CryptoAPI). When we use `git2 = { default-features = false,
// features = ["vendored-libgit2"] }` without the `https` feature, the
// transitive openssl-sys / crypt32 imports that would otherwise satisfy
// these aren't pulled in, so the final exe fails with
//   error LNK2019: unresolved external symbol __imp_CryptGenRandom
// Adding the four standard Windows security libs here is the smallest
// fix — same link list every libgit2-using sidecar on Windows ends up
// needing. Linux / macOS skip this branch entirely.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        for lib in ["advapi32", "bcrypt", "crypt32", "userenv"] {
            println!("cargo:rustc-link-lib={lib}");
        }
    }
}
