fn main() {
    // iOS linker doesn't auto-pull libz the way macOS / Linux do. libgit2's
    // `indexer.c` and a couple of other vendored C deps reference `crc32`
    // from zlib at link time. Without this hint cargo emits a static lib
    // that xcodebuild then fails to link with "Undefined symbols: _crc32".
    // Mac / Linux / Windows ignore this because system zlib gets dragged
    // in through other crates (e.g. via Tauri itself).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-lib=z");
    }

    // App Store rejected 1.0.3 under Guideline 3.1.1 (BYOK API keys unlock
    // paid AI features). MAS / iOS builds set SOLOMD_APP_STORE_BUILD=1 to
    // gate all AI / Agent / Recipe surfaces out of the binary; GitHub
    // Developer ID builds leave it unset and ship the full feature set.
    println!("cargo:rerun-if-env-changed=SOLOMD_APP_STORE_BUILD");
    tauri_build::build()
}
