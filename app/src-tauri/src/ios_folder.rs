//! iOS: open a folder of the user's choice as the workspace.
//!
//! Until now "Open Folder" on iOS silently pinned the workspace to the app's
//! own Documents folder ("On My iPhone › SoloMD") and told people, in a toast,
//! to move their notes there through the Files app. People could not find it
//! and could not use the folder their notes already live in (App Store review
//! "can't change the working folder").
//!
//! This presents the system folder picker (`UIDocumentPickerViewController`
//! for `public.folder`), starts security-scoped access on the chosen folder —
//! which makes plain `std::fs` reads and writes inside it work — and keeps a
//! bookmark so the access is restored on the next launch
//! (`ios_restore_folder`). The picker also lists "On My iPhone › SoloMD", so
//! the old folder remains one tap away. Elsewhere both commands are no-ops.
//!
//! It also opens the security scope of documents opened in place from the
//! Files app ([`hook_open_url`], [`ios_scoped_files`]) — see the
//! LSSupportsOpeningDocumentsInPlace note in ios-project-overlay.yml.

use tauri::AppHandle;

const BOOKMARK_FILE: &str = "workspace-folder.bookmark";

#[cfg(target_os = "ios")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject, Sel};
    use objc2::{declare_class, msg_send, msg_send_id, mutability, ClassType, DeclaredClass};
    use std::ffi::{c_void, CStr, CString};
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tokio::sync::oneshot;

    #[link(name = "UIKit", kind = "framework")]
    extern "C" {}
    #[link(name = "UniformTypeIdentifiers", kind = "framework")]
    extern "C" {}

    /// What a successful pick hands back: the folder's path and its bookmark.
    pub type Picked = Option<(String, Vec<u8>)>;

    static PENDING: Mutex<Option<oneshot::Sender<Picked>>> = Mutex::new(None);
    /// The NSURL whose security scope is currently open (retained), or 0.
    static ACTIVE_URL: AtomicUsize = AtomicUsize::new(0);
    /// The one delegate instance (the picker only holds it weakly).
    static DELEGATE: AtomicUsize = AtomicUsize::new(0);

    declare_class!(
        struct FolderPickerDelegate;

        // SAFETY: NSObject has no subclassing requirements; no Drop impl.
        unsafe impl ClassType for FolderPickerDelegate {
            type Super = NSObject;
            type Mutability = mutability::InteriorMutable;
            const NAME: &'static str = "SoloMDFolderPickerDelegate";
        }

        impl DeclaredClass for FolderPickerDelegate {}

        unsafe impl FolderPickerDelegate {
            #[method(documentPicker:didPickDocumentsAtURLs:)]
            fn did_pick(&self, _picker: *mut AnyObject, urls: *mut AnyObject) {
                let picked = unsafe { take_first(urls) };
                finish(picked);
            }

            #[method(documentPickerWasCancelled:)]
            fn cancelled(&self, _picker: *mut AnyObject) {
                finish(None);
            }
        }
    );

    impl FolderPickerDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send_id![super(this), init] }
        }
    }

    fn finish(picked: Picked) {
        if let Some(tx) = PENDING.lock().ok().and_then(|mut p| p.take()) {
            let _ = tx.send(picked);
        }
    }

    unsafe fn ns_string(s: &str) -> *mut AnyObject {
        let c = CString::new(s).unwrap_or_default();
        msg_send![AnyClass::get("NSString").unwrap(), stringWithUTF8String: c.as_ptr()]
    }

    unsafe fn rust_string(ns: *mut AnyObject) -> Option<String> {
        if ns.is_null() {
            return None;
        }
        let p: *const std::os::raw::c_char = msg_send![ns, UTF8String];
        (!p.is_null()).then(|| CStr::from_ptr(p).to_string_lossy().into_owned())
    }

    unsafe fn bookmark_of(url: *mut AnyObject) -> Option<Vec<u8>> {
        let mut err: *mut AnyObject = null_mut();
        let data: *mut AnyObject = msg_send![url,
            bookmarkDataWithOptions: 0usize,
            includingResourceValuesForKeys: null_mut::<AnyObject>(),
            relativeToURL: null_mut::<AnyObject>(),
            error: &mut err as *mut *mut AnyObject];
        if data.is_null() {
            return None;
        }
        let len: usize = msg_send![data, length];
        let bytes: *const c_void = msg_send![data, bytes];
        if bytes.is_null() || len == 0 {
            return None;
        }
        Some(std::slice::from_raw_parts(bytes as *const u8, len).to_vec())
    }

    /// Open `url`'s security scope and make it the active one (closing the
    /// previous folder's). Returns its path.
    unsafe fn activate(url: *mut AnyObject) -> Option<String> {
        let _: Bool = msg_send![url, startAccessingSecurityScopedResource];
        let _: *mut AnyObject = msg_send![url, retain];
        let old = ACTIVE_URL.swap(url as usize, Ordering::SeqCst) as *mut AnyObject;
        if !old.is_null() && old != url {
            let _: () = msg_send![old, stopAccessingSecurityScopedResource];
            let _: () = msg_send![old, release];
        }
        let path: *mut AnyObject = msg_send![url, path];
        rust_string(path)
    }

    unsafe fn take_first(urls: *mut AnyObject) -> Picked {
        if urls.is_null() {
            return None;
        }
        let url: *mut AnyObject = msg_send![urls, firstObject];
        if url.is_null() {
            return None;
        }
        let path = activate(url)?;
        let bookmark = bookmark_of(url).unwrap_or_default();
        Some((path, bookmark))
    }

    /// The view controller to present from: the key window's root, walked up
    /// to whatever it is already presenting.
    unsafe fn top_view_controller() -> Option<*mut AnyObject> {
        let app: *mut AnyObject = msg_send![AnyClass::get("UIApplication")?, sharedApplication];
        let scenes: *mut AnyObject = msg_send![app, connectedScenes];
        let all: *mut AnyObject = msg_send![scenes, allObjects];
        let count: usize = msg_send![all, count];
        let scene_cls = AnyClass::get("UIWindowScene")?;
        for i in 0..count {
            let scene: *mut AnyObject = msg_send![all, objectAtIndex: i];
            let is_ws: Bool = msg_send![scene, isKindOfClass: scene_cls];
            if !is_ws.as_bool() {
                continue;
            }
            let windows: *mut AnyObject = msg_send![scene, windows];
            let n: usize = msg_send![windows, count];
            let mut chosen: *mut AnyObject = null_mut();
            for j in 0..n {
                let w: *mut AnyObject = msg_send![windows, objectAtIndex: j];
                let key: Bool = msg_send![w, isKeyWindow];
                if key.as_bool() || chosen.is_null() {
                    chosen = w;
                }
                if key.as_bool() {
                    break;
                }
            }
            if chosen.is_null() {
                continue;
            }
            let mut vc: *mut AnyObject = msg_send![chosen, rootViewController];
            loop {
                if vc.is_null() {
                    break;
                }
                let next: *mut AnyObject = msg_send![vc, presentedViewController];
                if next.is_null() {
                    return Some(vc);
                }
                vc = next;
            }
        }
        None
    }

    /// Main thread: present the folder picker. Returns false if it could not.
    pub unsafe fn present() -> bool {
        let (Some(utt), Some(array), Some(picker_cls)) = (
            AnyClass::get("UTType"),
            AnyClass::get("NSArray"),
            AnyClass::get("UIDocumentPickerViewController"),
        ) else {
            return false;
        };
        let folder: *mut AnyObject = msg_send![utt, typeWithIdentifier: ns_string("public.folder")];
        if folder.is_null() {
            return false;
        }
        let types: *mut AnyObject = msg_send![array, arrayWithObject: folder];
        let alloc: *mut AnyObject = msg_send![picker_cls, alloc];
        let picker: *mut AnyObject = msg_send![alloc, initForOpeningContentTypes: types];
        if picker.is_null() {
            return false;
        }
        let mut delegate = DELEGATE.load(Ordering::SeqCst) as *mut AnyObject;
        if delegate.is_null() {
            delegate = Retained::into_raw(FolderPickerDelegate::new()) as *mut AnyObject;
            DELEGATE.store(delegate as usize, Ordering::SeqCst);
        }
        let _: () = msg_send![picker, setDelegate: delegate];
        let _: () = msg_send![picker, setAllowsMultipleSelection: Bool::NO];
        let Some(top) = top_view_controller() else {
            let _: () = msg_send![picker, release];
            return false;
        };
        // showViewController presents modally from a non-navigation root —
        // and, unlike presentViewController:animated:completion:, takes no
        // block argument.
        let _: () = msg_send![top, showViewController: picker, sender: null_mut::<AnyObject>()];
        let _: () = msg_send![picker, release];
        true
    }

    pub fn arm() -> oneshot::Receiver<Picked> {
        let (tx, rx) = oneshot::channel();
        // A pick still pending (picker dismissed some other way) is abandoned.
        if let Ok(mut p) = PENDING.lock() {
            *p = Some(tx);
        }
        rx
    }

    /// Files tapped in the Files app whose security scope we opened.
    static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());
    /// tao's own application:openURL:options: implementation.
    static ORIG_OPEN_URL: AtomicUsize = AtomicUsize::new(0);

    type OpenUrlFn =
        unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject) -> Bool;

    /// Open the security scope of a file URL iOS handed us and remember its
    /// path. Only that NSURL carries the sandbox extension; tao reduces it to
    /// a string right after. The scope stays open (and the URL retained) for
    /// the life of the process, so read_file and a later save back to the
    /// file both work.
    unsafe fn grant_scope(url: *mut AnyObject) {
        if url.is_null() {
            return;
        }
        let is_file: Bool = msg_send![url, isFileURL];
        if !is_file.as_bool() {
            return;
        }
        let granted: Bool = msg_send![url, startAccessingSecurityScopedResource];
        if granted.as_bool() {
            let _: *mut AnyObject = msg_send![url, retain];
        }
        let path: *mut AnyObject = msg_send![url, path];
        if let (Some(p), Ok(mut list)) = (rust_string(path), OPENED.lock()) {
            if !list.contains(&p) {
                list.push(p);
            }
        }
    }

    unsafe extern "C" fn open_url_hook(
        this: *mut AnyObject,
        cmd: Sel,
        app: *mut AnyObject,
        url: *mut AnyObject,
        options: *mut AnyObject,
    ) -> Bool {
        grant_scope(url);
        match ORIG_OPEN_URL.load(Ordering::SeqCst) {
            0 => Bool::YES,
            f => {
                let orig: OpenUrlFn = std::mem::transmute(f);
                orig(this, cmd, app, url, options)
            }
        }
    }

    /// Wrap tao's `AppDelegate` `application:openURL:options:`. Runs from
    /// setup, which on iOS happens inside didFinishLaunching — before iOS
    /// delivers the URL a cold launch was opened with.
    pub fn hook_open_url() {
        if ORIG_OPEN_URL.load(Ordering::SeqCst) != 0 {
            return;
        }
        let Some(cls) = AnyClass::get("AppDelegate") else {
            return;
        };
        let Some(method) = cls.instance_method(objc2::sel!(application:openURL:options:)) else {
            return;
        };
        unsafe {
            let hook: OpenUrlFn = open_url_hook;
            let old = method.set_implementation(std::mem::transmute(hook));
            ORIG_OPEN_URL.store(old as usize, Ordering::SeqCst);
        }
    }

    // ── Scene lifecycle (iOS 27 SDK, Tauri 2.12 / tao 0.37) ──────────────
    // With a UIApplicationSceneManifest, iOS no longer calls the app
    // delegate's application:openURL:options:. A document opened from Files
    // arrives at the scene delegate instead — scene:openURLContexts: while the
    // app runs, and in the connection options of the first scene on a cold
    // launch, which tao does not read at all. Both are wrapped here; the hooks
    // must be in place before UIApplicationMain, i.e. between Builder::build
    // (which registers TaoSceneDelegate) and App::run.

    static ORIG_SCENE_OPEN: AtomicUsize = AtomicUsize::new(0);
    static ORIG_SCENE_CONNECT: AtomicUsize = AtomicUsize::new(0);

    type SceneOpenFn = unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject);
    type SceneConnectFn =
        unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject);

    /// Each UIOpenURLContext in an NSSet → its NSURL's scope opened.
    unsafe fn grant_contexts(contexts: *mut AnyObject) {
        if contexts.is_null() {
            return;
        }
        let all: *mut AnyObject = msg_send![contexts, allObjects];
        let n: usize = msg_send![all, count];
        for i in 0..n {
            let ctx: *mut AnyObject = msg_send![all, objectAtIndex: i];
            let url: *mut AnyObject = msg_send![ctx, URL];
            grant_scope(url);
        }
    }

    unsafe extern "C" fn scene_open_hook(
        this: *mut AnyObject,
        cmd: Sel,
        scene: *mut AnyObject,
        contexts: *mut AnyObject,
    ) {
        grant_contexts(contexts);
        let f = ORIG_SCENE_OPEN.load(Ordering::SeqCst);
        if f != 0 {
            let orig: SceneOpenFn = std::mem::transmute(f);
            orig(this, cmd, scene, contexts);
        }
    }

    unsafe extern "C" fn scene_connect_hook(
        this: *mut AnyObject,
        cmd: Sel,
        scene: *mut AnyObject,
        session: *mut AnyObject,
        options: *mut AnyObject,
    ) {
        let f = ORIG_SCENE_CONNECT.load(Ordering::SeqCst);
        if f != 0 {
            let orig: SceneConnectFn = std::mem::transmute(f);
            orig(this, cmd, scene, session, options);
        }
        // A cold launch from Files: the document is in the connection
        // options, which tao ignores. Deliver it the way a warm open arrives,
        // through scene:openURLContexts: (scope opened above, then tao emits
        // RunEvent::Opened as usual).
        if options.is_null() {
            return;
        }
        let contexts: *mut AnyObject = msg_send![options, URLContexts];
        if contexts.is_null() {
            return;
        }
        let n: usize = msg_send![contexts, count];
        if n > 0 {
            let _: () = msg_send![this, scene: scene, openURLContexts: contexts];
        }
    }

    /// Wrap TaoSceneDelegate's open-URL and connect methods. Call after
    /// Builder::build and before App::run.
    pub fn hook_scene_delegate() {
        let Some(cls) = AnyClass::get("TaoSceneDelegate") else {
            return;
        };
        unsafe {
            if ORIG_SCENE_OPEN.load(Ordering::SeqCst) == 0 {
                if let Some(m) = cls.instance_method(objc2::sel!(scene:openURLContexts:)) {
                    let hook: SceneOpenFn = scene_open_hook;
                    let old = m.set_implementation(std::mem::transmute(hook));
                    ORIG_SCENE_OPEN.store(old as usize, Ordering::SeqCst);
                }
            }
            if ORIG_SCENE_CONNECT.load(Ordering::SeqCst) == 0 {
                if let Some(m) =
                    cls.instance_method(objc2::sel!(scene:willConnectToSession:options:))
                {
                    let hook: SceneConnectFn = scene_connect_hook;
                    let old = m.set_implementation(std::mem::transmute(hook));
                    ORIG_SCENE_CONNECT.store(old as usize, Ordering::SeqCst);
                }
            }
        }
    }

    pub fn opened() -> Vec<String> {
        OPENED.lock().map(|l| l.clone()).unwrap_or_default()
    }

    /// Path of the folder whose scope is open right now, if any.
    pub fn active_path() -> Option<String> {
        let url = ACTIVE_URL.load(Ordering::SeqCst) as *mut AnyObject;
        if url.is_null() {
            return None;
        }
        objc2::rc::autoreleasepool(|_| unsafe {
            let path: *mut AnyObject = msg_send![url, path];
            rust_string(path)
        })
    }

    /// Resolve a stored bookmark and reopen its scope: the folder's (possibly
    /// moved) path, plus a fresh bookmark when the old one went stale.
    pub fn restore(bookmark: &[u8]) -> Option<(String, Option<Vec<u8>>)> {
        objc2::rc::autoreleasepool(|_| unsafe {
            let data: *mut AnyObject = msg_send![AnyClass::get("NSData")?,
                dataWithBytes: bookmark.as_ptr() as *const c_void,
                length: bookmark.len()];
            let mut stale = Bool::NO;
            let mut err: *mut AnyObject = null_mut();
            let url: *mut AnyObject = msg_send![AnyClass::get("NSURL")?,
                URLByResolvingBookmarkData: data,
                options: 0usize,
                relativeToURL: null_mut::<AnyObject>(),
                bookmarkDataIsStale: &mut stale as *mut Bool,
                error: &mut err as *mut *mut AnyObject];
            if url.is_null() {
                return None;
            }
            let path = activate(url)?;
            let fresh = if stale.as_bool() { bookmark_of(url) } else { None };
            Some((path, fresh))
        })
    }
}

