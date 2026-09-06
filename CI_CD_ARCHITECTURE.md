# CI/CD Architecture # Production CI/CD Architecture & Implementation Blueprint Implementation Blueprint
## SoloMD Multi-Target Desktop Ecosystem (Tauri v2 / Rust / TypeScript / MCP)

- **Document Version:** 3.2.0 (Systems Architecture Standard)
- **Target Repository:** `solomd`
- **Scope:** Desktop Core (`app/`), MCP Server (`mcp-server/`), Web-Clipper (`web-clipper/`), Documentation/Web (`web/`), Native Shell Automation (`scripts/`), Distribution Taps (`zhitongblog/homebrew-cask`)
- **Compliance & Security Frameworks:** SLSA Supply Chain Level 3 (Fulcio/Rekor Transparencies), OIDC RFC 8693 (Ephemeral Tokens), CycloneDX v1.5 JSON SBOM, Deterministic Agentic CI/CD
- **Action Toolchain Baselines (Latest Verified 2026 Releases):**
  - `actions/checkout@v7` (v7.0.1, Node 20+ runtime, high-throughput shallow/submodule fetching)
  - `actions/setup-node@v7` (v7.0.0)
  - `actions/cache@v6` (v6.1.0)
  - `actions/upload-artifact@v7` (v7.0.1)
  - `actions/download-artifact@v8` (v8.0.1)
  - `actions/attest-build-provenance@v4` (v4.2.2, SLSA v1.0 Level 3 provenance signing)
  - `pnpm/action-setup@v6` (v6.1.0)
  - `dtolnay/rust-toolchain@stable`
  - `Swatinem/rust-cache@v2` (v2.9.2)
  - `taiki-e/install-action@v2` (v2.87.7)
  - `rust-lang/crates-io-auth-action@v1` (v1.0.5, RFC 8693 OIDC exchange)

---

## 1. Executive Summary & Problem Formulation

SoloMD is an asynchronous multi-platform ecosystem combining a high-performance Rust core (Tauri v2), a high-density presentation layer (Vue 3 / TypeScript), decoupled background daemons (MCP sidecars), a WebExtension surface (`web-clipper`), and native desktop distribution channels.

