// "Set as default Markdown editor" — one-click cross-platform implementation.
//
// Each platform has its own OS-level mechanism:
//   - macOS   → LSSetDefaultRoleHandlerForContentType (LaunchServices)
//   - Windows → HKCU\Software\Classes\... + SHChangeNotify
//   - Linux   → xdg-mime default solomd.desktop <mime>
//
// The Rust command returns Ok(message) on success, Err(message) otherwise.
// The frontend surfaces this to the user via toast.

#[tauri::command]
pub fn set_as_default_markdown_editor() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        return macos::set_default();
    }
    #[cfg(target_os = "windows")]
    {
        return windows::set_default();
    }
    #[cfg(target_os = "linux")]
    {
        return linux::set_default();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Unsupported platform".to_string())
    }
}

// ====================================================================
// macOS: LaunchServices
// ====================================================================

#[cfg(target_os = "macos")]
mod macos {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    // kLSRolesAll = 0xFFFFFFFF — any role (viewer/editor/shell)
    const K_LS_ROLES_ALL: u32 = 0xFFFFFFFF;

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: u32,
            in_handler_bundle_id: CFStringRef,
        ) -> i32;
    }

    pub fn set_default() -> Result<String, String> {
        // Bundle identifier declared in tauri.conf.json
        let bundle_id = CFString::new("app.solomd");

        // UTIs that map to Markdown / plain text. Multiple UTIs exist because
        // different apps have historically declared their own: we claim them all.
        let utis = [
            "net.daringfireball.markdown",
            "public.markdown",
            "com.solomd.markdown",
        ];

        let mut ok_count = 0;
        let mut first_error: Option<i32> = None;

        for uti in &utis {
            let content_type = CFString::new(uti);
            let status = unsafe {
                LSSetDefaultRoleHandlerForContentType(
                    content_type.as_concrete_TypeRef(),
                    K_LS_ROLES_ALL,
                    bundle_id.as_concrete_TypeRef(),
                )
            };
            if status == 0 {
                ok_count += 1;
            } else if first_error.is_none() {
                first_error = Some(status);
            }
        }

        if ok_count > 0 {
            Ok(format!(
                "Set as default for {} Markdown type(s). You may need to restart Finder.",
                ok_count
            ))
        } else {
            Err(format!(
                "LaunchServices rejected the request (OSStatus {}). Try right-click → Get Info → Open with → Change All.",
                first_error.unwrap_or(-1)
            ))
        }
    }
}

// ====================================================================
// Windows: Registry (HKCU) + SHChangeNotify
// ====================================================================

#[cfg(target_os = "windows")]
mod windows {
    use std::env;
    use winreg::enums::*;
    use winreg::RegKey;

