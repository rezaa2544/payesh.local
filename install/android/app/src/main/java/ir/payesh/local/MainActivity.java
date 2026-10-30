package ir.payesh.local;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * پوستهٔ اندروید پایش.
 * برنامهٔ واقعی روی سیستم مدرسه اجرا می‌شود و این پوسته همان رابط وب را
 * در WebView نشان می‌دهد؛ بنابراین به‌روزرسانی‌ها فوری و بدون نصب مجدد اعمال می‌شوند.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "payesh";
    private static final String KEY_URL = "server_url";

    private WebView web;
    private ProgressBar bar;
    private TextView errorView;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILE_PICK = 1001;

    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setVisibility(View.GONE);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4)));

        FrameLayout frame = new FrameLayout(this);
        root.addView(frame, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        web = new WebView(this);
        frame.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        errorView = new TextView(this);
        errorView.setText(R.string.conn_error);
        errorView.setTextSize(15);
        errorView.setGravity(android.view.Gravity.CENTER);
        errorView.setPadding(dp(24), dp(24), dp(24), dp(24));
        errorView.setVisibility(View.GONE);
        frame.addView(errorView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        setupWebView();

        String url = prefs.getString(KEY_URL, "");
        if (url == null || url.isEmpty()) askServer();
        else load(url);
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("http://") || url.startsWith("https://")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                bar.setVisibility(View.GONE);
                errorView.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    errorView.setVisibility(View.VISIBLE);
                    web.setVisibility(View.GONE);
                    bar.setVisibility(View.GONE);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int p) {
                bar.setVisibility(p >= 100 ? View.GONE : View.VISIBLE);
                bar.setProgress(p);
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                filePathCallback = cb;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    startActivityForResult(Intent.createChooser(i, "انتخاب فایل"), FILE_PICK);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                request.deny();
            }
        });

        errorView.setOnClickListener(v -> {
            String u = prefs.getString(KEY_URL, "");
            if (!u.isEmpty()) load(u);
        });
    }

    private void load(String url) {
        web.setVisibility(View.VISIBLE);
        errorView.setVisibility(View.GONE);
        bar.setVisibility(View.VISIBLE);
        web.loadUrl(url);
    }

    private String normalize(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.isEmpty()) return "";
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    private void askServer() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(R.string.server_hint);
        input.setText(prefs.getString(KEY_URL, ""));
        input.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
        int pad = dp(16);
        input.setPadding(pad, pad, pad, pad);

        new AlertDialog.Builder(this)
            .setTitle(R.string.server_title)
            .setMessage(R.string.server_help)
            .setView(input)
            .setCancelable(false)
            .setPositiveButton(R.string.save, (d, w) -> {
                String u = normalize(input.getText().toString());
                if (u.isEmpty()) { Toast.makeText(this, R.string.server_hint, Toast.LENGTH_LONG).show(); askServer(); return; }
                prefs.edit().putString(KEY_URL, u).apply();
                load(u);
            })
            .setNegativeButton(R.string.cancel, (d, w) -> finish())
            .show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, R.string.change_server);
        menu.add(0, 2, 1, R.string.reload);
        return super.onCreateOptionsMenu(menu);
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) { askServer(); return true; }
        if (item.getItemId() == 2) { web.reload(); return true; }
        return super.onOptionsItemSelected(item);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_PICK && filePathCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            filePathCallback.onReceiveValue(result);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
