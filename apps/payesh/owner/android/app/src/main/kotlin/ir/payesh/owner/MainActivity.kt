package ir.payesh.owner

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
                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                // Never echo values; only the exception type/message.
                result.error("secure_store", e.javaClass.simpleName + ": " + (e.message ?: ""), null)
            }
        }
    }

    companion object {
        const val CHANNEL = "ir.payesh.owner/app"
    }
}
