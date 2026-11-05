package ir.payesh.local;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
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
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * پوستهٔ اندروید پایش.
 *
 * کاربر نباید هیچ آدرسی وارد کند: آدرس سرویس به‌ترتیب از این منابع پیدا می‌شود
 *   ۱) آدرسی که قبلاً روی همین گوشی ذخیره شده
 *   ۲) آدرس پخته‌شده در خودِ APK (هنگام ساخت: PAYESH_APP_URL یا url.properties)
 *   ۳) فایل پیکربندی مرکزی مخزن  android-config.json
 *   ۴) جستجوی خودکار سرویس در شبکهٔ محلی
 *   ۵) و تنها در آخرین حالت، پرسیدن از کاربر
 */
public class MainActivity extends Activity {

    private static final String PREFS = "payesh";
    private static final String KEY_URL = "server_url";       /* آدرس انتخاب‌شده */
    private static final String KEY_REMOTE = "config_url";    /* آخرین آدرسِ گرفته‌شده از پیکربندی مرکزی */
    private static final String KEY_LAST = "last_url";        /* آخرین نشانی‌ای که واقعاً باز شد */
    private static final String KEY_PUBLIC = "public_url";    /* آدرس عمومی که خود سرور اعلام کرده */

    /* پیکربندی مرکزی: تغییر آدرس بدون نیاز به ساخت دوبارهٔ برنامه */
    private static final String[] CONFIG_URLS = {
        "https://raw.githubusercontent.com/rezaa2544/payesh.local/main/android-config.json",
        "https://cdn.jsdelivr.net/gh/rezaa2544/payesh.local@main/android-config.json",
    };

    private static final int FILE_PICK = 1001;
    private static final int MAX_AUTO_TRIES = 3;

    private WebView web;
    private ProgressBar bar;
    private TextView errorView;
    private Button errorButton;
    private LinearLayout splash;
    private TextView splashText;
    private ValueCallback<Uri[]> filePathCallback;

