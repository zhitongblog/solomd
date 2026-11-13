package app.solomd

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.util.Base64
import androidx.activity.enableEdgeToEdge
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/**
 * #148 (Magic OS follow-up) — Storage Access Framework (SAF) folder access.
 *
 * MANAGE_EXTERNAL_STORAGE grants nothing on some OEM ROMs (Honor/Huawei Magic
 * OS): `Environment.isExternalStorageManager()` returns true but `std::fs` on
 * `/storage/emulated/0` still hits EACCES, and a restart doesn't help. SAF is
 * the Google-sanctioned mechanism that works everywhere without any special
 * permission: the user picks a folder in the system dialog, we take a
 * *persistable* URI permission, and read/write via ContentResolver.
 *
 * SAF's `ACTION_OPEN_DOCUMENT_TREE` result only arrives in `onActivityResult`,
 * which must live in the Activity — so the bridge is here. The heavier
 * ContentResolver/cursor/stream work also lives here (clean Kotlin) and is
 * exposed as @JvmStatic string-in/string-out methods that committed Rust calls
 * via JNI (see saf_android.rs). The app Kotlin tree is gitignored; this file is
 * force-committed, same as the tracked AndroidManifest.xml.
 *
 * Document model: a SAF "tree URI" authorizes a folder subtree. Every file/dir
 * inside is addressed by (treeUri, documentId). We keep treeUri constant and
 * pass documentIds to navigate. All data methods return a JSON envelope
 * {"ok":true,...} / {"ok":false,"e":"msg"} so Rust never has to juggle Java
 * exceptions.
 */
