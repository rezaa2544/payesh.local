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
import android.webkit.WebResourceResponse;
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
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * اپلیکیشن کامل اندرویدِ پایش — «همه‌چیز داخل خود گوشی».
 *
 * برخلاف نسخهٔ قدیمی (پوستهٔ مرورگر که آدرس سرور را باز می‌کرد)، این‌جا تمام
 * فایل‌های برنامه (HTML/JS/CSS/آیکون‌ها + موتور همگام‌سازی و کش آفلاین) داخل
 * خودِ APK است و از یک مبدأ امن محلی سرو می‌شود:
 *
 *      https://appassets.androidplatform.net/assets/www/index.html
 *
 * چرا این مبدأ؟ چون سرویس‌ورکر، localStorage و IndexedDB فقط روی https کار
 * می‌کنند و file:// این‌ها را نمی‌دهد. (Service Worker در حالت بسته‌بندی لازم
 * نیست و کلاینت خودش غیرفعالش می‌کند.)
 *
 * اتصال به سرور:
 *   - آدرس سرور (مدرسه یا آدرس عمومی) یک‌بار پیدا می‌شود:
 *       ۱) آدرسی که قبلاً ذخیره شده  ۲) آدرس پخته‌شده در APK
 *       ۳) android-config.json مخزن  ۴) جست‌وجوی خودکار در شبکهٔ محلی
 *   - سپس به صفحهٔ محلی تزریق می‌شود:  window.PAYESH_API_BASE = "https://…"
 *   - اگر هیچ سروری پیدا نشد، برنامه باز هم بالا می‌آید و آخرین دادهٔ ذخیره‌شده
 *     را نشان می‌دهد (هیچ صفحهٔ بن‌بستی وجود ندارد).
 */
public class MainActivity extends Activity {

    private static final String PREFS = "payesh";
    private static final String KEY_URL = "server_url";       /* آدرس انتخاب‌شده */
    private static final String KEY_REMOTE = "config_url";    /* آخرین آدرسِ گرفته‌شده از پیکربندی مرکزی */
    private static final String KEY_LAST = "last_url";        /* آخرین نشانی‌ای که واقعاً باز شد */
    private static final String KEY_PUBLIC = "public_url";    /* آدرس عمومی که خود سرور اعلام کرده */

    /* میزبان محلیِ دارایی‌های برنامه (فقط داخل خود برنامه) */
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_ORIGIN = "https://" + APP_HOST;
    private static final String APP_URL = APP_ORIGIN + "/assets/www/index.html";

    /* پیکربندی مرکزی: تغییر آدرس بدون نیاز به ساخت دوبارهٔ برنامه */
    private static final String[] CONFIG_URLS = {
        "https://raw.githubusercontent.com/rezaa2544/payesh.local/main/android-config.json",
        "https://cdn.jsdelivr.net/gh/rezaa2544/payesh.local@main/android-config.json",
    };

    private static final int FILE_PICK = 1001;

    private WebView web;
    private ProgressBar bar;
    private TextView errorView;
    private Button errorButton;
    private LinearLayout splash;
    private TextView splashText;
    private ValueCallback<Uri[]> filePathCallback;

    private SharedPreferences prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean scanning = false;
    private java.util.List<String> queue = new java.util.ArrayList<>();
    private int queueIndex = 0;

    /** آدرس سرور مدرسه — به صفحهٔ محلی تزریق می‌شود */
    private String apiBase = "";
    /** آدرسی که همین حالا در حال بررسی است (برای تلاش دوباره) */
    private String loadedBase = "";
    /** کش دارایی‌ها در حافظه تا هر بار از دیسک خوانده نشود */
    private final Map<String, byte[]> assetCache = new HashMap<>();

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