    private SharedPreferences prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private int tries = 0;
    private boolean scanning = false;
    private java.util.List<String> queue = new java.util.ArrayList<>();
    private int queueIndex = 0;
    private String loadedBase = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF0B1B33);

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setVisibility(View.GONE);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4)));

        FrameLayout frame = new FrameLayout(this);
        root.addView(frame, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        web = new WebView(this);
        web.setBackgroundColor(0xFF0B1B33);
        web.setVisibility(View.INVISIBLE);
        frame.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        /* صفحهٔ «در حال اتصال» — کاربر فقط همین را می‌بیند */
        splash = new LinearLayout(this);
        splash.setOrientation(LinearLayout.VERTICAL);
        splash.setGravity(android.view.Gravity.CENTER);
        splash.setPadding(dp(28), dp(28), dp(28), dp(28));
        TextView logo = new TextView(this);
        logo.setText("پایش");
        logo.setTextSize(30);
        logo.setTextColor(0xFFFFFFFF);
        logo.setGravity(android.view.Gravity.CENTER);
        splash.addView(logo);
        splashText = new TextView(this);
        splashText.setText(R.string.connecting);
        splashText.setTextSize(15);
        splashText.setTextColor(0xFFB9C6DA);
        splashText.setGravity(android.view.Gravity.CENTER);
        splashText.setPadding(0, dp(12), 0, 0);
        splash.addView(splashText);
        frame.addView(splash, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        /* صفحهٔ خطا */
        LinearLayout errBox = new LinearLayout(this);
        errBox.setOrientation(LinearLayout.VERTICAL);
        errBox.setGravity(android.view.Gravity.CENTER);
        errBox.setPadding(dp(24), dp(24), dp(24), dp(24));
        errBox.setVisibility(View.GONE);
        errorView = new TextView(this);
        errorView.setText(R.string.conn_error);
        errorView.setTextSize(15);
        errorView.setTextColor(0xFFE7EDF6);
        errorView.setGravity(android.view.Gravity.CENTER);
        errBox.addView(errorView);
        errorButton = new Button(this);
        errorButton.setText(R.string.retry);
        errorButton.setOnClickListener(v -> connect(false));
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.topMargin = dp(16);
        errBox.addView(errorButton, bp);
        Button findButton = new Button(this);
        findButton.setText(R.string.find_lan);
        findButton.setOnClickListener(v -> scanLan());
        errBox.addView(findButton);
        Button offlineButton = new Button(this);
        offlineButton.setText(R.string.offline_view);
        offlineButton.setOnClickListener(v -> showOffline());
        errBox.addView(offlineButton);
        Button setButton = new Button(this);
        setButton.setText(R.string.set_manual);
        setButton.setOnClickListener(v -> askServer());
        errBox.addView(setButton);
        frame.addView(errBox, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        errorView.setTag(errBox);

        setContentView(root);
        setupWebView();

        connect(true);
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    /* ── پیدا کردن آدرس و اتصال ─────────────────────────────────────── */

    private void connect(boolean firstRun) {
        /* اتصال عادی همیشه شبکه را ترجیح می‌دهد؛ حالت «فقط کش» مال دکمهٔ آفلاین است */
        if (web != null) web.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
        tries = 0;
        queue = candidates();
        queueIndex = 0;
        if (!queue.isEmpty()) { load(queue.get(0)); return; }
        if (firstRun) showSplash(R.string.connecting);
        fetchRemoteConfig(url2 -> {
            if (url2 != null && !url2.isEmpty()) {
                prefs.edit().putString(KEY_REMOTE, url2).apply();
                queue = candidates();
                queueIndex = 0;
                load(queue.get(0));
            } else if (firstRun) {
                /* هیچ آدرسی نبود: جستجوی شبکه، وگرنه پرسش */
                showSplash(R.string.searching);
                scanLan();
            }
        });
    }

    /** همهٔ آدرس‌های ممکن، به‌ترتیب اولویت و بدون تکرار */
    private java.util.List<String> candidates() {
        java.util.List<String> out = new java.util.ArrayList<>();
        for (String raw : new String[]{
                prefs.getString(KEY_URL, ""),
                BuildConfig.PAYESH_URL == null ? "" : BuildConfig.PAYESH_URL,
                prefs.getString(KEY_PUBLIC, "")}) {
            String u = normalize(raw);
            if (!u.isEmpty() && !out.contains(u)) out.add(u);
        }
        /* آدرس‌های مخزن می‌توانند چندتا باشند: سیستم مدرسه + رایانهٔ پشتیبان */
        for (String raw : prefs.getString(KEY_REMOTE, "").split("\n")) {
            String u = normalize(raw);
            if (!u.isEmpty() && !out.contains(u)) out.add(u);
        }
        return out;
    }

    /** اولین آدرس شناخته‌شده (برای بررسی‌های سریع) */
    private String resolveKnownUrl() {
        java.util.List<String> list = candidates();
        return list.isEmpty() ? "" : list.get(0);
    }

    private interface UrlCallback { void onUrl(String url); }

    /** خواندن پیکربندی مرکزی از مخزن (اگر اینترنت بود) */
    private void fetchRemoteConfig(UrlCallback cb) {
        new Thread(() -> {
            String found = null;
            for (String cfg : CONFIG_URLS) {
                try {
                    String body = httpGet(cfg, 4000);
                    if (body == null) continue;
                    JSONObject j = new JSONObject(body);
                    /* url تکی (سازگاری) + آرایهٔ urls برای چند سرور */
                    StringBuilder list = new StringBuilder();
                    String single = normalize(j.optString("url", "").trim());
                    if (!single.isEmpty()) list.append(single);
                    org.json.JSONArray arr = j.optJSONArray("urls");
                    if (arr != null) {
                        for (int i = 0; i < arr.length(); i++) {
                            String u = normalize(arr.optString(i, "").trim());
                            if (u.isEmpty()) continue;
                            if (list.length() > 0) list.append("\n");
                            list.append(u);
                        }
                    }
                    if (list.length() > 0) { found = list.toString(); break; }
                } catch (Exception ignored) { }
            }
            final String result = found;
            ui.post(() -> cb.onUrl(result));
        }).start();
    }

    private String httpGet(String target, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(target).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setRequestProperty("Accept", "application/json");
            if (c.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** تلاش برای پیدا کردن سرویس پایش در همان شبکهٔ Wi-Fi */
    private void scanLan() {
        if (scanning) return;
        scanning = true;
        showSplash(R.string.searching);
        new Thread(() -> {
            String local = localIpv4();
            String found = null;
            if (local != null) {
                String prefix = local.substring(0, local.lastIndexOf('.') + 1);
                ExecutorService pool = Executors.newFixedThreadPool(64);
                final AtomicBoolean hit = new AtomicBoolean(false);
                for (int i = 1; i <= 254 && !hit.get(); i++) {
                    final String host = prefix + i;
                    pool.submit(() -> {
                        if (hit.get()) return;
                        String base = "http://" + host + ":8080";
                        String body = httpGet(base + "/api/health", 450);
                        if (body != null && body.contains("payesh-local")) {
                            hit.set(true);
                            prefs.edit().putString(KEY_URL, base).apply();   /* دفعهٔ بعد یادش می‌ماند */
                            ui.post(() -> load(base));
                        }
                    });
                }
                pool.shutdown();
                try { pool.awaitTermination(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
                if (hit.get()) { scanning = false; return; }
            }
            scanning = false;
            ui.post(() -> {
                if (resolveKnownUrl().isEmpty()) showError();
            });
        }).start();
    }

    private String localIpv4() {
        try {
            java.util.Enumeration<java.net.NetworkInterface> ifs = java.net.NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                java.net.NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    java.net.InetAddress a = addrs.nextElement();
                    if (a instanceof java.net.Inet4Address && !a.isLoopbackAddress()) {
                        String ip = a.getHostAddress();
                        if (ip != null && ip.startsWith("192.168.") || ip != null && ip.startsWith("10.") || ip != null && ip.startsWith("172.")) return ip;
                    }
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    /* ── نمایش‌ها ──────────────────────────────────────────────────── */

    private void showSplash(int textRes) {
        splashText.setText(textRes);
        splash.setVisibility(View.VISIBLE);
        errorBox().setVisibility(View.GONE);
        bar.setVisibility(View.GONE);
        web.setVisibility(View.INVISIBLE);
    }

    private View errorBox() { return (View) errorView.getTag(); }

    private void showError() {
        splash.setVisibility(View.GONE);
        errorBox().setVisibility(View.VISIBLE);
        web.setVisibility(View.INVISIBLE);
        bar.setVisibility(View.GONE);
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
                tries = 0;
                loadedBase = baseOf(url);
                learnPublicUrl(loadedBase);
                bar.setVisibility(View.GONE);
                splash.setVisibility(View.GONE);
                errorBox().setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                bar.setVisibility(View.GONE);
                if (!loadedBase.isEmpty() && tries < MAX_AUTO_TRIES) {
                    tries++;
                    showSplash(R.string.retrying);
                    ui.postDelayed(() -> load(loadedBase), 2000);
                    return;
                }
                /* این آدرس جواب نداد → آدرس بعدی را امتحان کن (مثلاً آدرس عمومی به‌جای شبکهٔ مدرسه) */
                if (queueIndex + 1 < queue.size()) {
                    queueIndex++;
                    tries = 0;
                    showSplash(R.string.retrying);
                    ui.postDelayed(() -> load(queue.get(queueIndex)), 800);
                    return;
                }
                showError();
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
    }

    /** ریشهٔ آدرس یک صفحه (scheme://host:port) */
    private String baseOf(String url) {
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme() == null ? "https" : u.getScheme();
            String host = u.getHost();
            if (host == null) return url;
            int port = u.getPort();
            return scheme + "://" + host + (port > 0 ? ":" + port : "");
        } catch (Exception e) { return url; }
    }

    /** سرور خودش آدرس عمومی را اعلام می‌کند؛ همان را نگه می‌داریم تا در خانه هم وصل شود */
    private void learnPublicUrl(String base) {
        if (base == null || base.isEmpty()) return;
        new Thread(() -> {
            String body = httpGet(base + "/api/health", 3500);
            if (body == null) return;
            try {
                JSONObject j = new JSONObject(body);
                String pub = normalize(j.optString("public_url", ""));
                if (!pub.isEmpty() && !pub.equals(base)) prefs.edit().putString(KEY_PUBLIC, pub).apply();
            } catch (Exception ignored) { }
        }).start();
    }

    /** سیستم مدرسه خاموش است؟ همان صفحه‌ای که آخرین بار باز شد از کش نمایش داده می‌شود. */
    private void showOffline() {
        String last = prefs.getString(KEY_LAST, "");
        if (last.isEmpty()) last = prefs.getString(KEY_URL, "");
        if (last.isEmpty()) last = prefs.getString(KEY_PUBLIC, "");
        if (last.isEmpty()) {
            android.widget.Toast.makeText(this, R.string.offline_empty, android.widget.Toast.LENGTH_LONG).show();
            return;
        }
        /* فقط از کش بخوان تا وقتی شبکه نیست، WebView خطای شبکه نشان ندهد */
        web.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
        load(last);
    }

    private void load(String url) {
        if (url == null || url.isEmpty()) { connect(false); return; }
        loadedBase = url;
        prefs.edit().putString(KEY_LAST, url).apply();
        showSplash(R.string.connecting);
        bar.setVisibility(View.VISIBLE);
        web.loadUrl(url);
    }

    private String normalize(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.isEmpty()) return "";
        /* مقدارهای نمونه/جای‌نگهدار را نادیده بگیر */
        String low = u.toLowerCase();
        if (low.contains("xxxx") || low.contains("example") || low.contains("<") || low.contains(">") || low.contains("mySchool".toLowerCase())) return "";
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
            /* شبکهٔ محلی http است، اینترنت https */
            boolean local = u.matches("^(localhost|[0-9.]+)(:.*)?$") || u.startsWith("192.168.") || u.startsWith("10.");
            u = (local ? "http://" : "https://") + u;
        }
        if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    /** فقط برای حالت اضطراری: پرسیدن آدرس از کاربر */
    private void askServer() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(R.string.server_hint);
        input.setText(prefs.getString(KEY_URL, BuildConfig.PAYESH_URL == null ? "" : BuildConfig.PAYESH_URL));
        input.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
        int pad = dp(16);
        input.setPadding(pad, pad, pad, pad);

        new AlertDialog.Builder(this)
            .setTitle(R.string.server_title)
            .setMessage(R.string.server_help_short)
            .setView(input)
            .setPositiveButton(R.string.save, (d, w) -> {
                String u = normalize(input.getText().toString());
                if (u.isEmpty()) { Toast.makeText(this, R.string.server_hint, Toast.LENGTH_LONG).show(); return; }
                prefs.edit().putString(KEY_URL, u).apply();
                connect(false);
            })
            .setNeutralButton(R.string.clear, (d, w) -> {
                prefs.edit().remove(KEY_URL).remove(KEY_REMOTE).remove(KEY_PUBLIC).apply();
                connect(false);
            })
            .setNegativeButton(R.string.cancel, null)
            .show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 2, 0, R.string.reload);
        menu.add(0, 1, 1, R.string.change_server);
        return super.onCreateOptionsMenu(menu);
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) { askServer(); return true; }
        if (item.getItemId() == 2) { connect(false); return true; }
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
    protected void onPause() { super.onPause(); web.onPause(); }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        /* اگر برگشتیم و هنوز وصل نشده بود، یک‌بار دیگر تلاش کن */
        if (web.getUrl() == null && !scanning) connect(false);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
