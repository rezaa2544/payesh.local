package ir.payesh.school.payesh_app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/** Native shell. Registers the Keystore-backed secure store channel (row 72) plus the device id and
 *  browser hand-off of row 145. No WebView. */
class MainActivity : FlutterActivity() {
    /** Row 194: the pending «انتخاب فایل» call (one at a time). */
    private var pickResult: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Row 194: the system file picker (Storage Access Framework, ACTION_OPEN_DOCUMENT —
        // no storage permission needed). The chosen file comes back as {name, bytes}.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, FILES_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "pick" -> {
                        if (pickResult != null) {
                            result.error("busy", "the file picker is already open", null)
                        } else {
                            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
                                .addCategory(Intent.CATEGORY_OPENABLE)
                                .setType("*/*")
                                .putExtra(Intent.EXTRA_MIME_TYPES, PICK_TYPES)
                            try {
                                pickResult = result
                                startActivityForResult(intent, PICK_REQUEST)
                            } catch (e: ActivityNotFoundException) {
                                pickResult = null
                                result.error("no_picker", "no file picker on this device", null)
                            }
                        }
                    }
                    else -> result.notImplemented()
                }
            }
        val store = KeystoreSecureStore(applicationContext)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "read" -> result.success(store.read(call.argument<String>("key")!!))
                        "write" -> {
                            store.write(call.argument<String>("key")!!, call.argument<String>("value")!!)
                            result.success(null)
                        }
                        "delete" -> {
                            store.delete(call.argument<String>("key")!!)
                            result.success(null)
                        }
                        "dataDir" -> result.success(applicationContext.noBackupFilesDir.absolutePath)
                        // Row 145: system id that survives uninstall/reinstall (one trial per device);
                        // only its SHA-256 leaves the app.
                        "deviceId" -> result.success(
                            Settings.Secure.getString(applicationContext.contentResolver, Settings.Secure.ANDROID_ID)
                        )
                        // Row 145: the owner's payment gateway in the system browser
                        "openUrl" -> {
                            val url = call.argument<String>("url")!!
                            if (!(url.startsWith("https://") || url.startsWith("http://"))) {
                                result.success(false)
                            } else {
                                try {
                                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                                    result.success(true)
                                } catch (e: ActivityNotFoundException) {
                                    result.success(false)
                                }
                            }
                        }
                        else -> result.notImplemented()
                    }
                } catch (e: Exception) {
                    // Never echo values; only the exception type/message.
                    result.error("secure_store", e.javaClass.simpleName + ": " + (e.message ?: ""), null)
                }
            }
        // Row 165: in-app update — the APK downloaded and hash-checked by Dart goes to the SYSTEM
        // installer (same signing key required; Android always asks the user to confirm).
        val updates = UpdateInstaller(this)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, UpdateInstaller.CHANNEL)
            .setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "cacheDir" -> result.success(updates.cacheDir())
                        "installApk" -> result.success(updates.install(call.argument<String>("path")!!))
                        else -> result.notImplemented()
                    }
                } catch (e: Exception) {
                    result.error("update", e.javaClass.simpleName + ": " + (e.message ?: ""), null)
                }
            }
    }

    @Deprecated("Activity result API of FlutterActivity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != PICK_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val result = pickResult ?: return
        pickResult = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            result.success(null)
            return
        }
        // read off the main thread; a school list is small, but a phone's storage can be slow
        Thread {
            try {
                var name = uri.lastPathSegment ?: "file"
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
                }
                val bytes = contentResolver.openInputStream(uri)?.use { input ->
                    val out = java.io.ByteArrayOutputStream()
                    val buf = ByteArray(64 * 1024)
                    var total = 0
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_PICK_BYTES) throw java.io.IOException("too_big")
                        out.write(buf, 0, n)
                    }
                    out.toByteArray()
                } ?: throw java.io.IOException("unreadable")
                runOnUiThread { result.success(mapOf("name" to name, "bytes" to bytes)) }
            } catch (e: Exception) {
                runOnUiThread { result.error("read", e.message ?: e.javaClass.simpleName, null) }
            }
        }.start()
    }

    companion object {
        init {
            // Row 168: on Android 5.0-6.0 the 64-bit libflutter.so needs libpayeshw21.so (libc
            // symbols added in 6.0/7.0, see tools/android21/pw21shim.c). It is a DT_NEEDED of
            // libflutter.so; loading it first just makes that independent of the linker's search
            // path. The 32-bit build does not bundle it (not needed there).
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
                try {
                    System.loadLibrary("payeshw21")
                } catch (e: UnsatisfiedLinkError) {
                }
            }
        }

        const val CHANNEL = "ir.payesh.school/secure_store"
        const val FILES_CHANNEL = "ir.payesh.school/files"
        private const val PICK_REQUEST = 1940
        private const val MAX_PICK_BYTES = 25 * 1024 * 1024
        private val PICK_TYPES = arrayOf(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel",
            "text/csv",
            "text/comma-separated-values",
            "text/plain",
            "application/octet-stream",
        )
    }
}