        /* صفحهٔ خطا — فقط برای حالت‌های بعید (دارایی‌ها خراب نصب شده باشند) */
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
        errorButton.setOnClickListener(v -> boot());
        errBox.addView(errorButton);
        Button findButton = new Button(this);
        findButton.setText(R.string.find_lan);
        findButton.setOnClickListener(v -> scanLan());
        errBox.addView(findButton);
        Button setButton = new Button(this);
        setButton.setText(R.string.set_manual);
        setButton.setOnClickListener(v -> askServer());
        errBox.addView(setButton);
        frame.addView(errBox, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        errorView.setTag(errBox);

        setContentView(root);
        setupWebView();

        boot();
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    /* ── راه‌اندازی: پیدا کردن سرور، سپس باز کردنِ برنامهٔ محلی ─────────── */

    private void boot() {
        showSplash(R.string.connecting);
        queue = candidates();
        queueIndex = 0;
        if (!queue.isEmpty()) { verifyThenOpen(queue.get(0)); return; }
        fetchRemoteConfig(url -> {
            if (url != null && !url.isEmpty()) {
                prefs.edit().putString(KEY_REMOTE, url).apply();
                queue = candidates();
                queueIndex = 0;
                if (!queue.isEmpty()) { verifyThenOpen(queue.get(0)); return; }
            }
            showSplash(R.string.searching);
            scanLan();
        });
    }

    /** آدرس را سریع بررسی می‌کند؛ اگر جواب نداد، سراغ بعدی می‌رود؛ در پایان برنامه را آفلاین باز می‌کند */
    private void verifyThenOpen(String base) {
        if (base == null || base.isEmpty()) { openApp(""); return; }
        showSplash(R.string.connecting);
        new Thread(() -> {
            String body = httpGet(base + "/api/health", 2500);
            boolean ok = body != null && body.contains("payesh-local");
            ui.post(() -> {
                if (ok) {
                    prefs.edit().putString(KEY_URL, base).putString(KEY_LAST, base).apply();
                    learnPublicUrl(base);
                    openApp(base);
                } else if (queueIndex + 1 < queue.size()) {
                    queueIndex++;
                    verifyThenOpen(queue.get(queueIndex));
                } else {
                    /* هیچ سروری نبود → همان برنامه، ولی آفلاین (دادهٔ ذخیره‌شده) */
                    openApp(prefs.getString(KEY_URL, ""));
                }
            });
        }).start();
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
        for (String raw : prefs.getString(KEY_REMOTE, "").split("\n")) {
            String u = normalize(raw);
            if (!u.isEmpty() && !out.contains(u)) out.add(u);
        }
        return out;
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
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
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

    /** باز کردن برنامهٔ کاملِ داخل گوشی، با آدرس سروری که پیدا شد (یا خالی = آفلاین) */
    private void openApp(String base) {
        apiBase = base == null ? "" : base;
        splash.setVisibility(View.GONE);
        errorBox().setVisibility(View.GONE);
        bar.setVisibility(View.VISIBLE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(APP_URL);
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
                            prefs.edit().putString(KEY_URL, base).putString(KEY_LAST, base).apply();
                            ui.post(() -> { learnPublicUrl(base); openApp(base); });
                        }
                    });
                }
                pool.shutdown();
                try { pool.awaitTermination(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
                if (hit.get()) { scanning = false; return; }
                found = null;
            }
            scanning = false;
            final String last = prefs.getString(KEY_URL, "");
            ui.post(() -> {
                if (!last.isEmpty()) { openApp(last); return; }
                openApp("");   /* آفلاین، ولی برنامه بالا می‌آید */
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
                        if (ip == null) continue;
                        if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) return ip;
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

    /* ── سرو دارایی‌های برنامه از داخل APK ───────────────────────────── */

    private byte[] asset(String path) {
        if (assetCache.containsKey(path)) return assetCache.get(path);
        try (InputStream in = getAssets().open("www/" + path)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            byte[] data = out.toByteArray();
            assetCache.put(path, data);
            return data;
        } catch (IOException e) {
            return null;
        }
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    /** پاسخی که WebView برای درخواست‌های میزبانِ محلی می‌گیرد */
    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.isEmpty() || path.equals("/")) path = "index.html";
        path = path.replaceFirst("^/+", "");
        if (path.startsWith("api/")) {
            /* برنامه داخل گوشی است؛ آدرس‌های API فقط از سرور می‌آیند */
            return new WebResourceResponse("application/json", "utf-8",
                new ByteArrayInputStream("{\"ok\":false,\"error\":\"offline\"}".getBytes(StandardCharsets.UTF_8)));
        }
        byte[] body = asset(path);
        if (body == null && !path.contains(".")) body = asset("index.html");   /* مسیرهای SPA */
        if (body == null) {
            return new WebResourceResponse("text/plain", "utf-8",
                new ByteArrayInputStream("not found".getBytes(StandardCharsets.UTF_8)));
        }
        if (path.endsWith("index.html")) {
            /* آدرس سرور و حالت «بسته‌بندی‌شده» را به برنامه تزریق می‌کنیم */
            String html = new String(body, StandardCharsets.UTF_8);
            String inject = "<script>window.PAYESH_API_BASE=" + JSONObject.quote(apiBase)
                + ";window.PAYESH_BUNDLED=true;</script>";
            html = html.contains("<head>") ? html.replace("<head>", "<head>" + inject) : inject + html;
            body = html.getBytes(StandardCharsets.UTF_8);
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        WebResourceResponse res = new WebResourceResponse(mimeOf(path), "utf-8", new ByteArrayInputStream(body));
        res.setResponseHeaders(headers);
        return res;
    }

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
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
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u != null && APP_HOST.equalsIgnoreCase(u.getHost())) {
                    String p = u.getPath();
                    if (p != null && p.startsWith("/assets/www")) p = p.substring("/assets/www".length());
                    return serveAsset(p);
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url == null) return false;
                if (url.startsWith(APP_ORIGIN)) return false;
                if (url.startsWith("http://") || url.startsWith("https://")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                bar.setVisibility(View.GONE);
                splash.setVisibility(View.GONE);
                errorBox().setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                /* دارایی‌های محلی باید همیشه باز شوند؛ اگر نشد، یک‌بار دیگر */
                bar.setVisibility(View.GONE);
                ui.postDelayed(() -> {
                    if (web.getUrl() == null) showError();
                }, 1200);
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

    /** سیستم مدرسه خاموش است؟ برنامه با آخرین دادهٔ ذخیره‌شده باز می‌شود. */
    private void showOffline() {
        String last = prefs.getString(KEY_LAST, "");
        if (last.isEmpty()) last = prefs.getString(KEY_URL, "");
        if (last.isEmpty()) last = prefs.getString(KEY_PUBLIC, "");
        web.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
        openApp(last);
    }

    private String normalize(String raw) {
        String u = raw == null ? "" : raw.trim();
        if (u.isEmpty()) return "";
        String low = u.toLowerCase();
        if (low.contains("xxxx") || low.contains("example") || low.contains("<") || low.contains(">") || low.contains("myschool")) return "";
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
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
                queue = candidates();
                queueIndex = 0;
                verifyThenOpen(u);
            })
            .setNeutralButton(R.string.clear, (d, w) -> {
                prefs.edit().remove(KEY_URL).remove(KEY_REMOTE).remove(KEY_PUBLIC).apply();
                boot();
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
        if (item.getItemId() == 2) { boot(); return true; }
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
        if (web.getUrl() == null && !scanning) boot();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