    pub fn set_default() -> Result<String, String> {
        let exe_path = env::current_exe()
            .map_err(|e| format!("Can't locate current executable: {e}"))?
            .to_string_lossy()
            .to_string();

        let command_value = format!("\"{}\" \"%1\"", exe_path);
        let icon_value = format!("{},0", exe_path);

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // 1. Register the app under Applications\SoloMD.exe so Windows shows
        //    it in the "Open with" list.
        let app_root = r"Software\Classes\Applications\SoloMD.exe";
        let (app_key, _) = hkcu
            .create_subkey(app_root)
            .map_err(|e| format!("Can't create Applications key: {e}"))?;
        app_key
            .set_value("FriendlyAppName", &"SoloMD")
            .map_err(|e| format!("Can't set FriendlyAppName: {e}"))?;

        // Supported file extensions
        let (st_key, _) = hkcu
            .create_subkey(format!("{}\\SupportedTypes", app_root))
            .map_err(|e| format!("Can't create SupportedTypes: {e}"))?;
        for ext in &[".md", ".markdown", ".mdown", ".mkd", ".txt"] {
            st_key.set_value(ext, &"").ok();
        }

        // Shell open command
        let (cmd_key, _) = hkcu
            .create_subkey(format!("{}\\shell\\open\\command", app_root))
            .map_err(|e| format!("Can't create shell command: {e}"))?;
        cmd_key
            .set_value("", &command_value.as_str())
            .map_err(|e| format!("Can't set shell command: {e}"))?;

        // 2. Create our own ProgId (SoloMD.md) with icon and open command
        let progid_root = r"Software\Classes\SoloMD.md";
        let (progid_key, _) = hkcu
            .create_subkey(progid_root)
            .map_err(|e| format!("Can't create ProgId: {e}"))?;
        progid_key.set_value("", &"Markdown Document").ok();
        progid_key
            .set_value("FriendlyTypeName", &"Markdown Document")
            .ok();

        let (icon_key, _) = hkcu
            .create_subkey(format!("{}\\DefaultIcon", progid_root))
            .map_err(|e| format!("Can't create DefaultIcon: {e}"))?;
        icon_key.set_value("", &icon_value.as_str()).ok();

        let (progid_cmd_key, _) = hkcu
            .create_subkey(format!("{}\\shell\\open\\command", progid_root))
            .map_err(|e| format!("Can't create ProgId open command: {e}"))?;
        progid_cmd_key
            .set_value("", &command_value.as_str())
            .ok();

        // 3. For each extension, attach the ProgId as an OpenWith candidate
        //    AND set it as the default.
        let extensions = [".md", ".markdown", ".mdown", ".mkd"];
        let mut ok_count = 0;
        for ext in &extensions {
            let ext_key_path = format!("Software\\Classes\\{}", ext);
            if let Ok((ext_key, _)) = hkcu.create_subkey(&ext_key_path) {
                // Set default ProgId
                ext_key.set_value("", &"SoloMD.md").ok();
                // Add to OpenWithProgids
                if let Ok((owp, _)) = hkcu.create_subkey(format!("{}\\OpenWithProgids", ext_key_path)) {
                    owp.set_value("SoloMD.md", &"").ok();
                }
                ok_count += 1;
            }
        }

        // Also register in HKCU\Software\Classes\.md\OpenWithList which some
        // Windows versions read for the "Open with" menu.
        for ext in &extensions {
            let path = format!("Software\\Classes\\{}\\OpenWithList", ext);
            if let Ok((owl, _)) = hkcu.create_subkey(&path) {
                owl.set_value("a", &"SoloMD.exe").ok();
                owl.set_value("MRUList", &"a").ok();
            }
        }

        // 4. Notify the shell that associations have changed.
        unsafe {
            sh_change_notify();
        }

        Ok(format!(
            "Registered as default for {} Markdown extension(s). You may need to sign out / in for the taskbar icon to refresh.",
            ok_count
        ))
    }

    // SHCNE_ASSOCCHANGED = 0x08000000, SHCNF_IDLIST = 0
    unsafe fn sh_change_notify() {
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn SHChangeNotify(
                w_event_id: i32,
                u_flags: u32,
                dw_item1: *const std::ffi::c_void,
                dw_item2: *const std::ffi::c_void,
            );
        }
        SHChangeNotify(0x08000000, 0, std::ptr::null(), std::ptr::null());
    }
}

// ====================================================================
// Linux: xdg-mime
// ====================================================================

#[cfg(target_os = "linux")]
mod linux {
    use std::process::Command;

    pub fn set_default() -> Result<String, String> {
        // The .desktop file name comes from Tauri's deb/rpm packaging,
        // which uses the Cargo package name (solomd) + ".desktop".
        let desktop_file = "solomd.desktop";

        // Markdown MIME types (some distros use one, some another)
        let mimes = [
            "text/markdown",
            "text/x-markdown",
            "application/x-markdown",
        ];

        let mut ok_count = 0;
        let mut last_error = String::new();

        for mime in &mimes {
            match Command::new("xdg-mime")
                .args(["default", desktop_file, mime])
                .output()
            {
                Ok(out) if out.status.success() => {
                    ok_count += 1;
                }
                Ok(out) => {
                    last_error = String::from_utf8_lossy(&out.stderr).to_string();
                }
                Err(e) => {
                    last_error = format!("Failed to run xdg-mime: {e}");
                }
            }
        }

        if ok_count > 0 {
            Ok(format!("Set as default for {} MIME type(s).", ok_count))
        } else {
            Err(format!(
                "xdg-mime failed. Install `xdg-utils` and try again. Error: {}",
                last_error
            ))
        }
    }
}
