package ir.payesh.owner;

import java.net.URI;
import java.util.Locale;

/**
 * قفل مبدأ پوستهٔ پنل مالک — ADR‑62 §۳.
 * بدون وابستگی Android تا با javac ساده هم آزموده شود.
 *  · فقط https://host[:port]  (بدون مسیر/پرس‌وجو/fragment/userinfo)
 *  · استثنا: http فقط برای localhost و 127.0.0.1 (توسعه)
 */
public final class OriginPolicy {
    private OriginPolicy() {}

    /** آدرس ورودی کاربر را به مبدأ استاندارد تبدیل می‌کند؛ نامعتبر ⇒ null. */
    public static String normalize(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty() || s.length() > 253 + 16) return null;
        if (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        URI u;
        try { u = new URI(s); } catch (Exception e) { return null; }
        return originOf(u, true);
    }

    /** مبدأ یک URL کامل؛ اگر strict باشد مسیر/پرس‌وجو مجاز نیست. */
    static String originOf(URI u, boolean strict) {
        if (u == null || !u.isAbsolute() || u.isOpaque()) return null;
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        String host = u.getHost();
        if (host == null || host.isEmpty()) return null;
        host = host.toLowerCase(Locale.ROOT);
        if (u.getRawUserInfo() != null) return null;
        if (strict) {
            String path = u.getRawPath();
            if (path != null && !path.isEmpty() && !path.equals("/")) return null;
            if (u.getRawQuery() != null || u.getRawFragment() != null) return null;
        }
        boolean loopback = host.equals("localhost") || host.equals("127.0.0.1");
        if (scheme.equals("https")) {
            // ok
        } else if (scheme.equals("http") && loopback) {
            // ok — فقط توسعه
        } else {
            return null;
        }
        int port = u.getPort();
        int def = scheme.equals("https") ? 443 : 80;
        if (port == def) port = -1;
        if (port != -1 && (port < 1 || port > 65535)) return null;
        return scheme + "://" + host + (port == -1 ? "" : ":" + port);
    }

    /** آیا url دقیقاً روی همان مبدأ مجاز است؟ */
    public static boolean sameOrigin(String url, String origin) {
        if (url == null || origin == null) return false;
        try {
            String o = originOf(new URI(url), false);
            return o != null && o.equals(origin);
        } catch (Exception e) {
            return false;
        }
    }
}
