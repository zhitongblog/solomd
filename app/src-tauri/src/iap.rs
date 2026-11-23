//! In-App Purchase (Tip Jar + Supporter Badge) bridge for macOS (MAS), iOS,
//! and Android (Google Play).
//!
//! Three one-time tip tiers:
//!   - `app.solomd.tip.coffee`  (Tier 1 — Coffee / 请喝杯咖啡)
//!   - `app.solomd.tip.meal`    (Tier 2 — Meal   / 请吃顿便饭)
//!   - `app.solomd.tip.feast`   (Tier 3 — Feast  / 超级支持)
//!
//! Purchasing any tier permanently unlocks the user's Supporter Badge
//! (`✨ Supporter / 支持者`) and upgrades its icon to the highest tier
//! purchased. Purchased product IDs are persisted in `NSUserDefaults` +
//! `NSUbiquitousKeyValueStore` on Apple platforms and `SharedPreferences` on
//! Android, in addition to native StoreKit / Google Play Billing restore.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[allow(dead_code)]
pub const TIP_PRODUCT_IDS: &[&str] = &[
    "app.solomd.tip.coffee",
    "app.solomd.tip.meal",
    "app.solomd.tip.feast",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IapProduct {
    pub product_id: String,
    pub title: String,
    pub description: String,
    pub formatted_price: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IapState {
    pub supported: bool,
    pub is_store_build: bool,
    pub purchased_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IapPurchaseResult {
    /// `"purchased"` | `"restored"` | `"cancelled"`
    pub status: String,
    pub product_id: String,
    pub purchased_ids: Vec<String>,
}

// ============================================================================
// Apple (macOS + iOS) — StoreKit (`SKProductsRequest` + `SKPaymentQueue`)
// ============================================================================
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use super::{IapProduct, IapPurchaseResult, TIP_PRODUCT_IDS};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, NSObject};
    use objc2::{declare_class, msg_send, msg_send_id, mutability, ClassType, DeclaredClass};
    use std::collections::HashMap;
    use std::ffi::{CStr, CString};
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{LazyLock, Mutex};
    use tokio::sync::oneshot;

    #[link(name = "StoreKit", kind = "framework")]
    extern "C" {}
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    const DEFAULTS_KEY: &str = "solomd.iap.purchased_ids";

    static DELEGATE_PTR: AtomicUsize = AtomicUsize::new(0);
    static OBSERVER_ADDED: AtomicBool = AtomicBool::new(false);

    /// Active `SKProductsRequest` retained until completion so ARC doesn't drop it.
    static ACTIVE_REQ: AtomicUsize = AtomicUsize::new(0);

    /// Cached `SKProduct*` pointers (retained) keyed by productIdentifier.
    static PRODUCT_CACHE: LazyLock<Mutex<HashMap<String, usize>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    static PENDING_FETCH: Mutex<Option<oneshot::Sender<Result<Vec<IapProduct>, String>>>> =
        Mutex::new(None);
    static PENDING_PURCHASE: Mutex<Option<oneshot::Sender<Result<IapPurchaseResult, String>>>> =
        Mutex::new(None);
    static PENDING_RESTORE: Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>> =
        Mutex::new(None);

    declare_class!(
        pub struct SoloMDIAPDelegate;

        unsafe impl ClassType for SoloMDIAPDelegate {
            type Super = NSObject;
            type Mutability = mutability::InteriorMutable;
            const NAME: &'static str = "SoloMDIAPDelegate";
        }

        impl DeclaredClass for SoloMDIAPDelegate {}

        unsafe impl SoloMDIAPDelegate {
            #[method(productsRequest:didReceiveResponse:)]
            fn did_receive_response(&self, _request: *mut AnyObject, response: *mut AnyObject) {
                unsafe { handle_products_response(response) };
            }

            #[method(request:didFailWithError:)]
            fn did_fail_with_error(&self, _request: *mut AnyObject, error: *mut AnyObject) {
                let msg = unsafe { error_description(error) }
                    .unwrap_or_else(|| "StoreKit product request failed".to_string());
                finish_fetch(Err(msg));
            }

            #[method(paymentQueue:updatedTransactions:)]
            fn updated_transactions(&self, queue: *mut AnyObject, transactions: *mut AnyObject) {
                unsafe { handle_updated_transactions(queue, transactions) };
            }

            #[method(paymentQueueRestoreCompletedTransactionsFinished:)]
            fn restore_finished(&self, _queue: *mut AnyObject) {
                let ids = unsafe { load_purchased_ids() };
                if let Some(tx) = PENDING_RESTORE.lock().ok().and_then(|mut p| p.take()) {
                    let _ = tx.send(Ok(ids));
                }
            }

            #[method(paymentQueue:restoreCompletedTransactionsFailedWithError:)]
            fn restore_failed(&self, _queue: *mut AnyObject, error: *mut AnyObject) {
                let msg = unsafe { error_description(error) }
                    .unwrap_or_else(|| "Restore failed".to_string());
                if let Some(tx) = PENDING_RESTORE.lock().ok().and_then(|mut p| p.take()) {
                    let _ = tx.send(Err(msg));
                }
            }
        }
    );

    impl SoloMDIAPDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send_id![super(this), init] }
        }
    }

    pub unsafe fn ensure_delegate() -> *mut AnyObject {
        let cur = DELEGATE_PTR.load(Ordering::Acquire);
        if cur != 0 {
            return cur as *mut AnyObject;
        }
        let d = SoloMDIAPDelegate::new();
        let ptr = Retained::into_raw(d) as *mut AnyObject;
        DELEGATE_PTR.store(ptr as usize, Ordering::Release);
        ptr
    }

    unsafe fn ensure_observer() {
        if OBSERVER_ADDED.swap(true, Ordering::AcqRel) {
            return;
        }
        let delegate = ensure_delegate();
        if let Some(q_cls) = AnyClass::get("SKPaymentQueue") {
            let queue: *mut AnyObject = msg_send![q_cls, defaultQueue];
            if !queue.is_null() {
                let _: () = msg_send![queue, addTransactionObserver: delegate];
            }
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

    unsafe fn error_description(err: *mut AnyObject) -> Option<String> {
        if err.is_null() {
            return None;
        }
        let desc: *mut AnyObject = msg_send![err, localizedDescription];
        rust_string(desc)
    }

    unsafe fn format_price(price: *mut AnyObject, locale: *mut AnyObject) -> String {
        if price.is_null() {
            return String::new();
        }
        let Some(fmt_cls) = AnyClass::get("NSNumberFormatter") else {
            return String::new();
        };
        let fmt: *mut AnyObject = msg_send![fmt_cls, new];
        if fmt.is_null() {
            return String::new();
        }
        // NSNumberFormatterCurrencyStyle = 2
        let _: () = msg_send![fmt, setNumberStyle: 2usize];
        if !locale.is_null() {
            let _: () = msg_send![fmt, setLocale: locale];
        }
        let s: *mut AnyObject = msg_send![fmt, stringFromNumber: price];
        let out = rust_string(s).unwrap_or_default();
        let _: () = msg_send![fmt, release];
        out
    }

    fn finish_fetch(res: Result<Vec<IapProduct>, String>) {
        let prev_req = ACTIVE_REQ.swap(0, Ordering::AcqRel);
        if prev_req != 0 {
            unsafe {
                let req = prev_req as *mut AnyObject;
                let _: () = msg_send![req, setDelegate: null_mut::<AnyObject>()];
                let _: () = msg_send![req, release];
            }
        }
        if let Some(tx) = PENDING_FETCH.lock().ok().and_then(|mut p| p.take()) {
            let _ = tx.send(res);
        }
    }

    unsafe fn handle_products_response(response: *mut AnyObject) {
        if response.is_null() {
            finish_fetch(Ok(Vec::new()));
            return;
        }
        let products: *mut AnyObject = msg_send![response, products];
        if products.is_null() {
            finish_fetch(Ok(Vec::new()));
            return;
        }
        let count: usize = msg_send![products, count];
        let mut list = Vec::with_capacity(count);
        for i in 0..count {
            let prod: *mut AnyObject = msg_send![products, objectAtIndex: i];
            if prod.is_null() {
                continue;
            }
            let pid_ns: *mut AnyObject = msg_send![prod, productIdentifier];
            let Some(product_id) = rust_string(pid_ns) else {
                continue;
            };
            let title_ns: *mut AnyObject = msg_send![prod, localizedTitle];
            let desc_ns: *mut AnyObject = msg_send![prod, localizedDescription];
            let price_ns: *mut AnyObject = msg_send![prod, price];
            let locale_ns: *mut AnyObject = msg_send![prod, priceLocale];

            let title = rust_string(title_ns).unwrap_or_default();
            let description = rust_string(desc_ns).unwrap_or_default();
            let formatted_price = format_price(price_ns, locale_ns);

            // Retain the SKProduct in PRODUCT_CACHE for subsequent purchase calls.
            let retained: *mut AnyObject = msg_send![prod, retain];
            if let Ok(mut cache) = PRODUCT_CACHE.lock() {
                if let Some(old) = cache.insert(product_id.clone(), retained as usize) {
                    let old_ptr = old as *mut AnyObject;
                    let _: () = msg_send![old_ptr, release];
                }
            }

            list.push(IapProduct {
                product_id,
                title,
                description,
                formatted_price,
            });
        }
        finish_fetch(Ok(list));
    }

    unsafe fn handle_updated_transactions(queue: *mut AnyObject, transactions: *mut AnyObject) {
        if transactions.is_null() {
            return;
        }
        let count: usize = msg_send![transactions, count];
        for i in 0..count {
            let tx: *mut AnyObject = msg_send![transactions, objectAtIndex: i];
            if tx.is_null() {
                continue;
            }
            // SKPaymentTransactionState:
            //   0 = Purchasing, 1 = Purchased, 2 = Failed, 3 = Restored, 4 = Deferred
            let state: isize = msg_send![tx, transactionState];
            let payment: *mut AnyObject = msg_send![tx, payment];
            let pid = if !payment.is_null() {
                let pid_ns: *mut AnyObject = msg_send![payment, productIdentifier];
                rust_string(pid_ns).unwrap_or_default()
            } else {
                String::new()
            };

            match state {
                1 | 3 => {
                    if !pid.is_empty() {
                        record_purchased_id(&pid);
                    }
                    if !queue.is_null() {
                        let _: () = msg_send![queue, finishTransaction: tx];
                    }
                    let purchased_ids = load_purchased_ids();
                    let status = if state == 3 { "restored" } else { "purchased" };
                    if let Some(sender) = PENDING_PURCHASE.lock().ok().and_then(|mut p| p.take()) {
                        let _ = sender.send(Ok(IapPurchaseResult {
                            status: status.to_string(),
                            product_id: pid,
                            purchased_ids,
                        }));
                    }
                }
                2 => {
                    let err: *mut AnyObject = msg_send![tx, error];
                    // SKErrorPaymentCancelled = 2
                    let code: isize = if !err.is_null() {
                        msg_send![err, code]
                    } else {
                        0
                    };
                    let err_msg = error_description(err)
                        .unwrap_or_else(|| "Purchase failed".to_string());
                    if !queue.is_null() {
                        let _: () = msg_send![queue, finishTransaction: tx];
                    }
                    if let Some(sender) = PENDING_PURCHASE.lock().ok().and_then(|mut p| p.take()) {
                        if code == 2 {
                            let _ = sender.send(Ok(IapPurchaseResult {
                                status: "cancelled".to_string(),
                                product_id: pid,
                                purchased_ids: load_purchased_ids(),
                            }));
                        } else {
                            let _ = sender.send(Err(err_msg));
                        }
                    }
                }
                _ => {
                    // 0 = Purchasing, 4 = Deferred — keep waiting.
                }
            }
        }
    }

    pub unsafe fn load_purchased_ids() -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let key = ns_string(DEFAULTS_KEY);

        // Read from NSUserDefaults
        if let Some(ud_cls) = AnyClass::get("NSUserDefaults") {
            let ud: *mut AnyObject = msg_send![ud_cls, standardUserDefaults];
            if !ud.is_null() {
                let arr: *mut AnyObject = msg_send![ud, stringArrayForKey: key];
                if !arr.is_null() {
                    let count: usize = msg_send![arr, count];
                    for i in 0..count {
                        let s: *mut AnyObject = msg_send![arr, objectAtIndex: i];
                        if let Some(val) = rust_string(s) {
                            if !out.contains(&val) {
                                out.push(val);
                            }
                        }
                    }
                }
            }
        }

        // Also check NSUbiquitousKeyValueStore (iCloud key-value sync when available)
        if let Some(kv_cls) = AnyClass::get("NSUbiquitousKeyValueStore") {
            let kv: *mut AnyObject = msg_send![kv_cls, defaultStore];
            if !kv.is_null() {
                let arr: *mut AnyObject = msg_send![kv, arrayForKey: key];
                if !arr.is_null() {
                    let count: usize = msg_send![arr, count];
                    for i in 0..count {
                        let s: *mut AnyObject = msg_send![arr, objectAtIndex: i];
                        if let Some(val) = rust_string(s) {
                            if !out.contains(&val) {
                                out.push(val);
                            }
                        }
                    }
                }
            }
        }

        out
    }

    pub unsafe fn record_purchased_id(product_id: &str) {
        let mut ids = load_purchased_ids();
        if !ids.iter().any(|x| x == product_id) {
            ids.push(product_id.to_string());
        }
        let Some(arr_cls) = AnyClass::get("NSMutableArray") else {
            return;
        };
        let arr: *mut AnyObject = msg_send![arr_cls, arrayWithCapacity: ids.len()];
        for id in &ids {
            let ns = ns_string(id);
            let _: () = msg_send![arr, addObject: ns];
        }
        let key = ns_string(DEFAULTS_KEY);
        if let Some(ud_cls) = AnyClass::get("NSUserDefaults") {
            let ud: *mut AnyObject = msg_send![ud_cls, standardUserDefaults];
            if !ud.is_null() {
                let _: () = msg_send![ud, setObject: arr, forKey: key];
            }
        }
        if let Some(kv_cls) = AnyClass::get("NSUbiquitousKeyValueStore") {
            let kv: *mut AnyObject = msg_send![kv_cls, defaultStore];
            if !kv.is_null() {
                let _: () = msg_send![kv, setArray: arr, forKey: key];
            }
        }
    }

    pub async fn fetch_products(
        app: & tauri::AppHandle,
        product_ids: Vec<String>,
    ) -> Result<Vec<IapProduct>, String> {
        let ids = if product_ids.is_empty() {
            TIP_PRODUCT_IDS.iter().map(|s| (*s).to_string()).collect()
        } else {
            product_ids
        };

        let (tx, rx) = oneshot::channel();
        {
            let mut slot = PENDING_FETCH.lock().map_err(|e| e.to_string())?;
            *slot = Some(tx);
        }

        app.run_on_main_thread(move || unsafe {
            ensure_observer();
            let (Some(arr_cls), Some(set_cls), Some(req_cls)) = (
                AnyClass::get("NSMutableArray"),
                AnyClass::get("NSSet"),
                AnyClass::get("SKProductsRequest"),
            ) else {
                finish_fetch(Err("StoreKit classes unavailable".to_string()));
                return;
            };
            let arr: *mut AnyObject = msg_send![arr_cls, arrayWithCapacity: ids.len()];
            for id in &ids {
                let s = ns_string(id);
                let _: () = msg_send![arr, addObject: s];
            }
            let set: *mut AnyObject = msg_send![set_cls, setWithArray: arr];
            let alloc: *mut AnyObject = msg_send![req_cls, alloc];
            let req: *mut AnyObject = msg_send![alloc, initWithProductIdentifiers: set];
            if req.is_null() {
                finish_fetch(Err("Failed to create SKProductsRequest".to_string()));
                return;
            }
            let delegate = ensure_delegate();
            let _: () = msg_send![req, setDelegate: delegate];
            let old = ACTIVE_REQ.swap(req as usize, Ordering::AcqRel);
            if old != 0 {
                let old_req = old as *mut AnyObject;
                let _: () = msg_send![old_req, cancel];
                let _: () = msg_send![old_req, release];
            }
            let _: () = msg_send![req, start];
        })
        .map_err(|e| e.to_string())?;

        match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("StoreKit request cancelled".to_string()),
            Err(_) => {
                finish_fetch(Err("StoreKit request timed out".to_string()));
                Err("StoreKit request timed out".to_string())
            }
        }
    }

    pub async fn purchase(
        app: &tauri::AppHandle,
        product_id: String,
    ) -> Result<IapPurchaseResult, String> {
        // Ensure we have the SKProduct cached first.
        let cached = PRODUCT_CACHE
            .lock()
            .ok()
            .and_then(|c| c.get(&product_id).copied())
            .unwrap_or(0);
        if cached == 0 {
            let _ = fetch_products(app, vec![product_id.clone()]).await;
        }
        let prod_ptr = PRODUCT_CACHE
            .lock()
            .ok()
            .and_then(|c| c.get(&product_id).copied())
            .unwrap_or(0);
        if prod_ptr == 0 {
            return Err(format!(
                "Product '{}' is not yet available in App Store Connect.",
                product_id
            ));
        }

        let (tx, rx) = oneshot::channel();
        {
            let mut slot = PENDING_PURCHASE.lock().map_err(|e| e.to_string())?;
            *slot = Some(tx);
        }

        app.run_on_main_thread(move || unsafe {
            ensure_observer();
            let (Some(q_cls), Some(pay_cls)) = (
                AnyClass::get("SKPaymentQueue"),
                AnyClass::get("SKPayment"),
            ) else {
                if let Some(s) = PENDING_PURCHASE.lock().ok().and_then(|mut p| p.take()) {
                    let _ = s.send(Err("StoreKit unavailable".to_string()));
                }
                return;
            };
            let queue: *mut AnyObject = msg_send![q_cls, defaultQueue];
            let can_pay: objc2::runtime::Bool = msg_send![q_cls, canMakePayments];
            if !can_pay.as_bool() {
                if let Some(s) = PENDING_PURCHASE.lock().ok().and_then(|mut p| p.take()) {
                    let _ = s.send(Err(
                        "In-App Purchases are disabled on this device.".to_string(),
                    ));
                }
                return;
            }
            let prod = prod_ptr as *mut AnyObject;
            let payment: *mut AnyObject = msg_send![pay_cls, paymentWithProduct: prod];
            if payment.is_null() || queue.is_null() {
                if let Some(s) = PENDING_PURCHASE.lock().ok().and_then(|mut p| p.take()) {
                    let _ = s.send(Err("Failed to create SKPayment".to_string()));
                }
                return;
            }
            let _: () = msg_send![queue, addPayment: payment];
        })
        .map_err(|e| e.to_string())?;

        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Purchase cancelled".to_string()),
            Err(_) => {
                let _ = PENDING_PURCHASE.lock().ok().and_then(|mut p| p.take());
                Err("Purchase timed out".to_string())
            }
        }
    }

    pub async fn restore(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut slot = PENDING_RESTORE.lock().map_err(|e| e.to_string())?;
            *slot = Some(tx);
        }

        app.run_on_main_thread(move || unsafe {
            ensure_observer();
            if let Some(q_cls) = AnyClass::get("SKPaymentQueue") {
                let queue: *mut AnyObject = msg_send![q_cls, defaultQueue];
                if !queue.is_null() {
                    let _: () = msg_send![queue, restoreCompletedTransactions];
                    return;
                }
            }
            if let Some(s) = PENDING_RESTORE.lock().ok().and_then(|mut p| p.take()) {
                let _ = s.send(Ok(load_purchased_ids()));
            }
        })
        .map_err(|e| e.to_string())?;

        match tokio::time::timeout(std::time::Duration::from_secs(20), rx).await {
            Ok(Ok(res)) => res,
            _ => Ok(unsafe { load_purchased_ids() }),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use objc2::sel;

        #[test]
        fn storekit_delegate_responds_to_all_selectors() {
            unsafe {
                let d = ensure_delegate();
                assert!(!d.is_null());
                let r1: objc2::runtime::Bool =
                    msg_send![d, respondsToSelector: sel!(productsRequest:didReceiveResponse:)];
                let r2: objc2::runtime::Bool =
                    msg_send![d, respondsToSelector: sel!(request:didFailWithError:)];
                let r3: objc2::runtime::Bool =
                    msg_send![d, respondsToSelector: sel!(paymentQueue:updatedTransactions:)];
                let r4: objc2::runtime::Bool = msg_send![
                    d,
                    respondsToSelector: sel!(paymentQueueRestoreCompletedTransactionsFinished:)
                ];
                assert!(r1.as_bool());
                assert!(r2.as_bool());
                assert!(r3.as_bool());
                assert!(r4.as_bool());
            }
        }
    }
}