class MainActivity : TauriActivity() {
  companion object {
    const val REQ_PICK_TREE = 0x5AF0
    private const val DIR_MIME = DocumentsContract.Document.MIME_TYPE_DIR
    private const val IAP_PREFS = "solomd_iap"
    private const val IAP_PREFS_KEY = "purchased_ids"

    @JvmStatic
    private var instance: MainActivity? = null

    // Set by onActivityResult, drained by pollPicked(): null = no result yet,
    // "" = cancelled, "content://…" = granted tree URI.
    @JvmStatic
    private val pickedTreeUri = AtomicReference<String?>(null)

    // Google Play Billing state for Tip Jar + Supporter Badge
    private var billingClient: BillingClient? = null
    private val productCache = ConcurrentHashMap<String, ProductDetails>()
    private val iapProductsPoll = AtomicReference<String>("")
    private val iapPurchasePoll = AtomicReference<String>("")
    private val iapRestorePoll = AtomicReference<String>("")

    private val purchasesListener = PurchasesUpdatedListener { result, purchases ->
      when (result.responseCode) {
        BillingClient.BillingResponseCode.OK -> {
          if (!purchases.isNullOrEmpty()) {
            for (p in purchases) {
              handlePlayPurchase(p)
            }
          } else {
            iapPurchasePoll.set(JSONObject().put("status", "cancelled").toString())
          }
        }
        BillingClient.BillingResponseCode.USER_CANCELED -> {
          iapPurchasePoll.set(JSONObject().put("status", "cancelled").toString())
        }
        else -> {
          iapPurchasePoll.set(
            JSONObject()
              .put("error", result.debugMessage.ifEmpty { "Google Play Billing error (${result.responseCode})" })
              .toString()
          )
        }
      }
    }

    private fun handlePlayPurchase(purchase: Purchase) {
      if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) return
      for (pid in purchase.products) {
        recordPurchasedId(pid)
      }
      val client = billingClient
      if (client != null && client.isReady) {
        // Consume so the user can tip again if they wish, while our prefs +
        // supporter badge stay permanently unlocked.
        val consumeParams = ConsumeParams.newBuilder()
          .setPurchaseToken(purchase.purchaseToken)
          .build()
        client.consumeAsync(consumeParams) { _, _ -> }
        if (!purchase.isAcknowledged) {
          val ackParams = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchase.purchaseToken)
            .build()
          client.acknowledgePurchase(ackParams) { _ -> }
        }
      }
      iapPurchasePoll.set(JSONObject().put("status", "purchased").toString())
    }

    private fun withBilling(onReady: (BillingClient) -> Unit, onFail: (String) -> Unit) {
      val act = instance
      if (act == null) {
        onFail("Activity unavailable")
        return
      }
      val existing = billingClient
      if (existing != null && existing.isReady) {
        onReady(existing)
        return
      }
      val client = BillingClient.newBuilder(act.applicationContext)
        .setListener(purchasesListener)
        .enablePendingPurchases(
          PendingPurchasesParams.newBuilder().enableOneTimeProducts().build()
        )
        .build()
      billingClient = client
      client.startConnection(object : BillingClientStateListener {
        override fun onBillingSetupFinished(result: BillingResult) {
          if (result.responseCode == BillingClient.BillingResponseCode.OK) {
            onReady(client)
          } else {
            onFail(result.debugMessage.ifEmpty { "Play Billing unavailable (${result.responseCode})" })
          }
        }
        override fun onBillingServiceDisconnected() {}
      })
    }

    private fun recordPurchasedId(productId: String) {
      val act = instance ?: return
      val prefs = act.getSharedPreferences(IAP_PREFS, Context.MODE_PRIVATE)
      val set = prefs.getStringSet(IAP_PREFS_KEY, emptySet())?.toMutableSet() ?: mutableSetOf()
      set.add(productId)
      prefs.edit().putStringSet(IAP_PREFS_KEY, set).apply()
    }

    @JvmStatic
    fun iapGetPurchased(): String {
      val act = instance ?: return "[]"
      val prefs = act.getSharedPreferences(IAP_PREFS, Context.MODE_PRIVATE)
      val set = prefs.getStringSet(IAP_PREFS_KEY, emptySet()) ?: emptySet()
      val arr = JSONArray()
      set.forEach { arr.put(it) }
      return arr.toString()
    }

    @JvmStatic
    fun iapStartFetchProducts(idsJson: String): String {
      iapProductsPoll.set("")
      val ids = try {
        val ja = JSONArray(idsJson)
        (0 until ja.length()).map { ja.getString(it) }
      } catch (_: Exception) {
        listOf("app.solomd.tip.coffee", "app.solomd.tip.meal", "app.solomd.tip.feast")
      }
      withBilling(
        onReady = { client ->
          val productList = ids.map { id ->
            QueryProductDetailsParams.Product.newBuilder()
              .setProductId(id)
              .setProductType(BillingClient.ProductType.INAPP)
              .build()
          }
          val params = QueryProductDetailsParams.newBuilder()
            .setProductList(productList)
            .build()
          client.queryProductDetailsAsync(params) { _, detailsResult ->
            val out = JSONArray()
            for (d in detailsResult.productDetailsList) {
              productCache[d.productId] = d
              val price = d.oneTimePurchaseOfferDetails?.formattedPrice ?: ""
              out.put(
                JSONObject().apply {
                  put("productId", d.productId)
                  put("title", d.name)
                  put("description", d.description)
                  put("formattedPrice", price)
                }
              )
            }
            iapProductsPoll.set(out.toString())
          }
        },
        onFail = { _ -> iapProductsPoll.set("[]") }
      )
      return "ok"
    }

    @JvmStatic
    fun iapPollProducts(): String = iapProductsPoll.getAndSet("")

    @JvmStatic
    fun iapStartPurchase(productId: String): String {
      iapPurchasePoll.set("")
      val act = instance ?: return "no_activity"
      withBilling(
        onReady = { client ->
          val launchWith = { details: ProductDetails ->
            act.runOnUiThread {
              val productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(details)
                .build()
              val flowParams = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(productParams))
                .build()
              val res = client.launchBillingFlow(act, flowParams)
              if (res.responseCode != BillingClient.BillingResponseCode.OK) {
                iapPurchasePoll.set(
                  JSONObject()
                    .put("error", res.debugMessage.ifEmpty { "Failed to launch billing flow" })
                    .toString()
                )
              }
            }
          }
          val cached = productCache[productId]
          if (cached != null) {
            launchWith(cached)
          } else {
            val qParams = QueryProductDetailsParams.newBuilder()
              .setProductList(
                listOf(
                  QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(productId)
                    .setProductType(BillingClient.ProductType.INAPP)
                    .build()
                )
              )
              .build()
            client.queryProductDetailsAsync(qParams) { _, detailsResult ->
              val found = detailsResult.productDetailsList.firstOrNull()
              if (found != null) {
                productCache[found.productId] = found
                launchWith(found)
              } else {
                iapPurchasePoll.set(
                  JSONObject()
                    .put("error", "Product '$productId' not found in Google Play Console.")
                    .toString()
                )
              }
            }
          }
        },
        onFail = { msg ->
          iapPurchasePoll.set(JSONObject().put("error", msg).toString())
        }
      )
      return "ok"
    }

    @JvmStatic
    fun iapPollPurchase(): String = iapPurchasePoll.getAndSet("")

    @JvmStatic
    fun iapStartRestore(): String {
      iapRestorePoll.set("")
      withBilling(
        onReady = { client ->
          val params = QueryPurchasesParams.newBuilder()
            .setProductType(BillingClient.ProductType.INAPP)
            .build()
          client.queryPurchasesAsync(params) { _, purchases ->
            for (p in purchases) {
              if (p.purchaseState == Purchase.PurchaseState.PURCHASED) {
                for (pid in p.products) {
                  recordPurchasedId(pid)
                }
              }
            }
            iapRestorePoll.set(iapGetPurchased())
          }
        },
        onFail = { _ -> iapRestorePoll.set(iapGetPurchased()) }
      )
      return "ok"
    }

    @JvmStatic
    fun iapPollRestore(): String = iapRestorePoll.getAndSet("")

    private fun resolver() = instance?.contentResolver

    /** Launch the system folder picker. Clears any stale result first. */
    @JvmStatic
    fun launchFolderPicker() {
      val act = instance ?: return
      pickedTreeUri.set(null)
      act.runOnUiThread {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
          addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
              Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
              Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
          )
        }
        try {
          act.startActivityForResult(intent, REQ_PICK_TREE)
        } catch (e: Exception) {
          pickedTreeUri.set("") // no picker available → treat as cancel
        }
      }
    }

    /** Rust polls this after launching; returns+clears the result. */
    @JvmStatic
    fun pollPicked(): String? = pickedTreeUri.getAndSet(null)

    /** JSON array of tree URIs we still hold a persisted grant for. */
    @JvmStatic
    fun persistedTrees(): String {
      val arr = JSONArray()
      resolver()?.persistedUriPermissions?.forEach { p ->
        if (p.isReadPermission) arr.put(p.uri.toString())
      }
      return arr.toString()
    }

    /** Root documentId for a tree URI (the folder the user picked). */
    @JvmStatic
    fun treeRootDocId(treeUri: String): String { return try {
      envelope { put("v", DocumentsContract.getTreeDocumentId(Uri.parse(treeUri))) }
    } catch (e: Exception) { err(e) } }

    /** Display name of the tree root (for the folder label in the UI). */
    @JvmStatic
    fun treeDisplayName(treeUri: String, docId: String): String { return try {
      val uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUri), docId)
      val r = resolver() ?: return err2("no resolver")
      var name = docId.substringAfterLast('/').substringAfterLast(':')
      r.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
        ?.use { c -> if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0) }
      envelope { put("v", name) }
    } catch (e: Exception) { err(e) } }

    /** List child docs of (treeUri, docId). JSON: [{name,docId,isDir}]. */
    @JvmStatic
    fun list(treeUri: String, docId: String): String { return try {
      val tree = Uri.parse(treeUri)
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
      val r = resolver() ?: return err2("no resolver")
      val items = JSONArray()
      r.query(
        children,
        arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE
        ),
        null, null, null
      )?.use { c ->
        while (c.moveToNext()) {
          val cid = c.getString(0)
          val name = if (c.isNull(1)) cid.substringAfterLast('/') else c.getString(1)
          val mime = if (c.isNull(2)) "" else c.getString(2)
          items.put(JSONObject().apply {
            put("name", name); put("docId", cid); put("isDir", mime == DIR_MIME)
          })
        }
      }
      envelope { put("v", items) }
    } catch (e: Exception) { err(e) } }

    /** Read a document as UTF-8 text. */
    @JvmStatic
    fun readText(treeUri: String, docId: String): String { return try {
      val uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUri), docId)
      val r = resolver() ?: return err2("no resolver")
      val text = r.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
        ?: return err2("openInputStream null")
      envelope { put("v", text) }
    } catch (e: Exception) { err(e) } }

    /** Resolve a child documentId by walking path segments from rootDocId when direct docId lookup fails. */
    private fun resolveChildDocIdBySegments(tree: Uri, startDocId: String, segments: List<String>): String? {
      val r = resolver() ?: return null
      var curDocId = startDocId
      for (seg in segments) {
        if (seg.isEmpty() || seg == ".") continue
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, curDocId)
        var found: String? = null
        var ciFound: String? = null
        r.query(
          children,
          arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME
          ),
          null, null, null
        )?.use { c ->
          while (c.moveToNext()) {
            val cid = c.getString(0)
            val name = if (c.isNull(1)) cid.substringAfterLast('/') else c.getString(1)
            if (name == seg) {
              found = cid
              break
            } else if (ciFound == null && name.equals(seg, ignoreCase = true)) {
              ciFound = cid
            }
          }
        }
        curDocId = found ?: ciFound ?: return null
      }
      return curDocId
    }

    /** #476 — Read binary document bytes as Base64 for local images inside a SAF folder. */
    @JvmStatic
    fun readBase64(treeUri: String, docId: String): String { return try {
      val tree = Uri.parse(treeUri)
      val r = resolver() ?: return err2("no resolver")
      var bytes: ByteArray? = try {
        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
        r.openInputStream(uri)?.use { it.readBytes() }
      } catch (_: Exception) {
        null
      }
      if (bytes == null) {
        val rootDocId = DocumentsContract.getTreeDocumentId(tree)
        val relPath = when {
          docId.startsWith("$rootDocId/") -> docId.removePrefix("$rootDocId/")
          docId.contains(':') && rootDocId.contains(':') &&
            docId.substringAfter(':').startsWith(rootDocId.substringAfter(':') + "/") ->
            docId.substringAfter(':').removePrefix(rootDocId.substringAfter(':') + "/")
          else -> docId.substringAfter(':')
        }
        val segments = relPath.split('/').filter { it.isNotEmpty() && it != "." }
        val resolvedDocId = resolveChildDocIdBySegments(tree, rootDocId, segments)
        if (resolvedDocId != null) {
          val uri = DocumentsContract.buildDocumentUriUsingTree(tree, resolvedDocId)
          bytes = r.openInputStream(uri)?.use { it.readBytes() }
        }
      }
      val data = bytes ?: return err2("openInputStream null")
      envelope { put("v", Base64.encodeToString(data, Base64.NO_WRAP)) }
    } catch (e: Exception) { err(e) } }

    /** Overwrite a document with UTF-8 text ("wt" truncates). */
    @JvmStatic
    fun writeText(treeUri: String, docId: String, content: String): String { return try {
      val uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUri), docId)
      val r = resolver() ?: return err2("no resolver")
      r.openOutputStream(uri, "wt")?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
        ?: return err2("openOutputStream null")
      envelope { put("v", true) }
    } catch (e: Exception) { err(e) } }

    /** #502 — Overwrite a SAF document with binary Base64 bytes (e.g. pasted/inserted image in _assets). */
    @JvmStatic
    fun writeBase64(treeUri: String, docId: String, b64: String): String { return try {
      val uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUri), docId)
      val r = resolver() ?: return err2("no resolver")
      val bytes = Base64.decode(b64, Base64.DEFAULT)
      val stream = try {
        r.openOutputStream(uri, "wt")
      } catch (_: Exception) {
        try {
          r.openOutputStream(uri, "w")
        } catch (_: Exception) {
          r.openOutputStream(uri)
        }
      }
      stream?.use {
        it.write(bytes)
        it.flush()
      } ?: return err2("openOutputStream null")
      envelope { put("v", true) }
    } catch (e: Exception) { err(e) } }

    /** #502 — Read binary bytes from a standalone content:// URI (e.g. Android photo picker). */
    @JvmStatic
    fun readContentUriBase64(uriStr: String): String { return try {
      val uri = Uri.parse(uriStr)
      val r = resolver() ?: return err2("no resolver")
      val bytes = r.openInputStream(uri)?.use { it.readBytes() }
        ?: return err2("openInputStream null")
      envelope { put("v", Base64.encodeToString(bytes, Base64.NO_WRAP)) }
    } catch (e: Exception) { err(e) } }

    /** Create a new document under parentDocId; returns its documentId. */
    @JvmStatic
    fun createDoc(treeUri: String, parentDocId: String, mime: String, name: String): String { return try {
      val parent = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUri), parentDocId)
      val r = resolver() ?: return err2("no resolver")
      val created = DocumentsContract.createDocument(r, parent, mime, name)
        ?: return err2("createDocument null")
      envelope { put("v", DocumentsContract.getDocumentId(created)) }
    } catch (e: Exception) { err(e) } }

    /** Write Base64-encoded bytes to a standalone content:// URI (e.g. from ACTION_CREATE_DOCUMENT). */
    @JvmStatic
    fun writeContentUriBase64(uriStr: String, b64: String): String { return try {
      val uri = Uri.parse(uriStr)
      val r = resolver() ?: return err2("no resolver")
      val bytes = Base64.decode(b64, Base64.DEFAULT)
      val stream = try {
        r.openOutputStream(uri, "wt")
      } catch (_: Exception) {
        try {
          r.openOutputStream(uri, "w")
        } catch (_: Exception) {
          r.openOutputStream(uri)
        }
      }
      stream?.use {
        it.write(bytes)
        it.flush()
      } ?: return err2("openOutputStream null")
      envelope { put("v", true) }
    } catch (e: Exception) { err(e) } }

    @JvmStatic
    private val printFinished = java.util.concurrent.atomic.AtomicBoolean(false)

    private fun findWebView(view: android.view.View?): android.webkit.WebView? {
      if (view is android.webkit.WebView) return view
      if (view is android.view.ViewGroup) {
        for (i in 0 until view.childCount) {
          val found = findWebView(view.getChildAt(i))
          if (found != null) return found
        }
      }
      return null
    }

    /** Trigger Android's native Print / Save-as-PDF dialog for the active WebView. */
    @JvmStatic
    fun printWebView(jobName: String): String {
      val act = instance ?: return err2("no activity")
      printFinished.set(false)
      val errRef = AtomicReference<String?>(null)
      val latch = java.util.concurrent.CountDownLatch(1)
      act.runOnUiThread {
        try {
          val wv = findWebView(act.window?.decorView)
          if (wv == null) {
            errRef.set("no WebView found")
            latch.countDown()
            return@runOnUiThread
          }
          val pm = act.getSystemService(Context.PRINT_SERVICE) as? android.print.PrintManager
          if (pm == null) {
            errRef.set("PrintManager unavailable")
            latch.countDown()
            return@runOnUiThread
          }
          val safeName = jobName.ifEmpty { "SoloMD" }
          val delegate = wv.createPrintDocumentAdapter(safeName)
          val wrapper = object : android.print.PrintDocumentAdapter() {
            override fun onStart() {
              delegate.onStart()
            }
            override fun onLayout(
              oldAttributes: android.print.PrintAttributes?,
              newAttributes: android.print.PrintAttributes?,
              cancellationSignal: android.os.CancellationSignal?,
              callback: LayoutResultCallback?,
              extras: Bundle?
            ) {
              delegate.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras)
            }
            override fun onWrite(
              pages: Array<out android.print.PageRange>?,
              destination: android.os.ParcelFileDescriptor?,
              cancellationSignal: android.os.CancellationSignal?,
              callback: WriteResultCallback?
            ) {
              delegate.onWrite(pages, destination, cancellationSignal, callback)
            }
            override fun onFinish() {
              try {
                delegate.onFinish()
              } finally {
                printFinished.set(true)
              }
            }
          }
          pm.print(safeName, wrapper, android.print.PrintAttributes.Builder().build())
          latch.countDown()
        } catch (e: Exception) {
          errRef.set(e.message ?: e.toString())
          latch.countDown()
        }
      }
      latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
      val errMsg = errRef.get()
      if (errMsg != null) return err2(errMsg)
      return envelope { put("v", true) }
    }

    @JvmStatic
    fun pollPrintFinished(): String = if (printFinished.getAndSet(false)) "1" else "0"

    /** Delete a document (file or empty dir). */
    @JvmStatic
    fun deleteDoc(treeUri: String, docId: String): String { return try {
      val uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUri), docId)
      val r = resolver() ?: return err2("no resolver")
      val ok = DocumentsContract.deleteDocument(r, uri)
      envelope { put("v", ok) }
    } catch (e: Exception) { err(e) } }

    private inline fun envelope(fill: JSONObject.() -> Unit): String =
      JSONObject().apply { put("ok", true); fill() }.toString()

    private fun err(e: Exception): String =
      JSONObject().apply { put("ok", false); put("e", e.message ?: e.toString()) }.toString()

    private fun err2(msg: String): String =
      JSONObject().apply { put("ok", false); put("e", msg) }.toString()
  }

  private var retriedInitialLoad = false

  override fun onCreate(savedInstanceState: Bundle?) {
    instance = this
    // Ensure $HOME points to the app's private files directory so Rust crates
    // (github_sync, cloud_folder, ai_keystore, cost_meter) never fail with
    // "no HOME directory" on Android.
    try {
      android.system.Os.setenv("HOME", filesDir.absolutePath, false)
    } catch (_: Throwable) {
    }
    // Guarantee ProcessLifecycleOwner is initialized before WryActivity.onCreate
    // registers WryLifecycleObserver (fixes blank screen when OEM ROMs delay
    // ContentProvider / AppStartup initialization).
    try {
      androidx.startup.AppInitializer.getInstance(applicationContext)
        .initializeComponent(androidx.lifecycle.ProcessLifecycleInitializer::class.java)
    } catch (_: Throwable) {
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: android.webkit.WebView) {
    super.onWebViewCreate(webView)
    // Work around wry's CreateWebView race on Android 16 / ColorOS 16 where
    // loadUrlMainThread("http://tauri.localhost/") is posted to an unattached
    // WebView before setWebViewClient and setContentView are wired up.
    val handler = android.os.Handler(android.os.Looper.getMainLooper())
    handler.postDelayed({
      try {
        val currentUrl = webView.url
        if (currentUrl.isNullOrEmpty() || currentUrl == "about:blank") {
          webView.loadUrl("http://tauri.localhost/")
        }
      } catch (_: Throwable) {
      }
    }, 150)
    handler.postDelayed({
      try {
        if (retriedInitialLoad) return@postDelayed
        val currentUrl = webView.url
        if (currentUrl.isNullOrEmpty() || currentUrl == "about:blank") {
          retriedInitialLoad = true
          webView.loadUrl("http://tauri.localhost/")
          return@postDelayed
        }
        webView.evaluateJavascript(
          "(function(){var r=document.getElementById('app');return (r&&r.childElementCount>0)||document.readyState==='loading'?'ok':'empty';})()"
        ) { res ->
          if (!retriedInitialLoad && res == "\"empty\"") {
            retriedInitialLoad = true
            webView.loadUrl("http://tauri.localhost/")
          }
        }
      } catch (_: Throwable) {
      }
    }, 1200)
  }

  override fun onDestroy() {
    val finishingPermanently = !isChangingConfigurations
    if (instance === this) {
      billingClient?.endConnection()
      billingClient = null
      instance = null
    }
    super.onDestroy()
    // WryLifecycleObserver.onCreate only fires once per OS process, while
    // WryActivity.onDestroy tears down the tao Window permanently. If Android
    // keeps the cached process alive after Activity destruction, relaunching
    // MainActivity would otherwise open a blank window with no WebView.
    if (finishingPermanently) {
      android.os.Process.killProcess(android.os.Process.myPid())
    }
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQ_PICK_TREE) return
    val uri: Uri? = data?.data
    if (resultCode == RESULT_OK && uri != null) {
      val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
        Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      try {
        contentResolver.takePersistableUriPermission(uri, flags)
      } catch (_: SecurityException) {
      }
      pickedTreeUri.set(uri.toString())
    } else {
      pickedTreeUri.set("")
    }
  }
}
