package app.solomd

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import androidx.activity.enableEdgeToEdge
import org.json.JSONArray
import org.json.JSONObject
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

    @JvmStatic
    private var instance: MainActivity? = null

    // Set by onActivityResult, drained by pollPicked(): null = no result yet,
    // "" = cancelled, "content://…" = granted tree URI.
    @JvmStatic
    private val pickedTreeUri = AtomicReference<String?>(null)

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

    /** Overwrite a document with UTF-8 text ("wt" truncates). */
    @JvmStatic
    fun writeText(treeUri: String, docId: String, content: String): String { return try {
      val uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUri), docId)
      val r = resolver() ?: return err2("no resolver")
      r.openOutputStream(uri, "wt")?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
        ?: return err2("openOutputStream null")
      envelope { put("v", true) }
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

  override fun onCreate(savedInstanceState: Bundle?) {
    instance = this
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
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
