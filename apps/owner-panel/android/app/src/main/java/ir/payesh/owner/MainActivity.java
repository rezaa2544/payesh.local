package ir.payesh.owner;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * پوستهٔ نازک پنل مالک — ADR‑62.
 *  · فقط مبدأ واردشده در اولین اجرا (OriginPolicy)؛ هر پیوند دیگر مسدود.
 *  · بدون پل JavaScript، بدون دسترسی فایل/محتوا، بدون mixed content.
 *  · خطای TLS ⇒ لغو (هرگز proceed).
 *  · FLAG_SECURE: صفحهٔ پنل در اسکرین‌شات/فهرست برنامه‌های اخیر دیده نمی‌شود.
 *  · هیچ آدرس/توکن/کلید پخته‌شده‌ای وجود ندارد.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "payesh_owner_shell";
    private static final String KEY_ORIGIN = "origin";
    private static final int MENU_CHANGE = 1;
    private static final int MENU_RELOAD = 2;

    private WebView web;
    private String origin;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        WebView.setWebContentsDebuggingEnabled(false);
        web = new WebView(this);
        setContentView(web);
        configure(web);
        origin = OriginPolicy.normalize(prefs().getString(KEY_ORIGIN, null));
        if (origin == null) {
            askOrigin(false);
        } else if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(origin + "/");
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void configure(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSaveFormData(false);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String url = req.getUrl() == null ? null : req.getUrl().toString();
                if (OriginPolicy.sameOrigin(url, origin)) return false;
                Toast.makeText(MainActivity.this, R.string.blocked, Toast.LENGTH_SHORT).show();
                return true;
            }

            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler handler, SslError error) {
                handler.cancel();
                Toast.makeText(MainActivity.this, R.string.tls_error, Toast.LENGTH_LONG).show();
            }
        });
        view.setDownloadListener((url, ua, cd, mime, len) ->
            Toast.makeText(MainActivity.this, R.string.blocked, Toast.LENGTH_SHORT).show());
    }

    private void askOrigin(final boolean cancellable) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad / 2, pad, 0);
        TextView help = new TextView(this);
        help.setText(R.string.origin_help);
        final EditText input = new EditText(this);
        input.setHint(R.string.origin_hint);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        if (origin != null) input.setText(origin);
        box.addView(help);
        box.addView(input);
        AlertDialog.Builder b = new AlertDialog.Builder(this)
            .setTitle(R.string.origin_title)
            .setView(box)
            .setCancelable(cancellable)
            .setPositiveButton(R.string.save, null);
        if (cancellable) b.setNegativeButton(R.string.cancel, null);
        final AlertDialog dlg = b.create();
        dlg.setOnShowListener(d -> dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(x -> {
            String o = OriginPolicy.normalize(input.getText().toString());
            if (o == null) {
                input.setError(getString(R.string.origin_invalid));
                return;
            }
            if (origin != null && !o.equals(origin)) wipeWebData();
            origin = o;
            prefs().edit().putString(KEY_ORIGIN, o).apply();
            dlg.dismiss();
            web.loadUrl(o + "/");
        }));
        dlg.show();
    }

    /** با تغییر سرور، نشست/کوکی/ذخیرهٔ سرور قبلی پاک می‌شود. */
    private void wipeWebData() {
        web.clearHistory();
        web.clearCache(true);
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        WebStorage.getInstance().deleteAllData();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(Menu.NONE, MENU_RELOAD, 1, R.string.reload);
        menu.add(Menu.NONE, MENU_CHANGE, 2, R.string.change_origin);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == MENU_CHANGE) { askOrigin(true); return true; }
        if (item.getItemId() == MENU_RELOAD) { if (origin != null) web.reload(); return true; }
        return super.onOptionsItemSelected(item);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
