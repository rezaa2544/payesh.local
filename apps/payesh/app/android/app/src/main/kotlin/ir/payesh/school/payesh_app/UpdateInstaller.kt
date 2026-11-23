package ir.payesh.school.payesh_app

import android.annotation.TargetApi
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
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
 * Row 148 (owner) / row 165 (school app, owner decision: direct distribution, not Google Play) —
 * in-app update on Android. Dart downloads the APK (progress on the top-bar light,
 * retries, SHA-256 + size checked against the published manifest) into cacheDir/updates; this
 * opens the SYSTEM package installer on it (never a browser). Android then asks the user to
 * confirm; the same signing key is required, so only a genuine release can replace the app.
 * After the install, [UpdatedReceiver] reopens the app where Android allows it (≤ 9; on newer
 * versions the installer's own «Open» button does it).
 *
 * Row 175: on Android 12+ the update is committed through a [PackageInstaller] session with
 * USER_ACTION_NOT_REQUIRED — an app updating ITSELF (same package, same signing key, target
 * SDK recent enough, UPDATE_PACKAGES_WITHOUT_USER_ACTION declared) is installed without the
 * system/vendor installer screen, so no «unknown app» or vendor security-scan prompt. Android
 * still verifies the signature. If the system wants a confirmation anyway, [InstallStatusReceiver]
 * shows it; if the session fails it falls back to the old system-installer path. The one-time
 * «install unknown apps» permission for this app is still required (Android rule).
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                commitSession(file)
                return "silent"
            } catch (e: Exception) {
                // Session refused (vendor ROM, storage, …): the classic system installer below.
            }
        }
        activity.startActivity(viewIntent(activity, file))
        return "started"
    }

    /** Row 175: self-update without the installer screen (Android 12+). */
    @TargetApi(Build.VERSION_CODES.S)
    private fun commitSession(file: File) {
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(activity.packageName)
        params.setSize(file.length())
        params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = installer.createSession(params)
        val session = installer.openSession(id)
        try {
            file.inputStream().use { input ->
                session.openWrite("payesh-update.apk", 0, file.length()).use { out ->
                    input.copyTo(out)
                    session.fsync(out)
                }
            }
            val status = Intent(activity, InstallStatusReceiver::class.java)
                .setPackage(activity.packageName)
                .putExtra(InstallStatusReceiver.EXTRA_FILE, file.name)
            // MUTABLE: the system adds EXTRA_STATUS; the intent is explicit (our own receiver).
            val pending = PendingIntent.getBroadcast(
                activity, id, status, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
            session.commit(pending.intentSender)
        } catch (e: Exception) {
            try {
                session.abandon()
            } catch (ignored: Exception) {
            }
            throw e
        } finally {
            session.close()
        }
    }

    companion object {
        const val CHANNEL = "ir.payesh/update"
        const val DIR = "updates"
        const val AUTHORITY_SUFFIX = ".updates"
        const val APK_MIME = "application/vnd.android.package-archive"
        val NAME = Regex("^payesh-update-[0-9]{1,10}\\.apk$")

        /** The classic path: hand the (already hash-checked) APK to the system installer screen. */
        fun viewIntent(context: Context, file: File): Intent {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                val uri = Uri.Builder().scheme("content").authority(context.packageName + AUTHORITY_SUFFIX)
                    .appendPath(file.name).build()
                return Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, APK_MIME)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            // Row 168: the installer of Android 5.0-6.0 only accepts file:// URIs and reads the
            // file from its own process, so the downloaded APK (already hash-checked by Dart) is
            // made world-readable and its directories traversable — never listable.
            val base = file.parentFile!!
            base.setExecutable(true, false)
            base.parentFile?.setExecutable(true, false)
            file.setReadable(true, false)
            return Intent(Intent.ACTION_VIEW)
                .setDataAndType(Uri.fromFile(file), APK_MIME)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
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
        val row = arrayOfNulls<Any>(cols.size)
        for (i in cols.indices) {
            row[i] = when (cols[i]) {
                OpenableColumns.DISPLAY_NAME -> f.name
                OpenableColumns.SIZE -> f.length()
                else -> null
            }
        }
        c.addRow(row)
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

/**
 * Row 175: result of the self-update session. Not exported — only the system installer (through
 * our own PendingIntent) reaches it. Success needs nothing (Android restarts the package and
 * [UpdatedReceiver] cleans up); a requested confirmation is shown; any failure other than the user
 * cancelling falls back to the classic system installer with the same verified file.
 */
class InstallStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_SUCCESS, PackageInstaller.STATUS_FAILURE_ABORTED -> return
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                if (confirm != null) start(context, confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            else -> {
                val name = intent.getStringExtra(EXTRA_FILE) ?: return
                if (!UpdateInstaller.NAME.matches(name)) return
                val f = File(File(context.cacheDir, UpdateInstaller.DIR), name)
                if (f.isFile) start(context, UpdateInstaller.viewIntent(context, f))
            }
        }
    }

    private fun start(context: Context, i: Intent) {
        try {
            context.startActivity(i)
        } catch (e: Exception) {
            // The app left the foreground: the update light offers the install again.
        }
    }

    companion object {
        const val EXTRA_FILE = "ir.payesh.update.FILE"
    }
}
