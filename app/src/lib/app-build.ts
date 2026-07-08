// App Store distribution gate.
//
// Apple rejected macOS 1.0.3 under Guideline 3.1.1 because the BYOK
// AI / Agent surface "unlocks paid functionality without In-App Purchase".
// MAS and iOS App Store builds therefore strip the AI surface; the
// GitHub Developer ID build keeps it.
//
// `scripts/build-mas.sh` and `scripts/build-ios.sh` export
// `VITE_APP_STORE_BUILD=true` before invoking the Vite build. The Rust
// side mirrors this with `SOLOMD_APP_STORE_BUILD=1` (see
// `app/src-tauri/src/app_build.rs`).

const raw = (import.meta as any).env?.VITE_APP_STORE_BUILD;
export const IS_APP_STORE_BUILD: boolean =
  raw === true || raw === 'true' || raw === '1';
