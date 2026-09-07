# CI/CD & Release Engineering

Engineering specification and Proof of Work (PoW) for the SoloMD automated multi-target distribution pipeline.

---

## 1. Objectives

- **Deterministic Quality Gates:** Decouple pull request validation (`ci.yml`) from release deployment (`release.yml`).
- **Atomic Fan-In Orchestration:** Eliminate concurrent draft release race conditions via a single host publisher node.
- **Supply-Chain Hardening:** Enforce SLSA Level 3 build provenance (Sigstore / Rekor) and CycloneDX JSON SBOM generation.
- **Automated Multi-Channel Distribution:** Sync releases to Homebrew Tap (`Casks/solomd.rb`) and Crates.io (`solomd-mcp`) via RFC 8693 OIDC Trusted Publishing.

---

## 2. Pipeline Topology (DAG)

```text
┌────────────────────────────────────────────────────────┐
│ Phase 1: satellites (2)                                │
│   ├── WebExtension (Chrome / Firefox bundles)          │
│   └── AgentSkills (Pre-packaged agent recipes)         │
└───────────────────────────┬────────────────────────────┘
                            │ (Fail-Fast gate)
┌───────────────────────────▼────────────────────────────┐
│ Phase 2: desktop (5)                                   │
│   ├── macOS Universal (.dmg: aarch64 + x86_64)         │
│   ├── Windows x64 (.msi, portable .zip)                │
│   ├── Windows ARM64 (.msi, portable .zip)              │
│   ├── Linux x64 (.AppImage, .deb, .rpm, .tar.gz)       │
│   └── Linux ARM64 (.AppImage, .deb, .rpm, .tar.gz)     │
└───────────────────────────┬────────────────────────────┘
                            │ (Artifact scratch aggregation)
┌───────────────────────────▼────────────────────────────┐
│ Phase 3: Release & Provenance                          │
│   ├── Keep-a-Changelog SSOT extraction (CHANGELOG.md)  │
│   ├── Software Bill of Materials (CycloneDX JSON)      │
│   ├── Machine-readable manifest (dist-manifest.json)   │
│   ├── SLSA Level 3 provenance signing via Sigstore     │
│   └── Atomic GitHub Release publication (20 assets)    │
└───────────────────────────┬────────────────────────────┘
                            │ (Post-Release distribution)
┌───────────────────────────▼────────────────────────────┐
│ Phase 4: distribution (2)                              │
│   ├── Homebrew: Dynamic Cask render & push to Tap repo │
│   └── Crates.io: Idempotent MCP publish via OIDC JWT   │
└────────────────────────────────────────────────────────┘
```

---

## 3. Deliverables & Verification Matrix

| Target Layer | Output Format | Security & Attestation | Target Delivery |
| :--- | :--- | :--- | :--- |
| **Desktop Core** | `.dmg`, `.msi`, `.AppImage`, `.deb`, `.rpm`, `.zip` | SLSA L3 provenance, SHA-256 digests | GitHub Releases |
| **MCP Sidecar** | Standalone binaries (`.tar.gz`, `.zip`) | CycloneDX SBOM (`solomd-mcp-bom.json`) | GitHub Releases / Crates.io |
| **Satellites** | WebExtension (`.zip`), Agent skills (`.zip`) | SHA-256 digest validation | GitHub Releases |
| **Homebrew Tap** | `Casks/solomd.rb` | Dynamic SHA-256 injection | `zhitongblog/homebrew-solomd` |
| **Crates.io** | `solomd-mcp` crate | RFC 8693 OIDC JWT attestation | `crates.io/crates/solomd-mcp` |

---

## 4. Legacy vs Unified Pipeline Audit

