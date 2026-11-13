package ir.payesh.owner

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.provider.Settings
import java.io.File
import java.io.FileNotFoundException

/**
 * Row 148 — in-app update on Android. Dart downloads the APK (progress on the top-bar light,
 * retries, SHA-256 + size checked against the published manifest) into cacheDir/updates; this
 * opens the SYSTEM package installer on it (never a browser). Android then asks the user to
 * confirm; the same signing key is required, so only a genuine release can replace the app.
 * After the install, [UpdatedReceiver] reopens the app where Android allows it (≤ 9; on newer
 * versions the installer's own «Open» button does it).
 */
class UpdateInstaller(private val activity: Activity) {
    fun cacheDir(): String {
        val d = File(activity.cacheDir, DIR)
        d.mkdirs()
        return d.absolutePath
    }

    fun install(path: String): String {
        val base = File(activity.cacheDir, DIR).canonicalFile
        val file = File(path).canonicalFile
        if (file.parentFile != base || !NAME.matches(file.name) || !file.isFile) {
            throw IllegalArgumentException("apk outside the update cache")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()
        ) {
            activity.startActivity(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.packageName)
                )
            )
            return "needs_permission"
        }
        val uri = Uri.Builder().scheme("content").authority(activity.packageName + AUTHORITY_SUFFIX)
            .appendPath(file.name).build()
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        return "started"
    }

    companion object {
        const val CHANNEL = "ir.payesh/update"
        const val DIR = "updates"
        const val AUTHORITY_SUFFIX = ".updates"
        const val APK_MIME = "application/vnd.android.package-archive"
        val NAME = Regex("^payesh-update-[0-9]{1,10}\\.apk$")
    }
}

/** Read-only provider for the downloaded APK only (no other file can be named). */
class UpdateFileProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    private fun fileFor(uri: Uri): File {
        val name = uri.lastPathSegment ?: throw FileNotFoundException()
        if (uri.pathSegments.size != 1 || !UpdateInstaller.NAME.matches(name)) throw FileNotFoundException()
        val f = File(File(context!!.cacheDir, UpdateInstaller.DIR), name)
        if (!f.isFile) throw FileNotFoundException()
        return f
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("read only")
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri): String = UpdateInstaller.APK_MIME

    override fun query(
        uri: Uri, projection: Array<out String>?, selection: String?,
        selectionArgs: Array<out String>?, sortOrder: String?
    ): Cursor {
        val f = fileFor(uri)
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val c = MatrixCursor(cols)
        c.addRow(cols.map { col ->
            when (col) {
                OpenableColumns.DISPLAY_NAME -> f.name
                OpenableColumns.SIZE -> f.length()
                else -> null
            }
        }.toTypedArray())
        return c
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()
    override fun update(
        uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?
    ): Int = throw UnsupportedOperationException()
}

/** After the update is installed: clean the downloaded APK and reopen the app. */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        try {
            File(context.cacheDir, UpdateInstaller.DIR).listFiles()?.forEach { it.delete() }
        } catch (e: Exception) {
        }
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        try {
            context.startActivity(launch)
        } catch (e: Exception) {
            // Android 10+ may block starts from the background; the installer's «Open» remains.
        }
    }
}