// ============================================================================
// Android — Google Play Billing via MainActivity JNI
// ============================================================================
#[cfg(target_os = "android")]
mod android {
    use super::{IapProduct, IapPurchaseResult, TIP_PRODUCT_IDS};
    use jni::objects::{JObject, JString, JValue};
    use jni::JavaVM;

    fn with_env<T>(f: impl FnOnce(&mut jni::JNIEnv) -> Result<T, String>) -> Result<T, String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        f(&mut env)
    }

    fn call_static_str(method: &str, arg: Option<&str>) -> Result<String, String> {
        with_env(|env| {
            let act_obj = unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) };
            let cls = env.get_object_class(&act_obj).map_err(|e| e.to_string())?;
            let val = if let Some(s) = arg {
                let jarg = env.new_string(s).map_err(|e| e.to_string())?;
                env.call_static_method(
                    cls,
                    method,
                    "(Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(&jarg)],
                )
            } else {
                env.call_static_method(cls, method, "()Ljava/lang/String;", &[])
            };
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_clear();
                return Err(format!("JNI exception in MainActivity.{method}"));
            }
            let obj = val.map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
            if obj.is_null() {
                return Ok(String::new());
            }
            let jstr = JString::from(obj);
            let rust_str: String = env.get_string(&jstr).map_err(|e| e.to_string())?.into();
            Ok(rust_str)
        })
    }

    pub fn load_purchased_ids() -> Vec<String> {
        let raw = call_static_str("iapGetPurchased", None).unwrap_or_default();
        serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
    }

    pub async fn fetch_products(product_ids: Vec<String>) -> Result<Vec<IapProduct>, String> {
        let ids: Vec<String> = if product_ids.is_empty() {
            TIP_PRODUCT_IDS.iter().map(|s| (*s).to_string()).collect()
        } else {
            product_ids
        };
        let ids_json = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string());
        let _ = call_static_str("iapStartFetchProducts", Some(&ids_json))?;
        for _ in 0..60 {
            let polled = call_static_str("iapPollProducts", None)?;
            if !polled.is_empty() {
                return serde_json::from_str::<Vec<IapProduct>>(&polled)
                    .map_err(|e| e.to_string());
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        Ok(Vec::new())
    }

    pub async fn purchase(product_id: String) -> Result<IapPurchaseResult, String> {
        let _ = call_static_str("iapStartPurchase", Some(&product_id))?;
        for _ in 0..600 {
            let polled = call_static_str("iapPollPurchase", None)?;
            if !polled.is_empty() {
                let val: serde_json::Value =
                    serde_json::from_str(&polled).map_err(|e| e.to_string())?;
                if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
                    return Err(err.to_string());
                }
                let status = val
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("cancelled")
                    .to_string();
                return Ok(IapPurchaseResult {
                    status,
                    product_id,
                    purchased_ids: load_purchased_ids(),
                });
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        Err("Google Play purchase timed out".to_string())
    }

    pub async fn restore() -> Result<Vec<String>, String> {
        let _ = call_static_str("iapStartRestore", None)?;
        for _ in 0..50 {
            let polled = call_static_str("iapPollRestore", None)?;
            if !polled.is_empty() {
                return serde_json::from_str::<Vec<String>>(&polled)
                    .map_err(|e| e.to_string());
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        Ok(load_purchased_ids())
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub fn iap_get_state() -> Result<IapState, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let purchased_ids = unsafe { apple::load_purchased_ids() };
        return Ok(IapState {
            supported: true,
            is_store_build: super::app_build::IS_APP_STORE || cfg!(target_os = "ios"),
            purchased_ids,
        });
    }
    #[cfg(target_os = "android")]
    {
        let purchased_ids = android::load_purchased_ids();
        return Ok(IapState {
            supported: true,
            is_store_build: true,
            purchased_ids,
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        Ok(IapState {
            supported: false,
            is_store_build: false,
            purchased_ids: Vec::new(),
        })
    }
}

#[tauri::command]
pub async fn iap_fetch_products(
    app: AppHandle,
    product_ids: Option<Vec<String>>,
) -> Result<Vec<IapProduct>, String> {
    let ids = product_ids.unwrap_or_default();
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return apple::fetch_products(&app, ids).await;
    }
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return android::fetch_products(ids).await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        let _ = (app, ids);
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn iap_purchase(
    app: AppHandle,
    product_id: String,
) -> Result<IapPurchaseResult, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return apple::purchase(&app, product_id).await;
    }
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return android::purchase(product_id).await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        let _ = (app, product_id);
        Err("In-App Purchase is only available on macOS, iOS, and Android.".to_string())
    }
}

#[tauri::command]
pub async fn iap_restore(app: AppHandle) -> Result<Vec<String>, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return apple::restore(&app).await;
    }
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return android::restore().await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}
