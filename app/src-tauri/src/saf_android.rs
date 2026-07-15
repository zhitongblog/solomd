//! #148 (Magic OS follow-up) — Storage Access Framework (SAF) folder access.
//!
//! On some OEM ROMs (Honor/Huawei Magic OS) MANAGE_EXTERNAL_STORAGE grants
//! nothing: `isExternalStorageManager()` is true but `std::fs` on
//! `/storage/emulated/0` still hits EACCES even after a restart. SAF is the
//! universal, permission-free path — the user picks a folder in the system
//! dialog and we read/write it via ContentResolver.
//!
//! The heavy ContentResolver/cursor/stream work lives in Kotlin
//! (`MainActivity`, force-committed) as @JvmStatic string-in/string-out
//! methods; this module is a thin JNI bridge that calls them. Data methods
//! return a JSON envelope `{"ok":true,"v":…}` / `{"ok":false,"e":"msg"}` so we
//! never juggle Java exceptions across the boundary. Off-Android everything is
//! a stub (SAF is Android-only; desktop uses ordinary paths).

use serde::{Deserialize, Serialize};

/// One child entry from a SAF folder listing.
#[derive(Serialize, Deserialize, Clone)]
pub struct SafEntry {
    pub name: String,
    #[serde(rename = "docId")]
    pub doc_id: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
}

/// Launch the system folder picker (ACTION_OPEN_DOCUMENT_TREE). Fire-and-forget;
/// the frontend polls `saf_poll_picked` for the result.
#[tauri::command]
pub fn saf_pick_folder() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        imp::pick_folder()
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("SAF is Android-only".into())
    }
}

/// Poll for the picker result: `None` = still open / not launched, `Some("")`
/// = user cancelled, `Some(uri)` = a granted tree URI.
#[tauri::command]
pub fn saf_poll_picked() -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        imp::poll_picked()
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(None)
    }
}

/// Tree URIs we still hold a persisted (survives-restart) grant for.
#[tauri::command]
pub fn saf_persisted_trees() -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    {
        imp::persisted_trees()
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(vec![])
    }
}

/// Root documentId for a tree URI (the folder the user picked).
#[tauri::command]
pub fn saf_tree_root(tree_uri: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        imp::tree_root(&tree_uri)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = tree_uri;
        Err("SAF is Android-only".into())
    }
}

/// Human-readable name of a document (used for the workspace folder label).
#[tauri::command]
pub fn saf_tree_name(tree_uri: String, doc_id: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        imp::tree_name(&tree_uri, &doc_id)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (tree_uri, doc_id);
        Err("SAF is Android-only".into())
    }
}

/// List the children of (tree_uri, doc_id).
#[tauri::command]
pub fn saf_list(tree_uri: String, doc_id: String) -> Result<Vec<SafEntry>, String> {
    #[cfg(target_os = "android")]
    {
        imp::list(&tree_uri, &doc_id)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (tree_uri, doc_id);
        Err("SAF is Android-only".into())
    }
}

/// Read a document as UTF-8 text.
#[tauri::command]
pub fn saf_read(tree_uri: String, doc_id: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        imp::read(&tree_uri, &doc_id)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (tree_uri, doc_id);
        Err("SAF is Android-only".into())
    }
}

/// Overwrite a document with UTF-8 text.
#[tauri::command]
pub fn saf_write(tree_uri: String, doc_id: String, content: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        imp::write(&tree_uri, &doc_id, &content)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (tree_uri, doc_id, content);
        Err("SAF is Android-only".into())
    }
}

/// Create a new document under `parent_doc_id`; returns the new documentId.
#[tauri::command]
pub fn saf_create(
    tree_uri: String,
    parent_doc_id: String,
    mime: String,
    name: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        imp::create(&tree_uri, &parent_doc_id, &mime, &name)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (tree_uri, parent_doc_id, mime, name);
        Err("SAF is Android-only".into())
    }
}

/// Delete a document (file or empty directory).
#[tauri::command]
pub fn saf_delete(tree_uri: String, doc_id: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        imp::delete(&tree_uri, &doc_id)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (tree_uri, doc_id);
        Err("SAF is Android-only".into())
    }
}

#[cfg(target_os = "android")]
mod imp {
    use super::SafEntry;
    use jni::objects::{JObject, JString, JValue};
    use jni::JavaVM;

    const CLS: &str = "app/solomd/MainActivity";