#[cfg(target_os = "ios")]
fn bookmark_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(BOOKMARK_FILE))
}

/// Show the system folder picker; the chosen folder's path, or None when
/// cancelled. Errors only when the picker could not be shown at all.
#[tauri::command]
pub async fn ios_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "ios")]
    {
        let rx = imp::arm();
        let (tx_ok, rx_ok) = tokio::sync::oneshot::channel::<bool>();
        app.run_on_main_thread(move || {
            let _ = tx_ok.send(unsafe { imp::present() });
        })
        .map_err(|e| e.to_string())?;
        if !rx_ok.await.unwrap_or(false) {
            return Err("folder picker unavailable".into());
        }
        let Some((path, bookmark)) = rx.await.ok().flatten() else {
            return Ok(None);
        };
        if !bookmark.is_empty() {
            let _ = std::fs::write(bookmark_path(&app)?, &bookmark);
        }
        Ok(Some(path))
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, BOOKMARK_FILE);
        Ok(None)
    }
}

/// At launch: reopen the folder picked last time. Its current path, or None
/// when nothing was picked or the folder is gone.
#[tauri::command]
pub fn ios_restore_folder(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "ios")]
    {
        // Launch already reopened it (setup); resolving the bookmark again and
        // swapping URLs would stop the first scope for nothing.
        if let Some(path) = imp::active_path() {
            return Ok(Some(path));
        }
        let file = bookmark_path(&app)?;
        let Ok(bytes) = std::fs::read(&file) else {
            return Ok(None);
        };
        match imp::restore(&bytes) {
            Some((path, fresh)) => {
                if let Some(b) = fresh {
                    let _ = std::fs::write(&file, b);
                }
                Ok(Some(path))
            }
            None => Ok(None),
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Ok(None)
    }
}

/// Wrap the app delegate's open-URL entry so in-place opens get their
/// security scope.
#[cfg(target_os = "ios")]
pub fn hook_open_url() {
    imp::hook_open_url();
}

/// Scene-lifecycle counterpart of [`hook_open_url`]: documents opened from
/// the Files app reach the scene delegate under the iOS 27 SDK. Must run
/// between `Builder::build` and `App::run`.
#[cfg(target_os = "ios")]
pub fn hook_scene_delegate() {
    imp::hook_scene_delegate();
}

/// Paths of documents opened in place from the Files app this session —
/// readable and writable in place (the app saves back to them instead of
/// making a copy).
#[tauri::command]
pub fn ios_scoped_files() -> Vec<String> {
    #[cfg(target_os = "ios")]
    {
        imp::opened()
    }
    #[cfg(not(target_os = "ios"))]
    {
        Vec::new()
    }
}
