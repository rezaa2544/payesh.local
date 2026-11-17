package ir.payesh.owner

import android.content.Intent
import android.net.Uri
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Native owner app (row 126) — a Flutter activity, NOT a WebView: the panel UI is rendered by
 * Flutter (Dart AOT + Impeller/Skia). One tiny channel: the private data directory (server
 * origin, theme) and the Keystore-backed secret store (local owner account hash + database keys).
 */
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val store = KeystoreSecureStore(applicationContext)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "dataDir" -> result.success(applicationContext.noBackupFilesDir.absolutePath)
                    "secureRead" -> result.success(store.read(call.argument<String>("key")!!))
                    "secureWrite" -> {
                        store.write(call.argument<String>("key")!!, call.argument<String>("value")!!)
                        result.success(null)
                    }
                    "secureDelete" -> {
                        store.delete(call.argument<String>("key")!!)
                        result.success(null)
                    }
                    // نسخهٔ تازه (APK) با مرورگر/دانلودگر سیستم؛ فقط https
                    "openUrl" -> {
                        val url = call.argument<String>("url")!!
                        if (!url.startsWith("https://")) throw IllegalArgumentException("https only")
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                // Never echo values; only the exception type/message.
                result.error("secure_store", e.javaClass.simpleName + ": " + (e.message ?: ""), null)
            }
        }
        // Row 148: in-app update — the APK downloaded by Dart goes to the SYSTEM installer.
        val updates = UpdateInstaller(this)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, UpdateInstaller.CHANNEL).setMethodCallHandler { call, result ->
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

        const val CHANNEL = "ir.payesh.owner/app"
    }
}