    fn with_env<T>(f: impl FnOnce(&mut jni::JNIEnv) -> Result<T, String>) -> Result<T, String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        f(&mut env)
    }

    fn check_exc(env: &mut jni::JNIEnv, what: &str) -> Result<(), String> {
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Err(format!("java exception in {what}"));
        }
        Ok(())
    }

    /// Call a static method returning a (nullable) java.lang.String.
    fn call_str_opt(
        method: &str,
        sig: &str,
        args: &[JValue],
    ) -> Result<Option<String>, String> {
        with_env(|env| {
            let res = env.call_static_method(CLS, method, sig, args);
            check_exc(env, method)?;
            let obj = res.map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
            if obj.is_null() {
                return Ok(None);
            }
            let s: String = env
                .get_string(&JString::from(obj))
                .map_err(|e| e.to_string())?
                .into();
            Ok(Some(s))
        })
    }

    /// Call a static method whose java.lang.String result must be non-null.
    fn call_str(method: &str, sig: &str, args: &[JValue]) -> Result<String, String> {
        call_str_opt(method, sig, args)?.ok_or_else(|| format!("{method} returned null"))
    }

    /// Parse the `{"ok":…}` envelope, returning the `v` value or the error.
    fn unwrap_env(json: &str) -> Result<serde_json::Value, String> {
        let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
            Ok(v.get("v").cloned().unwrap_or(serde_json::Value::Null))
        } else {
            Err(v
                .get("e")
                .and_then(|e| e.as_str())
                .unwrap_or("SAF error")
                .to_string())
        }
    }

    fn jstr<'a>(env: &mut jni::JNIEnv<'a>, s: &str) -> Result<JObject<'a>, String> {
        env.new_string(s).map(Into::into).map_err(|e| e.to_string())
    }

    pub fn pick_folder() -> Result<(), String> {
        with_env(|env| {
            env.call_static_method(CLS, "launchFolderPicker", "()V", &[])
                .map_err(|e| e.to_string())?;
            check_exc(env, "launchFolderPicker")
        })
    }

    pub fn poll_picked() -> Result<Option<String>, String> {
        call_str_opt("pollPicked", "()Ljava/lang/String;", &[])
    }

    pub fn persisted_trees() -> Result<Vec<String>, String> {
        let json = call_str("persistedTrees", "()Ljava/lang/String;", &[])?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }

    pub fn tree_root(tree: &str) -> Result<String, String> {
        with_env(|env| {
            let a = jstr(env, tree)?;
            let json = call_str(
                "treeRootDocId",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&a)],
            )?;
            unwrap_env(&json)?
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "treeRootDocId: not a string".into())
        })
    }

    pub fn tree_name(tree: &str, doc: &str) -> Result<String, String> {
        with_env(|env| {
            let a = jstr(env, tree)?;
            let b = jstr(env, doc)?;
            let json = call_str(
                "treeDisplayName",
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&a), JValue::Object(&b)],
            )?;
            unwrap_env(&json)?
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "treeDisplayName: not a string".into())
        })
    }

    pub fn list(tree: &str, doc: &str) -> Result<Vec<SafEntry>, String> {
        with_env(|env| {
            let a = jstr(env, tree)?;
            let b = jstr(env, doc)?;
            let json = call_str(
                "list",
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&a), JValue::Object(&b)],
            )?;
            let arr = unwrap_env(&json)?;
            serde_json::from_value(arr).map_err(|e| e.to_string())
        })
    }

    pub fn read(tree: &str, doc: &str) -> Result<String, String> {
        with_env(|env| {
            let a = jstr(env, tree)?;
            let b = jstr(env, doc)?;
            let json = call_str(
                "readText",
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&a), JValue::Object(&b)],
            )?;
            unwrap_env(&json)?
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "readText: not a string".into())
        })
    }

    pub fn write(tree: &str, doc: &str, content: &str) -> Result<(), String> {
        with_env(|env| {
            let a = jstr(env, tree)?;
            let b = jstr(env, doc)?;
            let c = jstr(env, content)?;
            let json = call_str(
                "writeText",
                "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&a), JValue::Object(&b), JValue::Object(&c)],
            )?;
            unwrap_env(&json).map(|_| ())
        })
    }

    pub fn create(tree: &str, parent: &str, mime: &str, name: &str) -> Result<String, String> {
        with_env(|env| {
            let a = jstr(env, tree)?;
            let b = jstr(env, parent)?;
            let c = jstr(env, mime)?;
            let d = jstr(env, name)?;
            let json = call_str(
                "createDoc",
                "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[
                    JValue::Object(&a),
                    JValue::Object(&b),
                    JValue::Object(&c),
                    JValue::Object(&d),
                ],
            )?;
            unwrap_env(&json)?
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "createDoc: not a string".into())
        })
    }

    pub fn delete(tree: &str, doc: &str) -> Result<(), String> {
        with_env(|env| {
            let a = jstr(env, tree)?;
            let b = jstr(env, doc)?;
            let json = call_str(
                "deleteDoc",
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&a), JValue::Object(&b)],
            )?;
            unwrap_env(&json).map(|_| ())
        })
    }
}
