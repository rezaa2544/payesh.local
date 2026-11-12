package ir.payesh.owner

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Native owner app (row 126) — a Flutter activity, NOT a WebView: the panel UI is rendered by
 * Flutter (Dart AOT + Impeller/Skia). Only one tiny channel: the private data directory where
 * the server origin is remembered (the session token is never stored).
 */
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "dataDir" -> result.success(applicationContext.noBackupFilesDir.absolutePath)
                else -> result.notImplemented()
            }
        }
    }

    companion object {
        const val CHANNEL = "ir.payesh.owner/app"
    }
}
