package ir.payesh.school.payesh_app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/** Native shell. Registers the Keystore-backed secure store channel (row 72) plus the device id and
 *  browser hand-off of row 145. No WebView. */
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
    }

    companion object {
        const val CHANNEL = "ir.payesh.school/secure_store"
    }
}
