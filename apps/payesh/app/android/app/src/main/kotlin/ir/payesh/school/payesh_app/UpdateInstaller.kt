package ir.payesh.school.payesh_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Row 148 — after the school app was updated (new APK installed over it), reopen it where
 * Android allows a start from the background (≤ 9); on newer versions the system installer's
 * «Open» button does it. The school app never installs packages itself (no
 * REQUEST_INSTALL_PACKAGES — Google Play policy): the update light opens the published APK.
 */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        try {
            context.startActivity(launch)
        } catch (e: Exception) {
            // blocked from the background on Android 10+; the installer's «Open» remains
        }
    }
}
