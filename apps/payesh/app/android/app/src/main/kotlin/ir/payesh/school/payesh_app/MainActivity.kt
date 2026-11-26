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

    /** ردیف ۱۹۷: این انتخاب عکس گواهی مرخصی است — قبل از برگشت به JPEG کوچک فشرده می‌شود. */
    private var pickShrink = false

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Row 194: the system file picker (Storage Access Framework, ACTION_OPEN_DOCUMENT —
        // no storage permission needed). The chosen file comes back as {name, bytes}.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, FILES_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "pick", "pickImage" -> {
                        if (pickResult != null) {
                            result.error("busy", "the file picker is already open", null)
                        } else {
                            val image = call.method == "pickImage"
                            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
                                .addCategory(Intent.CATEGORY_OPENABLE)
                            if (image) intent.setType("image/*")
                            else intent.setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, PICK_TYPES)
                            pickShrink = image
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
                val out = if (pickShrink) shrinkImage(bytes) else bytes
                runOnUiThread { result.success(mapOf("name" to name, "bytes" to out)) }
            } catch (e: Exception) {
                runOnUiThread { result.error("read", e.message ?: e.javaClass.simpleName, null) }
            }
        }.start()
    }

    /** ردیف ۱۹۷: عکس دوربین (چند مگابایت) → JPEG حداکثر ۴۴ کیلوبایت با چرخش درست EXIF، تا
     *  گواهی مرخصی در یک عملیات همگام‌سازی (سقف ۶۴ کیلوبایت) جا شود. */
    private fun shrinkImage(bytes: ByteArray): ByteArray {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw java.io.IOException("not_image")
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1280) sample *= 2
        val opts = android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }
        var bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            ?: throw java.io.IOException("not_image")
        if (Build.VERSION.SDK_INT >= 24) {
            try {
                val exif = android.media.ExifInterface(java.io.ByteArrayInputStream(bytes))
                val deg = when (exif.getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) {
                    6 -> 90f; 3 -> 180f; 8 -> 270f; else -> 0f
                }
                if (deg != 0f) {
                    val m = android.graphics.Matrix().apply { postRotate(deg) }
                    bmp = android.graphics.Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
                }
            } catch (e: Exception) { /* بدون EXIF */ }
        }
        for (side in intArrayOf(1280, 1024, 800, 640, 480, 360)) {
            val k = minOf(1f, side.toFloat() / maxOf(bmp.width, bmp.height))
            val scaled = if (k < 1f) android.graphics.Bitmap.createScaledBitmap(
                bmp, maxOf(1, (bmp.width * k).toInt()), maxOf(1, (bmp.height * k).toInt()), true) else bmp
            for (q in intArrayOf(80, 65, 50, 40)) {
                val out = java.io.ByteArrayOutputStream()
                scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, q, out)
                if (out.size() <= MAX_LEAVE_IMAGE) return out.toByteArray()
            }
        }
        throw java.io.IOException("too_big")
    }

    companion object {
        /** ردیف ۱۹۷: سقف عکس گواهی مرخصی (بایت؛ base64 آن زیر ۶۰٬۰۰۰ نویسه می‌ماند). */
        private const val MAX_LEAVE_IMAGE = 44000
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