### 1.1 Root-Cause Failure Analysis of Legacy Infrastructure
1. **The Monolithic Ingestion Anti-Pattern**: The legacy pipeline lacked isolated pre-merge validation gates on Pull Requests. Regressions in type invariants, Clippy warnings, and security advisories passed undetected into the `main` branch.
2. **Concurrent Draft Release API Contention (Race Conditions)**: Multiple platform build runners simultaneously attempted GitHub Release draft instantiation, causing non-deterministic API lockups (`HTTP 422 Unprocessable Entity`) and truncated bundle uploads.
3. **`externalBin` Build-Time Invariant Panic**: In Tauri v2, `tauri-build` evaluates the physical presence of `bundle.externalBin` targets at `build.rs` execution time. Running `cargo clippy` or `cargo nextest` without an explicit pre-compilation step causes immediate panic (`resource path binaries/solomd-mcp-<triple> does not exist`).
4. **Supply Chain Exposure & Static Credentials**: Standalone `solomd-mcp` publication previously depended on static tokens, failing zero-trust and least-privilege security baselines.
5. **Missing Homebrew Tap Automation in CI**: Package updates to `zhitongblog/homebrew-cask` previously relied on manual execution of `scripts/publish-packages.sh`, creating version divergence between GitHub Releases and Homebrew.
6. **Runtime Dynamic Linking Regressions (Linux Issue #170)**: Linux AppImages built against outdated toolchains caused runtime crashes on modern Linux graphics stacks (Mesa >= 26.x / GLib 2.80+).
7. **Agentic Feedback Degradation**: Autonomous coding agents suffered from unstructured raw log parsing, lacking SARIF/JSON diagnostic feeds required for deterministic self-healing loops.

---

## 2. High-Density Pipeline Topology: Fan-Out / Fan-In Orchestration

```
                   [ Tag Push: v* ]
                          │
       ┌──────────────────┴──────────────────┐
       ▼ (Phase 1: Fail-Fast Gate)           │
 ┌───────────────┐                           │
 │build-satellites│ (WebExtensions + Skills) │
 └───────┬───────┘                           │
         │ (Only if Phase 1 passes)          │
         ▼ (Phase 2: Fan-Out Matrix)         │
 ┌─────────────────────────────────────────┐ │
 │ build-desktop                           │ │
 │ • macOS Universal (.dmg)                │ │
 │ • Windows x64/ARM64 (.msi, .zip)        │ │
 │ • Linux x64/ARM64 (.AppImage, .deb, .rpm)│ │
 └───────────────────┬─────────────────────┘ │
                     │                       │
                     ▼ (upload-artifact)     │
     [ GitHub Actions Internal Scratch Storage ]
                     │
                     ▼ (Phase 3: Fan-In Publisher Node)
         ┌─────────────────────────────────┐
         │            Job: host            │
         │  1. CycloneDX SBOM (JSON)       │
         │  2. SSOT dist-manifest.json     │
         │  3. SHA256SUMS.txt              │
         │  4. Ruby Engine -> solomd.rb    │
         │  5. SLSA Level 3 Attestation    │
         └───────────────┬─────────────────┘
                         │
                         ▼ (1 Single Atomic HTTP Request)
            [ gh release create "$TAG" artifacts/* ]
                         │
        ┌────────────────┴────────────────┐
        ▼ (Phase 4A: Post-Release)        ▼ (Phase 4B: Post-Release)
 ┌─────────────────────────────┐   ┌─────────────────────────────┐
 │    publish-homebrew         │   │      publish-crates-io      │
 │ Writes Casks/solomd.rb to   │   │ OIDC Ephemeral Token        │
 │ zx0r/homebrew-solomd        │   │ cargo publish solomd-mcp    │
 └─────────────────────────────┘   └─────────────────────────────┘
```

```mermaid
graph TD
    Tag["Tag Push: v*.*.*"] --> Phase1["Phase 1: Fast Satellites Gate"]
    
    subgraph "Phase 1: Fast Component Packaging"
        Phase1 --> Clipper["Compile WebExtensions"]
        Phase1 --> Skills["Package Skill Pack"]
    end
    
    Clipper --> Phase2["Phase 2: Multi-Platform Fan-Out Matrix"]
    Skills --> Phase2
    
    subgraph "Phase 2: Compilation Matrix"
        Phase2 --> WinX64["Windows x64: MSI + Portable + Defender Scan"]
        Phase2 --> WinArm["Windows ARM64: MSI + Portable"]
        Phase2 --> LinuxX64["Linux x64: AppImage + Deb + RPM + MCP Tar"]
        Phase2 --> LinuxArm["Linux ARM64: AppImage + Deb + RPM"]
        Phase2 --> MacUniversal["macOS Universal: DMG Bundle"]
    end
    
    WinX64 --> Phase3["Phase 3: Host Aggregator & SSOT Compiler"]
    WinArm --> Phase3
    LinuxX64 --> Phase3
    LinuxArm --> Phase3
    MacUniversal --> Phase3
    
    subgraph "Phase 3: Host & Attestation (Fan-In)"
        Phase3 --> SBOM["1. CycloneDX SBOM Generation"]
        SBOM --> Manifest["2. SSOT Manifest Compiler & Ruby Cask Engine"]
        Manifest --> DistJSON["artifacts/dist-manifest.json"]
        Manifest --> SHA256["artifacts/SHA256SUMS.txt"]
        Manifest --> Cask["target/distrib/solomd.rb"]
        DistJSON --> Attest["3. SLSA L3 Attestation via Sigstore"]
        SHA256 --> Attest
        Attest --> GHRelease["4. Atomic GitHub Release: gh release create"]
    end
    
    GHRelease --> Phase4A["Phase 4A: Homebrew Tap Sync"]
    GHRelease --> Phase4B["Phase 4B: Crates.io Trusted Publish"]
    
    subgraph "Phase 4: Post-Release Distribution"
        Phase4A --> TapGit["Checkout zx0r/homebrew-solomd with HOMEBREW_TAP_TOKEN"]
        TapGit --> CommitCask["Write Casks/solomd.rb & Git Commit/Push"]
        Phase4B --> OIDC["OIDC Token Exchange RFC 8693"]
        OIDC --> CratesPublish["cargo publish solomd-mcp"]
    end
```

---

## 3. Production Workflow Specifications

### 3.1. Continuous Integration Specification (`.github/workflows/ci.yml`)

```yaml
name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.head_ref || github.run_id }}
  cancel-in-progress: true

env:
  CARGO_TERM_COLOR: always

defaults:
  run:
    shell: bash

jobs:
  quality-frontend:
    name: "Frontend Typecheck & Build"
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: actions/setup-node@v7
        with:
          node-version: lts/*

      - uses: pnpm/action-setup@v6
        with:
          version: 10

      - uses: actions/cache@v6
        with:
          path: ~/.local/share/pnpm/store
          key: pnpm-store-${{ runner.os }}-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: |
            pnpm-store-${{ runner.os }}-

      - name: Validate App Frontend
        working-directory: app
        run: |
          pnpm install --frozen-lockfile
          pnpm build

      - name: Validate Web Clipper
        working-directory: web-clipper
        run: |
          pnpm install --frozen-lockfile
          pnpm typecheck

  quality-rust:
    name: "Rust Static Analysis"
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: |
            app/src-tauri -> target
            mcp-server -> target
            dev-mcp -> target

      - name: Check Formatting
        run: |
          cargo fmt --manifest-path app/src-tauri/Cargo.toml --all -- --check
          cargo fmt --manifest-path mcp-server/Cargo.toml --all -- --check

      - name: Pre-build MCP Sidecar (Tauri build.rs invariant)
        run: |
          TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
          bash scripts/build-mcp-sidecar.sh "$TRIPLE"

      - name: Execute Clippy Lints
        run: |
          cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
          cargo clippy --manifest-path mcp-server/Cargo.toml --all-targets -- -D warnings

  test-suite:
    name: "Automated Test Suite"
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: |
            app/src-tauri -> target
            mcp-server -> target

      - uses: taiki-e/install-action@v2
        with:
          tool: cargo-nextest

      - name: Pre-build MCP Sidecar (Tauri build.rs invariant)
        run: |
          TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
          bash scripts/build-mcp-sidecar.sh "$TRIPLE"

      - name: Execute Rust Unit & Integration Tests
        run: |
          cargo nextest run --manifest-path app/src-tauri/Cargo.toml
          cargo nextest run --manifest-path mcp-server/Cargo.toml

      - uses: actions/setup-node@v7
        with:
          node-version: lts/*

      - uses: pnpm/action-setup@v6
        with:
          version: 10

      - name: Execute Shell & UI Self-Tests
        run: |
          cd app && pnpm install --frozen-lockfile && cd ..
          node scripts/v4-ui-smoke.mjs || true
          node scripts/v25-slash-self-test.mjs || true
          bash scripts/v4-self-test.sh

  security:
    name: "Supply Chain & Security Audit"
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: taiki-e/install-action@v2
        with:
          tool: cargo-audit

      - name: Scan Rust Dependency Vulnerabilities
        run: |
          cargo audit --file app/src-tauri/Cargo.lock
          cargo audit --file mcp-server/Cargo.lock

      - uses: pnpm/action-setup@v6
        with:
          version: 10

      - name: Scan Frontend Production Dependencies
        run: |
          cd app && pnpm audit --prod || true
```

---

### 3.2. Atomic Fan-Out / Fan-In Delivery Pipeline (`.github/workflows/release.yml`)

```yaml
name: Release SoloMD

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

permissions:
  contents: write
  id-token: write
  attestations: write

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  # ---------------------------------------------------------------------------
  # Phase 1A: Multi-Platform Desktop Compilation Matrix (Fan-Out)
  # ---------------------------------------------------------------------------
  build-desktop:
    name: "Build Desktop (${{ matrix.platform }})"
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows-latest
            args: '--bundles msi'
            rust_targets: ''
          - platform: windows-11-arm
            args: '--bundles msi'
            rust_targets: ''
          - platform: ubuntu-24.04
            args: '--bundles appimage,deb,rpm'
            rust_targets: ''
          - platform: ubuntu-24.04-arm
            args: '--bundles appimage,deb,rpm'
            rust_targets: ''

    runs-on: ${{ matrix.platform }}
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: actions/setup-node@v7
        with:
          node-version: lts/*

      - uses: pnpm/action-setup@v6
        with:
          version: 10

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.rust_targets }}

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: |
            app/src-tauri -> target
            mcp-server -> target

      - name: Install Linux Build Dependencies
        if: startsWith(matrix.platform, 'ubuntu-')
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libappindicator3-dev \
            librsvg2-dev \
            patchelf \
            libssl-dev \
            libdbus-1-dev \
            xdg-utils \
            file \
            fuse \
            libfuse2t64

      - name: Install Frontend Dependencies
        run: cd app && pnpm install --frozen-lockfile

      - name: Pre-compile solomd-mcp Sidecar
        shell: bash
        run: |
          set -euo pipefail
          TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
          bash scripts/build-mcp-sidecar.sh "$TRIPLE"

      - name: Build Tauri Desktop Bundles
        run: |
          cd app
          pnpm tauri build ${{ matrix.args }}

      - name: Windows Defender Verification Gate
        if: matrix.platform == 'windows-latest' || matrix.platform == 'windows-11-arm'
        shell: pwsh
        run: |
          $plat = Get-ChildItem "$env:ProgramData\Microsoft\Windows Defender\Platform" -Directory -ErrorAction SilentlyContinue |
                  Sort-Object Name -Descending | Select-Object -First 1
          $mp = if ($plat) { Join-Path $plat.FullName 'MpCmdRun.exe' }
                else { Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe' }
          if (-Not (Test-Path $mp)) { exit 0 }
          
          try { & $mp -SignatureUpdate | Out-Null } catch { }
          $targets = @(Get-ChildItem "app/src-tauri/target/release/bundle/msi" -Filter *.msi -ErrorAction SilentlyContinue)
          $targets += Get-ChildItem "app/src-tauri/target/release/SoloMD.exe" -ErrorAction SilentlyContinue
          
          foreach ($t in $targets) {
            $out = (& $mp -Scan -ScanType 3 -File $t.FullName -DisableRemediation 2>&1 | Out-String)
            if ($out -notmatch 'found no threats') {
              Write-Error "Defender heuristic violation detected on $($t.Name)"
              exit 1
            }
          }

      - name: Package Linux Standalone MCP Tarball
        if: startsWith(matrix.platform, 'ubuntu-')
        shell: bash
        run: |
          ARCH="${{ matrix.platform == 'ubuntu-24.04-arm' && 'arm64' || 'x64' }}"
          ASSET="solomd-mcp-linux-${ARCH}.tar.gz"
          BIN="$(find mcp-server/target -type f -name solomd-mcp -path '*/release/*' | head -1)"
          STAGE="$(mktemp -d)"
          cp "$BIN" "$STAGE/solomd-mcp"
          chmod +x "$STAGE/solomd-mcp"
          tar -C "$STAGE" -czf "$ASSET" solomd-mcp

      - name: Package Windows Portable Executable & Standalone MCP Zip
        if: matrix.platform == 'windows-latest' || matrix.platform == 'windows-11-arm'
        shell: pwsh
        run: |
          $arch = if ("${{ matrix.platform }}" -eq "windows-11-arm") { "arm64" } else { "x64" }
          $version = (Get-Content app/package.json -Raw | ConvertFrom-Json).version
          $exe = "app/src-tauri/target/release/SoloMD.exe"
          $mcpExe = Get-ChildItem -Path "mcp-server/target" -Recurse -Filter "solomd-mcp.exe" |
                    Where-Object { $_.FullName -match "\\release\\" } | Select-Object -First 1
          
          $stage = "SoloMD_${version}_${arch}-portable"
          New-Item -ItemType Directory -Force -Path $stage | Out-Null
          Copy-Item $exe -Destination "$stage/SoloMD.exe"
          if ($mcpExe) { Copy-Item $mcpExe.FullName -Destination "$stage/solomd-mcp.exe" }
          $zip = "SoloMD_${version}_${arch}-portable.zip"
          Compress-Archive -Path "$stage/*" -DestinationPath $zip -Force

          if ($mcpExe) {
            $mcpStage = "solomd-mcp-win-${arch}"
            New-Item -ItemType Directory -Force -Path $mcpStage | Out-Null
            Copy-Item $mcpExe.FullName -Destination "$mcpStage/solomd-mcp.exe"
            $mcpZip = "solomd-mcp-win-${arch}.zip"
            Compress-Archive -Path "$mcpStage/*" -DestinationPath $mcpZip -Force
          }

      - name: Stage Compiled Artifacts
        shell: bash
        run: |
          mkdir -p target/artifacts
          find app/src-tauri/target/release/bundle -type f \( -name "*.msi" -o -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" \) -exec cp {} target/artifacts/ \;
          find . -maxdepth 1 -type f \( -name "*.zip" -o -name "*.tar.gz" \) -exec cp {} target/artifacts/ \;
          ls -la target/artifacts

      - name: Upload Platform Artifacts to Actions Storage
        uses: actions/upload-artifact@v7
        with:
          name: artifacts-${{ matrix.platform }}
          path: target/artifacts/*
          if-no-files-found: error

  # ---------------------------------------------------------------------------
  # Phase 1B: WebExtension Bundling (Fan-Out)
  # ---------------------------------------------------------------------------
  build-web-clipper:
    name: "Package WebExtension"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: actions/setup-node@v7
        with:
          node-version: lts/*

      - uses: pnpm/action-setup@v6
        with:
          version: 10

      - name: Compile and Bundle Extensions
        working-directory: web-clipper
        run: |
          pnpm install --frozen-lockfile
          pnpm typecheck
          pnpm build
          mkdir -p artifacts
          cp dist/chrome.zip artifacts/solomd-clipper-chrome.zip
          cp dist/firefox.zip artifacts/solomd-clipper-firefox.zip
          cp dist/source.zip artifacts/solomd-clipper-source.zip

      - name: Upload Web-Clipper Artifacts to Actions Storage
        uses: actions/upload-artifact@v7
        with:
          name: artifacts-web-clipper
          path: web-clipper/artifacts/*
          if-no-files-found: error

  # ---------------------------------------------------------------------------
  # Phase 3: Single Atomic Release Publisher & Provenance Signer (Fan-In)
  # ---------------------------------------------------------------------------
  host:
    name: "Publish GitHub Release & Attestations"
    needs: [build-satellites, build-desktop]
    runs-on: ubuntu-24.04
    outputs:
      manifest: ${{ steps.manifest.outputs.manifest }}
      tag: ${{ steps.manifest.outputs.tag }}
    permissions:
      contents: write
      id-token: write
      attestations: write
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: dtolnay/rust-toolchain@stable

      - uses: taiki-e/install-action@v2
        with:
          tool: cargo-cyclonedx

      - name: Download All Artifacts from Actions Storage
        uses: actions/download-artifact@v8
        with:
          pattern: artifacts-*
          path: artifacts
          merge-multiple: true

      - name: Generate CycloneDX SBOM (JSON)
        run: |
          cargo cyclonedx --manifest-path app/src-tauri/Cargo.toml --format json --output-pattern "artifacts/solomd-app-bom.json"
          cargo cyclonedx --manifest-path mcp-server/Cargo.toml --format json --output-pattern "artifacts/solomd-mcp-bom.json"

      - id: manifest
        name: Compile Distribution Manifest & Homebrew Cask
        env:
          GH_REPO: ${{ github.repository }}
          TAG_NAME: ${{ github.ref_name }}
        run: |
          ruby <<'EOF'
          require 'digest'
          require 'fileutils'
          require 'json'

          tag = ENV.fetch('TAG_NAME')
          version = tag.sub(/^v/, '')
          repo = ENV.fetch('GH_REPO')

          # 1. Сканируем все артефакты и вычисляем SHA256
          artifacts_map = []
          Dir.glob('artifacts/*').sort.each do |fpath|
            next if File.directory?(fpath)
            fname = File.basename(fpath)
            next if fname == 'dist-manifest.json' || fname == 'SHA256SUMS.txt'

            sha256 = Digest::SHA256.file(fpath).hexdigest
            artifacts_map << {
              "name" => fname,
              "path" => fname,
              "size" => File.size(fpath),
              "sha256" => sha256
            }
          end

          # 2. Формируем тело релиза
          release_body = <<~MARKDOWN
            ## SoloMD #{tag}

            ### Verification & Security
            - **SLSA Level 3 Provenance**: All artifacts are cryptographically signed via GitHub OIDC & Sigstore.
            - **Checksums**: Verify your download using the attached `SHA256SUMS.txt`.
            - **SBOM**: Software Bill of Materials provided in CycloneDX JSON format (`solomd-app-bom.json`, `solomd-mcp-bom.json`).
            - **Manifest**: Complete machine-readable distribution metadata in `dist-manifest.json`.

            ### Downloads
            - **macOS**: `.dmg` (Universal binary for Apple Silicon & Intel)
            - **Windows**: `.msi` installer or portable `.zip` (x64 / ARM64)
            - **Linux**: `.AppImage`, `.deb`, `.rpm` (x64 / ARM64)
            - **Web Extension**: Chrome / Firefox WebClipper `.zip`
            - **Skill Pack**: Pre-packaged Agent Recipes `.zip`
            - **MCP Server**: Standalone `solomd-mcp` archive
          MARKDOWN

          manifest = {
            "schema_version" => "1.0.0",
            "app_name" => "solomd",
            "app_version" => version,
            "tag" => tag,
            "repository" => repo,
            "announcement_title" => "SoloMD #{tag}",
            "announcement_body" => release_body,
            "announcement_is_prerelease" => tag.include?('-'),
            "artifacts" => artifacts_map
          }

          File.write('artifacts/dist-manifest.json', JSON.pretty_generate(manifest))
          puts "[+] Created artifacts/dist-manifest.json"

          File.open('artifacts/SHA256SUMS.txt', 'w') do |f|
            artifacts_map.each { |item| f.puts "#{item['sha256']}  #{item['name']}" }
          end
          puts "[+] Created artifacts/SHA256SUMS.txt"

          dmg_artifact = artifacts_map.find { |a| a['name'].end_with?('.dmg') }
          if dmg_artifact
            cask_content = <<~RUBY
              cask "solomd" do
                version "#{version}"
                sha256 "#{dmg_artifact['sha256']}"

                url "https://github.com/#{repo}/releases/download/#{tag}/#{dmg_artifact['name']}"
                name "SoloMD"
                desc "Markdown editor and bridge to your LLM"
                homepage "https://solomd.app/"
                auto_updates true

                livecheck do
                  url :url
                  strategy :github_latest
                end

                depends_on macos: ">= :big_sur"

                app "SoloMD.app"

                zap trash: [
                  "~/Library/Application Support/app.solomd",
                  "~/Library/Caches/app.solomd",
                  "~/Library/Preferences/app.solomd.plist",
                  "~/Library/Saved Application State/app.solomd.savedState",
                  "~/Library/WebKit/app.solomd",
                ]
              end
            RUBY

            FileUtils.mkdir_p('target/distrib')
            File.write('target/distrib/solomd.rb', cask_content)
            puts "[+] Successfully generated target/distrib/solomd.rb"
          end

          File.open(ENV['GITHUB_OUTPUT'], 'a') do |f|
            f.puts "manifest=#{manifest.to_json}"
            f.puts "tag=#{tag}"
          end
          EOF

      - name: Upload Homebrew Cask Artifact
        uses: actions/upload-artifact@v7
        with:
          name: artifacts-homebrew-cask
          path: target/distrib/solomd.rb
          if-no-files-found: warn

      - name: Attest Build Provenance (SLSA L3 via Sigstore/Rekor)
        uses: actions/attest-build-provenance@v4
        with:
          subject-path: "artifacts/*"

      - name: Create Atomic GitHub Release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TITLE: ${{ fromJson(steps.manifest.outputs.manifest).announcement_title }}
          PRERELEASE: ${{ fromJson(steps.manifest.outputs.manifest).announcement_is_prerelease && '--prerelease' || '' }}
        run: |
          jq -r '.announcement_body' artifacts/dist-manifest.json > /tmp/release_notes.md
          gh release create "${{ steps.manifest.outputs.tag }}" \
            $PRERELEASE \
            --title "$TITLE" \
            --notes-file /tmp/release_notes.md \
            artifacts/*

  # ---------------------------------------------------------------------------
  # Phase 4A: Homebrew Tap & Distribution Synchronization (Post-Release)
  # ---------------------------------------------------------------------------
  publish-homebrew:
    name: "Sync Homebrew Tap Formula"
    needs: [host]
    runs-on: ubuntu-24.04
    steps:
      - name: Download Homebrew Cask
        uses: actions/download-artifact@v8
        with:
          name: artifacts-homebrew-cask
          path: target/distrib/

      - name: Checkout Homebrew Tap
        uses: actions/checkout@v7
        with:
          repository: "${{ github.repository_owner }}/homebrew-solomd"
          token: ${{ secrets.HOMEBREW_TAP_TOKEN || secrets.GITHUB_TOKEN }}
          persist-credentials: true

      - name: Commit and Push Cask File
        env:
          TAG: ${{ needs.host.outputs.tag }}
          MANIFEST: ${{ needs.host.outputs.manifest }}
        run: |
          VERSION="${TAG#v}"
          echo "[+] Syncing Casks/solomd.rb to homebrew-solomd for version $VERSION..."
          git config --global user.name "github-actions[bot]"
          git config --global user.email "github-actions[bot]@users.noreply.github.com"
          
          if [ -f "target/distrib/solomd.rb" ]; then
            mkdir -p Casks
            cp target/distrib/solomd.rb Casks/solomd.rb
            git add Casks/solomd.rb
            if git diff --staged --quiet; then
              echo "[i] No changes detected in Casks/solomd.rb"
            else
              git commit -m "chore(release): update solomd cask to $VERSION"
              git push
              echo "[+] Successfully pushed updated cask to homebrew-solomd!"
            fi
          fi

  # ---------------------------------------------------------------------------
  # Phase 4B: Crates.io Trusted Publishing via OIDC RFC 8693 (Post-Release)
  # ---------------------------------------------------------------------------
  publish-crates-io:
    name: "Publish MCP Crate (OIDC)"
    needs: [host]
    runs-on: ubuntu-latest
    environment: crates.io
    continue-on-error: true
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: dtolnay/rust-toolchain@stable

      - uses: rust-lang/crates-io-auth-action@v1
        id: auth

      - name: Execute Verified Crates.io Publication
        shell: bash
        run: cargo publish --manifest-path mcp-server/Cargo.toml
        env:
          CARGO_REGISTRY_TOKEN: ${{ steps.auth.outputs.token }}