| Capability | Legacy Infrastructure | Unified Architecture (`release.yml`) |
| :--- | :--- | :--- |
| **macOS Universal** | ❌ Manual local compilation | ✅ Automated universal binary (`aarch64` + `x86_64`) `.dmg` |
| **Windows Targets** | ⚠️ `x86_64` only | ✅ Dual Matrix: `x86_64` + `aarch64` |
| **Linux Runtime** | ⚠️ `ubuntu-22.04` (Issue #170 WebKitGTK / GLib mismatch) | ✅ `ubuntu-24.04` |
| **Satellites** | ❌ Omitted from release workflow | ✅ Automated `WebExtension` + `AgentSkills` packaging |
| **DAG Design** | ❌ Monolithic jobs with concurrent release draft races | ✅ 4-Phase Fan-Out / Fan-In Topology |
| **Manifest Engine** | ❌ None | ✅ Deterministic `dist-manifest.json` SSOT |
| **Supply Chain** | ❌ None | ✅ CycloneDX SBOM + SLSA Level 3 Attestation |
| **Homebrew Tap** | ❌ Manual commit | ✅ Automated dynamic Cask update |
| **Crates.io Publish** | ❌ Manual token | ✅ RFC 8693 OIDC Trusted Publishing |

---

## 5. Operational Workflow

### Trigger Release
```bash
# 1. Update CHANGELOG.md with release notes under ## [X.Y.Z]
# 2. Tag and push release version
git tag -a v4.12.0 -m "v4.12.0"
git push origin v4.12.0
```

### Local Provenance Verification
```bash
# Verify artifact against Sigstore / Rekor transparency log
gh attestation verify dist-manifest.json --repo zhitongblog/solomd
```

### Post-Install Verification & Gatekeeper Policy
Unsigned open-source desktop artifacts can trigger OS-level quarantine filters:
- **macOS (Gatekeeper bypass):**
  ```bash
  xattr -cr /Applications/SoloMD.app
  ```
- **Windows (SmartScreen bypass):**
  Click *More info* → *Run anyway* upon initial `.msi` or `.exe` execution.

---

## 6. Secrets & Distribution Configuration

### Secrets & Environments Matrix

| Secret / Environment | Scope | Description | Required For |
| :--- | :--- | :--- | :--- |
| `GITHUB_TOKEN` | Built-in | Provided automatically by GitHub Actions (`contents: write`, `id-token: write`, `attestations: write`) | Release creation, asset uploads, SLSA L3 attestations |
| `HOMEBREW_TAP_TOKEN` | Repository Secret | Fine-grained Personal Access Token with `Contents: Read and write` on `homebrew-solomd` | Auto-pushing updated `Casks/solomd.rb` |
| `crates.io` | GitHub Environment | Target environment configured with deployment rule `v*` | OIDC Trusted Publishing (RFC 8693) to crates.io |
| `TAURI_SIGNING_PRIVATE_KEY` | Repository Secret | *(Optional)* Private key for Tauri auto-updater bundle signatures | In-app auto-update signature verification |
| `TAURI_SIGNING_KEY_PASSWORD` | Repository Secret | *(Optional)* Password for `TAURI_SIGNING_PRIVATE_KEY` | In-app auto-update signature verification |

---

### Homebrew Tap Synchronization Setup (`publish-homebrew`)

1. **Generate Fine-grained PAT:**
   - Go to: **GitHub Settings** -> **Developer settings** -> **Personal access tokens** -> **Fine-grained tokens**.
   - **Token name:** `HOMEBREW_TAP_SYNC`
   - **Repository access:** Selected repositories -> `zhitongblog/homebrew-solomd`.
   - **Permissions:** `Repository permissions` -> `Contents: Read and write`.
2. **Add Secret to Repository:**
   - In `zhitongblog/solomd`: **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**.
   - **Name:** `HOMEBREW_TAP_TOKEN`
   - **Value:** `<YOUR_FINE_GRAINED_PAT>`

---

### Crates.io Trusted Publishing Setup (`publish-crates-io`)

1. **Create GitHub Environment:**
   - In `zhitongblog/solomd`: **Settings** -> **Environments** -> **New environment**.
   - **Name:** `crates.io`
   - **Deployment branches and tags:** Selected branches/tags -> Add rule `v*`.
2. **Configure Trusted Publisher on Crates.io:**
   - Bootstrap: Publish initial crate version (`0.1.0`) once manually with a temporary token if newly created.
   - Go to: `https://crates.io/crates/solomd-mcp/settings` -> **Trusted Publishers**.
   - Click **Add GitHub Actions workflow**:
     - **Repository Owner:** `zhitongblog`
     - **Repository Name:** `solomd`
     - **Workflow filename:** `release.yml`
     - **Environment name:** `crates.io`
   - Check **"Require trusted publishing for all new versions"** to enforce OIDC-only releases.

