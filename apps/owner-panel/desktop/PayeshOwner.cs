// ═══════════════════════════════════════════════════════════════════
//  پوستهٔ ویندوز پنل مالک — ADR‑62 (استثنای WebView فقط برای پنل مالک)
//  · جدا از اپ مدرسه (desktop/PayeshApp.cs)؛ هیچ کدی از آن مشترک نیست.
//  · فقط مبدأ واردشده در اولین اجرا؛ ناوبری/پنجرهٔ جدید/دانلود خارج از
//    مبدأ مسدود؛ خطای گواهی ⇒ لغو؛ بدون host object، web message و DevTools.
//  · هیچ آدرس، توکن یا کلیدی در برنامه نیست؛ مبدأ در
//    %LOCALAPPDATA%\PayeshOwner\origin.txt نگه داشته می‌شود.
//  · کامپایل با csc نسخهٔ .NET Framework (C# 5) — بدون نحو جدید.
// ═══════════════════════════════════════════════════════════════════
using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PayeshOwner
{
    public static class OriginPolicy
    {
        // آدرس ورودی کاربر ⇒ مبدأ استاندارد؛ نامعتبر ⇒ null
        public static string Normalize(string raw)
        {
            if (raw == null) return null;
            string s = raw.Trim();
            if (s.Length == 0 || s.Length > 269) return null;
            if (s.EndsWith("/")) s = s.Substring(0, s.Length - 1);
            Uri u;
            if (!Uri.TryCreate(s, UriKind.Absolute, out u)) return null;
            if (u.AbsolutePath != "/" || u.Query.Length > 0 || u.Fragment.Length > 0) return null;
            if (s.IndexOf('?') >= 0 || s.IndexOf('#') >= 0) return null;
            return OriginOf(u);
        }

        static string OriginOf(Uri u)
        {
            if (u == null || !u.IsAbsoluteUri) return null;
            if (!string.IsNullOrEmpty(u.UserInfo)) return null;
            string scheme = u.Scheme.ToLowerInvariant();
            string host = u.Host.ToLowerInvariant();
            if (host.Length == 0) return null;
            bool loopback = host == "localhost" || host == "127.0.0.1";
            if (scheme == "https") { }
            else if (scheme == "http" && loopback) { }
            else return null;
            return scheme + "://" + host + (u.IsDefaultPort ? "" : ":" + u.Port);
        }

        public static bool SameOrigin(string url, string origin)
        {
            if (url == null || origin == null) return false;
            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u)) return false;
            string o = OriginOf(u);
            return o != null && o == origin;
        }
    }

    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest.Run();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ShellForm());
            return 0;
        }
    }

    // همان موارد OriginPolicyCheck.java؛ در CI روی خودِ exe ساخته‌شده اجرا می‌شود
    static class SelfTest
    {
        static int n, f;
        static void Eq(object a, object b)
        {
            n++;
            if (a == null ? b != null : !a.Equals(b)) { f++; Console.Error.WriteLine("FAIL " + a + " != " + b); }
        }
        public static int Run()
        {
            Eq(OriginPolicy.Normalize("https://OWNER.A.B/"), "https://owner.a.b");
            Eq(OriginPolicy.Normalize(" https://a.b:8443 "), "https://a.b:8443");
            Eq(OriginPolicy.Normalize("https://a.b:443"), "https://a.b");
            Eq(OriginPolicy.Normalize("http://localhost:8095"), "http://localhost:8095");
            Eq(OriginPolicy.Normalize("http://127.0.0.1:8095/"), "http://127.0.0.1:8095");
            Eq(OriginPolicy.Normalize("http://owner.a.b"), null);
            Eq(OriginPolicy.Normalize("https://a.b/path"), null);
            Eq(OriginPolicy.Normalize("https://a.b/?q=1"), null);
            Eq(OriginPolicy.Normalize("https://u:p@a.b"), null);
            Eq(OriginPolicy.Normalize("javascript:alert(1)"), null);
            Eq(OriginPolicy.Normalize("file:///etc/passwd"), null);
            Eq(OriginPolicy.Normalize(""), null);
            Eq(OriginPolicy.Normalize("a.b"), null);
            Eq(OriginPolicy.SameOrigin("https://a.b/x/y?z#q", "https://a.b"), true);
            Eq(OriginPolicy.SameOrigin("https://a.b:443/x", "https://a.b"), true);
            Eq(OriginPolicy.SameOrigin("https://a.b.x/", "https://a.b"), false);
            Eq(OriginPolicy.SameOrigin("http://a.b/", "https://a.b"), false);
            Eq(OriginPolicy.SameOrigin("https://a.b:8443/", "https://a.b"), false);
            Eq(OriginPolicy.SameOrigin("https://evil@a.b/", "https://a.b"), false);
            Eq(OriginPolicy.SameOrigin(null, "https://a.b"), false);
            Eq(OriginPolicy.SameOrigin("https://a.b/", null), false);
            Console.WriteLine("ORIGIN-POLICY-CS checks=" + n + " failures=" + f);
            return f == 0 ? 0 : 1;
        }
    }

    sealed class ShellForm : Form
    {
        readonly string dataDir;
        readonly string originFile;
        readonly WebView2 view;
        string origin;

        public ShellForm()
        {
            Text = "پنل مالک پایش";
            RightToLeft = RightToLeft.Yes;
            RightToLeftLayout = true;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1280, 820);
            MinimumSize = new Size(800, 560);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PayeshOwner");
            originFile = Path.Combine(dataDir, "origin.txt");
            Directory.CreateDirectory(dataDir);

            var menu = new MenuStrip { RightToLeft = RightToLeft.Yes };
            var reload = new ToolStripMenuItem("بارگذاری دوباره");
            reload.Click += delegate { if (view.CoreWebView2 != null && origin != null) view.CoreWebView2.Reload(); };
            var change = new ToolStripMenuItem("تغییر آدرس سرور");
            change.Click += delegate { AskOrigin(true); };
            menu.Items.Add(reload);
            menu.Items.Add(change);

            view = new WebView2 { Dock = DockStyle.Fill };
            view.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = Path.Combine(dataDir, "WebView2") };
            Controls.Add(view);
            Controls.Add(menu);
            MainMenuStrip = menu;
            Load += OnLoadAsync;
        }

        async void OnLoadAsync(object sender, EventArgs e)
        {
            try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this, "موتور نمایش Microsoft Edge WebView2 روی این ویندوز نصب نیست.\nآن را از سایت مایکروسافت نصب کنید و دوباره برنامه را باز کنید.",
                    Text, MessageBoxButtons.OK, MessageBoxIcon.Error, MessageBoxDefaultButton.Button1, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
                Close();
                return;
            }
            await view.EnsureCoreWebView2Async(null);
            var core = view.CoreWebView2;
            var s = core.Settings;
            s.AreDevToolsEnabled = false;
            s.AreHostObjectsAllowed = false;
            s.IsWebMessageEnabled = false;
            s.IsStatusBarEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = true;
            core.NavigationStarting += delegate (object o, CoreWebView2NavigationStartingEventArgs a)
            {
                if (!OriginPolicy.SameOrigin(a.Uri, origin)) a.Cancel = true;
            };
            core.FrameNavigationStarting += delegate (object o, CoreWebView2NavigationStartingEventArgs a)
            {
                if (!OriginPolicy.SameOrigin(a.Uri, origin)) a.Cancel = true;
            };
            core.NewWindowRequested += delegate (object o, CoreWebView2NewWindowRequestedEventArgs a) { a.Handled = true; };
            core.DownloadStarting += delegate (object o, CoreWebView2DownloadStartingEventArgs a) { a.Cancel = true; };
            core.PermissionRequested += delegate (object o, CoreWebView2PermissionRequestedEventArgs a) { a.State = CoreWebView2PermissionState.Deny; };
            core.ServerCertificateErrorDetected += delegate (object o, CoreWebView2ServerCertificateErrorDetectedEventArgs a)
            {
                a.Action = CoreWebView2ServerCertificateErrorAction.Cancel;
            };

            string saved = null;
            try { if (File.Exists(originFile)) saved = File.ReadAllText(originFile, Encoding.UTF8); } catch { }
            origin = OriginPolicy.Normalize(saved);
            if (origin == null) AskOrigin(false);
            else core.Navigate(origin + "/");
        }

        void AskOrigin(bool cancellable)
        {
            while (true)
            {
                string input = Prompt(origin ?? "");
                if (input == null)
                {
                    if (cancellable) return;
                    Close();
                    return;
                }
                string o = OriginPolicy.Normalize(input);
                if (o == null)
                {
                    MessageBox.Show(this, "آدرس نامعتبر است؛ فقط https://دامنه[:درگاه] پذیرفته می‌شود.", Text,
                        MessageBoxButtons.OK, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button1, MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
                    continue;
                }
                if (origin != null && o != origin && view.CoreWebView2 != null)
                {
                    // نشست سرور قبلی پاک می‌شود
                    view.CoreWebView2.CookieManager.DeleteAllCookies();
                }
                origin = o;
                try { File.WriteAllText(originFile, o, new UTF8Encoding(false)); } catch { }
                if (view.CoreWebView2 != null) view.CoreWebView2.Navigate(o + "/");
                return;
            }
        }

        string Prompt(string current)
        {
            using (var f = new Form())
            {
                f.Text = "آدرس سرور پنل مالک";
                f.RightToLeft = RightToLeft.Yes;
                f.RightToLeftLayout = true;
                f.FormBorderStyle = FormBorderStyle.FixedDialog;
                f.StartPosition = FormStartPosition.CenterParent;
                f.MinimizeBox = false;
                f.MaximizeBox = false;
                f.ClientSize = new Size(480, 150);
                var help = new Label { Text = "فقط آدرس HTTPS (بدون مسیر). برنامه فقط همین مبدأ را باز می‌کند.", AutoSize = false, Bounds = new Rectangle(12, 12, 456, 36) };
                var box = new TextBox { Text = current, Bounds = new Rectangle(12, 52, 456, 24), RightToLeft = RightToLeft.No };
                var ok = new Button { Text = "ذخیره", DialogResult = DialogResult.OK, Bounds = new Rectangle(12, 100, 100, 30) };
                var cancel = new Button { Text = "انصراف", DialogResult = DialogResult.Cancel, Bounds = new Rectangle(120, 100, 100, 30) };
                f.Controls.AddRange(new Control[] { help, box, ok, cancel });
                f.AcceptButton = ok;
                f.CancelButton = cancel;
                return f.ShowDialog(this) == DialogResult.OK ? box.Text : null;
            }
        }
    }
}
