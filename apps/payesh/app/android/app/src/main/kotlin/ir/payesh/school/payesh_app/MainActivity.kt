package ir.payesh.school.payesh_app

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/** Native shell. Registers the Keystore-backed secure store channel (row 72). No WebView. */
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
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
                        else -> result.notImplemented()
                    }
                } catch (e: Exception) {
                    // Never echo values; only the exception type/message.
                    result.error("secure_store", e.javaClass.simpleName + ": " + (e.message ?: ""), null)
                }
            }
    }

    companion object {
        const val CHANNEL = "ir.payesh.school/secure_store"
    }
}
