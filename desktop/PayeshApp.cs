// ═══════════════════════════════════════════════════════════════════
//  پایش — برنامهٔ ویندوز (پنجرهٔ واقعی، بدون مرورگر)
//  ───────────────────────────────────────────────────────────────────
//  • اگر روی «سیستم مدرسه» نصب شده باشد: خودش سرور را بالا می‌آورد،
//    منتظر آماده شدنش می‌ماند و بعد پنجره را نشان می‌دهد.
//  • اگر روی سیستم کاربر باشد: به همان سامانه (آدرس عمومی یا شبکهٔ مدرسه)
//    وصل می‌شود — هیچ آدرسی هم لازم نیست تایپ شود، مگر در آخرین حالت.
//  • نمایش با WebView2 (همان موتور Edge، اما بدون نوار آدرس و تب).
//    اگر WebView2 نصب نباشد، با حالت «برنامه»ی Edge و در نهایت مرورگر باز می‌شود.
//
//  ساخت: desktop\build.ps1  →  Payesh.exe
// ═══════════════════════════════════════════════════════════════════
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Payesh
{
    internal static class Program
    {
        private static Mutex _mutex;
        internal static EventWaitHandle ShowSignal;

        [STAThread]
        private static void Main(string[] args)
        {
            bool created;
            _mutex = new Mutex(true, @"Local\PayeshDesktopApp", out created);
            if (!created)
            {
                /* برنامه از قبل باز است (مثلاً از اجرای خودکار ویندوز) → همان پنجره را بیاور
                   جلو؛ پیام «همین حالا باز است» بی‌فایده بود چون پنجره در سینی پنهان است. */
                try
                {
                    EventWaitHandle h;
                    if (EventWaitHandle.TryOpenExisting(@"Local\PayeshShow", out h))
                    {
                        h.Set();
                        h.Dispose();
                    }
                }
                catch { }
                return;
            }

            try { ShowSignal = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\PayeshShow"); }
            catch { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var shell = new Shell(args);

            if (ShowSignal != null)
            {
                var t = new Thread(() =>
                {
                    while (true)
                    {
                        try { if (!ShowSignal.WaitOne()) break; }
                        catch { break; }
                        shell.BringToFrontFromSecond();
                    }
                });
                t.IsBackground = true;
                t.Start();
            }

            Application.Run(shell);
        }
    }

    internal sealed class Shell : Form
    {
        /* آدرس محلی: پورت ثابت نیست. اگر برنامهٔ دیگری ۸۰۸۰ را گرفته باشد،
           سامانه روی پورت آزاد بعدی بالا می‌آید؛ وگرنه کاربر پیام
           «Hmmm... can't reach this page» می‌دید. */
        private static string LocalUrl = "http://127.0.0.1:8080";
        private static int _localPort = 8080;
        private static readonly int[] PORT_CANDIDATES = { 8080, 8090, 8091, 8092, 8093 };
        /* همان فایل پیکربندی که اپ اندروید می‌خواند — یک جای مشخص برای آدرس عمومی */
        private const string RemoteConfig =
            "https://raw.githubusercontent.com/rezaa2544/payesh.local/main/android-config.json";
        private readonly string _baseDir;
        private readonly string _appDir;
        private bool _serverMode;
        private readonly string _settingsFile;
        private readonly object _serverLock = new object();
        private Process _serverSupervisor;
        private volatile bool _closing;

        private WebView2 _view;
        private Panel _splash;
        private Panel _error;
        private Label _statusLabel;
        private Label _errorLabel;
        private Label _diagLabel;
        private Panel _offlineBar;
        private TextBox _addrBox;
        private NotifyIcon _tray;
        private string _dataDir = "";
        private string _currentUrl = "";
        private string _learnedPublic = "";
        private bool _reallyExit;
        private bool _trayMode;
        private int _connectToken;
        private ulong _activeNavigationId;
        private volatile bool _pageHealthy;
        /* نگهبان سرور و صفحه: اگر سامانه وسط کار بخوابد، دوباره بالا می‌آید
           و پنجره هرگز صفحهٔ خطای مرورگر را نشان نمی‌دهد. */
        private System.Windows.Forms.Timer _watch;
        private int _navFails;
        private int _restarting;
        private bool _runtimeTried;

        public Shell(string[] args)
        {
            _baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            /* برنامه در {app}\desktop می‌نشیند و سرور در {app}\server → ریشهٔ نصب یک پله بالاتر است.
               این نکته در نسخهٔ 0.4.2 فراموش شده بود و برنامه اشتباهاً «حالت کاربر» می‌شد. */
            _appDir = ResolveRoot(_baseDir);
            _dataDir = ResolveDataDir();
            MigrateDataIfNeeded();
            _settingsFile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Payesh", "settings.ini");
            /* همان پورت ذخیره‌شده را از ابتدا هدف می‌گیریم؛ در غیر این صورت هر اجرای
               دوباره ممکن بود 8080 را خالی ببیند، ولی سرورِ قبلی روی 8090 بماند و
               یک نمونهٔ دوم بسازد. */
            int savedPort;
            if (int.TryParse(ReadIni(_settingsFile, "port"), out savedPort)
                && Array.IndexOf(PORT_CANDIDATES, savedPort) >= 0)
            {
                _localPort = savedPort;
                LocalUrl = "http://127.0.0.1:" + savedPort;
            }

            bool forceClient = Array.IndexOf(args, "--client") >= 0;
            bool forceServer = Array.IndexOf(args, "--server") >= 0;
            _trayMode = Array.IndexOf(args, "--tray") >= 0;
            string role = ReadIni(Path.Combine(_appDir, "payesh.ini"), "role");
            bool hasServer = File.Exists(Path.Combine(_appDir, "server", "index.js"));
            /* قاعدهٔ ساده و بی‌سؤال: هر رایانه‌ای که فایل‌های سرور را دارد، خودِ سیستم مدرسه است.
               «حالت کاربر» فقط وقتی است که مدیر خودش این رایانه را کاربر اعلام کرده باشد
               (تیک نصب یا میان‌بر --client). تنظیم چسبندهٔ قدیمی mode=client دیگر باعث
               نمی‌شود سیستم مدرسه برای همیشه «کاربر» بماند. */
            bool hasDb = File.Exists(Path.Combine(_dataDir, "payesh.sqlite"));
            bool hasAnyTarget = ReadIni(_settingsFile, "server_url").Length > 0
                || ReadIni(_settingsFile, "last_url").Length > 0;
            /* «کاربر» فقط وقتی معنا دارد که آدرسی برای اتصال داشته باشد؛ رایانهٔ بی‌آدرس
               که فایل‌های سرور را دارد، خودِ سیستم مدرسه است. */
            _serverMode = forceServer ? true
                : forceClient ? false
                : hasServer && (role != "client" || hasDb || !hasAnyTarget);

            Log("start base=" + _baseDir + " root=" + _appDir + " role=" + role
                + " serverMode=" + _serverMode + " node=" + (NodePath() ?? "(none)")
                + " serverJs=" + File.Exists(Path.Combine(_appDir, "server", "index.js")));

            BuildUi();
            if (_trayMode)
            {
                ShowInTaskbar = false;
                WindowState = FormWindowState.Minimized;
            }
            StartConnect();
        }

        /* ── ساخت پنجره ─────────────────────────────────────────────── */
        private void BuildUi()
        {
            Text = "پایش — سامانهٔ مدرسه";
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1240, 880);
            MinimumSize = new Size(900, 640);
            BackColor = Color.FromArgb(11, 27, 51);
            RightToLeft = RightToLeft.Yes;
            RightToLeftLayout = true;
            try
            {
                string ico = Path.Combine(_appDir, "payesh.ico");
                if (File.Exists(ico)) Icon = new Icon(ico);
            }
            catch { }

            _splash = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(11, 27, 51) };

            var logo = new Label
            {
                Text = "پایش",
                ForeColor = Color.White,
                Font = new Font("Tahoma", 34f, FontStyle.Bold),
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Dock = DockStyle.Top,
                Height = 120,
            };
            var sub = new Label
            {
                Text = "سامانهٔ مدیریت مدرسه",
                ForeColor = Color.FromArgb(185, 198, 218),
                Font = new Font("Tahoma", 11f),
                Dock = DockStyle.Top,
                Height = 30,
                TextAlign = ContentAlignment.MiddleCenter,
            };
            _statusLabel = new Label
            {
                Text = "در حال آماده‌سازی…",
                ForeColor = Color.FromArgb(220, 230, 245),
                Font = new Font("Tahoma", 11f),
                Dock = DockStyle.Top,
                Height = 34,
                TextAlign = ContentAlignment.MiddleCenter,
            };
            var bar = new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 26,
                Height = 6,
                Dock = DockStyle.Top,
                Margin = new Padding(240, 0, 240, 0),
            };
            var hint = new Label
            {
                Text = "این پنجره بسته می‌شود به‌صورت برنامه در سینی سیستم ادامه می‌دهد؛ برای خروج کامل از آیکون کنار ساعت استفاده کنید.",
                ForeColor = Color.FromArgb(140, 158, 184),
                Font = new Font("Tahoma", 8.5f),
                Dock = DockStyle.Bottom,
                Height = 40,
                TextAlign = ContentAlignment.MiddleCenter,
            };

            var barWrap = new Panel { Dock = DockStyle.Top, Height = 18, Padding = new Padding(220, 6, 220, 6) };
            barWrap.Controls.Add(bar);

            _splash.Controls.Add(hint);
            _splash.Controls.Add(barWrap);
            _splash.Controls.Add(_statusLabel);
            _splash.Controls.Add(sub);
            _splash.Controls.Add(logo);
            Controls.Add(_splash);

            /* نوار «آفلاین» بالای صفحه */
            _offlineBar = new Panel
            {
                Dock = DockStyle.Top,
                Height = 30,
                BackColor = Color.FromArgb(120, 53, 15),
                Visible = false,
            };
            _offlineBar.Controls.Add(new Label
            {
                Text = "حالت آفلاین — سیستم مدرسه در دسترس نیست؛ نمایش آخرین اطلاعات ذخیره‌شده. ثبت‌ها در صف می‌مانند.",
                ForeColor = Color.FromArgb(253, 230, 138),
                Font = new Font("Tahoma", 9f),
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
            });
            Controls.Add(_offlineBar);

            /* صفحهٔ خطا */
            _error = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(11, 27, 51), Visible = false };
            _errorLabel = new Label
            {
                ForeColor = Color.FromArgb(231, 237, 246),
                Font = new Font("Tahoma", 11f),
                Dock = DockStyle.Top,
                Height = 90,
                TextAlign = ContentAlignment.MiddleCenter,
                Text = "سامانهٔ مدرسه در دسترس نیست",
            };
            _addrBox = new TextBox
            {
                Width = 460,
                TextAlign = HorizontalAlignment.Left,
                RightToLeft = RightToLeft.No,
                Font = new Font("Tahoma", 10f),
                Text = ReadIni(_settingsFile, "server_url"),
            };
            var addrRow = new FlowLayoutPanel
            {
                Dock = DockStyle.Top, Height = 44, FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false, Padding = new Padding(0, 8, 0, 0),
            };
            addrRow.Controls.Add(MakeButton("ذخیرهٔ آدرس", (s, e) => SaveAddress()));
            addrRow.Controls.Add(_addrBox);

            _diagLabel = new Label
            {
                ForeColor = Color.FromArgb(150, 168, 194),
                Font = new Font("Tahoma", 8.5f),
                Dock = DockStyle.Top,
                Height = 78,
                TextAlign = ContentAlignment.MiddleCenter,
                Text = "",
            };

            var btnRow = new FlowLayoutPanel
            {
                Dock = DockStyle.Top, Height = 56, FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false, Padding = new Padding(0, 12, 0, 0),
            };
            btnRow.Controls.Add(MakeButton("نمایش آخرین وضعیت (آفلاین)", (s, e) => { ShowOffline(); }));
            btnRow.Controls.Add(MakeButton("روشن کردن سامانه در همین رایانه", (s, e) => { ForceServerMode(); }));
            btnRow.Controls.Add(MakeButton("تلاش دوباره", (s, e) => StartConnect()));
            btnRow.Controls.Add(MakeButton("جستجوی شبکهٔ مدرسه", (s, e) => { SearchLanNow(); }));
            btnRow.Controls.Add(MakeButton("نصب موتور نمایش", (s, e) => { _runtimeTried = false; if (TryInstallWebViewRuntime()) StartConnect(); else ShowEngineMissing(); }));

            var center = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
            center.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            center.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
            center.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            center.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            center.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));

            var box = new Panel { AutoSize = true, Dock = DockStyle.Fill };
            box.Controls.Add(addrRow);
            box.Controls.Add(btnRow);
            box.Controls.Add(_diagLabel);
            box.Controls.Add(_errorLabel);
            center.Controls.Add(new Panel(), 0, 0);
            center.Controls.Add(box, 0, 1);
            center.Controls.Add(new Panel(), 0, 2);
            _error.Controls.Add(center);
            Controls.Add(_error);

            /* آیکون سینی سیستم */
            try
            {
                _tray = new NotifyIcon
                {
                    Text = "پایش — سامانهٔ مدرسه",
                    Visible = true,
                    Icon = Icon ?? SystemIcons.Application,
                };
                var menu = new ContextMenuStrip { RightToLeft = RightToLeft.Yes };
                menu.Items.Add("باز کردن پایش", null, (s, e) => RevealWindow());
                menu.Items.Add("تشخیص و گزارش", null, (s, e) => ShowError(null));
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("خروج", null, (s, e) => { _reallyExit = true; Close(); });
                _tray.ContextMenuStrip = menu;
                _tray.DoubleClick += (s, e) => RevealWindow();
            }
            catch { }
        }


        /// <summary>محل داده — بیرون از پوشهٔ نصب تا آپدیت/نصب دوباره داده را پاک نکند.</summary>
        private string ResolveDataDir()
        {
            string env = Environment.GetEnvironmentVariable("PAYESH_DATA");
            if (!string.IsNullOrEmpty(env))
            {
                try { Directory.CreateDirectory(env); return env; } catch { }
            }
            string[] roots = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Payesh", "data"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Payesh", "data"),
            };
            foreach (string r in roots)
            {
                try
                {
                    Directory.CreateDirectory(r);
                    string probe = Path.Combine(r, ".write-test");
                    File.WriteAllText(probe, "ok");
                    File.Delete(probe);
                    return r;
                }
                catch { }
            }
            return Path.Combine(_appDir, "data");
        }

        /// <summary>اگر دادهٔ قبلی کنار برنامه بود، یک‌بار به مسیر پایدار کپی می‌شود (پاک نمی‌شود).</summary>
        private void MigrateDataIfNeeded()
        {
            try
            {
                string legacy = Path.Combine(_appDir, "data");
                string legacyDb = Path.Combine(legacy, "payesh.sqlite");
                string targetDb = Path.Combine(_dataDir, "payesh.sqlite");
                if (!File.Exists(legacyDb) || File.Exists(targetDb)) return;
                if (string.Equals(Path.GetFullPath(legacy), Path.GetFullPath(_dataDir), StringComparison.OrdinalIgnoreCase)) return;
                Directory.CreateDirectory(_dataDir);
                foreach (string f in Directory.GetFiles(legacy))
                {
                    try { File.Copy(f, Path.Combine(_dataDir, Path.GetFileName(f))); } catch { }
                }
                Log("data migrated: " + legacy + " -> " + _dataDir);
            }
            catch (Exception ex) { Log("data migrate failed: " + ex.Message); }
        }

        /// <summary>ریشهٔ نصب: پوشه‌ای که server/index.js در آن است (خود پوشه یا پوشهٔ والد).</summary>
        private static string ResolveRoot(string baseDir)
        {
            try
            {
                if (File.Exists(Path.Combine(baseDir, "server", "index.js"))) return baseDir;
                DirectoryInfo parent = Directory.GetParent(baseDir);
                if (parent != null && File.Exists(Path.Combine(parent.FullName, "server", "index.js")))
                    return parent.FullName;
            }
            catch { }
            return baseDir;
        }

        /// <summary>Node همراه بسته، وگرنه Node نصب‌شده روی سیستم.</summary>
        private string NodePath()
        {
            try
            {
                string bundled = Path.Combine(_appDir, "runtime", "node.exe");
                if (File.Exists(bundled)) return bundled;
                string[] dirs = new string[]
                {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs"),
                };
                foreach (string d in dirs)
                {
                    string cand = Path.Combine(d, "node.exe");
                    if (File.Exists(cand)) return cand;
                }
            }
            catch { }
            return null;
        }

        private static void Log(string line)
        {
            try
            {
                string file = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Payesh", "app.log");
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                string text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine;
                File.AppendAllText(file, text, Encoding.UTF8);
            }
            catch { }
        }

        private Button MakeButton(string text, EventHandler onClick)
        {
            var b = new Button
            {
                Text = text,
                AutoSize = true,
                Height = 32,
                Margin = new Padding(6, 0, 0, 0),
                BackColor = Color.FromArgb(37, 99, 235),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Tahoma", 9.5f),
            };
            b.FlatAppearance.BorderSize = 0;
            b.Click += onClick;
            return b;
        }

        /* ── اتصال ──────────────────────────────────────────────────── */
        private void StartConnect()
        {
            int token = Interlocked.Increment(ref _connectToken);
            _pageHealthy = false;
            SetStatus("در حال آماده‌سازی…");
            _splash.Visible = true;
            _splash.BringToFront();
            _error.Visible = false;

            Task.Run(async () =>
            {
                try
                {
                    /* اگر موتور نمایش نصب نباشد، همان‌جا (نه در رشتهٔ پنجره) نصبش
                       می‌کنیم تا هیچ‌وقت لازم نباشد مرورگر باز شود. */
                    if (!RuntimeReady())
                    {
                        SetStatus("نصب موتور نمایش…");
                        TryInstallWebViewRuntime();
                    }
                    if (_serverMode)
                    {
                        /* پایش را از ابتدای راه‌اندازی فعال می‌کنیم تا شکست موقتِ شروع
                           یا restart پس از آپدیت هم بدون بستن پنجره بازیابی شود. */
                        StartWatchdog();
                        /* اگر سرور قبلی روی پورت ثبت‌شده هنوز زنده است، همان را می‌گیریم؛
                           اگر پورت جابه‌جا شده باشد، پورت‌های شناخته‌شده را قبل از ساخت
                           نمونهٔ جدید می‌گردیم تا دو سرور برای یک مدرسه بالا نیایند. */
                        bool localReady = await FindLocalServer();
                        if (!localReady)
                        {
                            SetStatus("راه‌اندازی سامانه…");
                            int ownedPort = ActiveSupervisorPort();
                            if (ownedPort > 0) UseLocalPort(ownedPort, "existing supervisor");
                            else PickLocalPort();
                            StartServer();
                            for (int i = 0; i < 90 && token == _connectToken; i++)
                            {
                                if (await Up(LocalUrl)) { localReady = true; break; }
                                await Task.Delay(500);
                            }
                        }
                        if (localReady || await Up(LocalUrl))
                        {
                            StartWatchdog();
                            ShowApp(LocalUrl);
                            return;
                        }
                        SetStatus("سرور هنوز آماده نشده — تلاش خودکار ادامه دارد…");
                    }

                    foreach (string candidate in Candidates())
                    {
                        if (token != _connectToken) return;
                        SetStatus("اتصال به " + candidate);
                        if (await Up(candidate))
                        {
                            ShowApp(candidate);
                            return;
                        }
                    }

                    /* آدرس عمومی می‌تواند در مخزن به‌روز شود (بدون ساخت مجدد برنامه) */
                    if (token == _connectToken)
                    {
                        SetStatus("یافتن آدرس سامانه…");
                        List<string> remotes = await RemoteAddresses();
                        foreach (string remote in remotes)
                        {
                            if (token != _connectToken) return;
                            if (await Up(remote))
                            {
                                SaveIni(_settingsFile, "server_url", remote);
                                ShowApp(remote);
                                return;
                            }
                        }
                    }

                    SetStatus("جستجوی سامانه در شبکهٔ مدرسه…");
                    string lan = await ScanLan(token);
                    if (lan != null && token == _connectToken)
                    {
                        SaveIni(_settingsFile, "server_url", lan);
                        ShowApp(lan);
                        return;
                    }

                    if (token == _connectToken) ShowError();
                }
                catch (Exception ex)
                {
                    if (token == _connectToken) ShowError(ex.Message);
                }
            });
        }

        private List<string> Candidates()
        {
            var list = new List<string>();
            AddCandidate(list, ReadIni(_settingsFile, "server_url"));
            AddCandidate(list, ReadIni(Path.Combine(_appDir, "payesh.ini"), "server_url"));
            /* چند سرور: سیستم مدرسه + رایانه‌های پشتیبان (هر کدام روشن باشد جواب می‌دهد) */
            foreach (string extra in SplitList(ReadIni(Path.Combine(_appDir, "payesh.ini"), "urls")))
                AddCandidate(list, extra);
            AddCandidate(list, _learnedPublic);
            AddCandidate(list, ReadIni(_settingsFile, "public_url"));
            return list;
        }

        private static string[] SplitList(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return new string[0];
            return raw.Split(new char[] { ',', ';', '|', '\n', ' ' }, StringSplitOptions.RemoveEmptyEntries);
        }

        private static void AddCandidate(List<string> list, string raw)
        {
            string u = Normalize(raw);
            if (u.Length > 0 && !list.Contains(u)) list.Add(u);
        }

        private void ShowApp(string url)
        {
            _pageHealthy = false;
            _currentUrl = url;
            SaveIni(_settingsFile, "last_url", url);
            OnUi(() =>
            {
                try
                {
                    if (_view == null && !TryCreateWebView())
                    {
                        /* موتور نمایش نیست: پیام خودمان — هیچ مرورگری باز نمی‌شود */
                        ShowEngineMissing();
                        return;
                    }
                    /* تا وقتی ناوبری واقعاً موفق نشده، WebView پنهان می‌ماند؛
                       وگرنه موتور Edge صفحهٔ خام ERR_CONNECTION_REFUSED را نشان می‌دهد. */
                    _splash.Visible = true;
                    _splash.BringToFront();
                    _error.Visible = false;
                    if (_offlineBar != null) _offlineBar.Visible = false;
                    _view.Visible = false;
                    SetStatus("در حال اتصال به سامانه…");
                    try { _tray.Text = "پایش — " + new Uri(url).Host; } catch { }
                    _view.Source = new Uri(url);
                }
                catch
                {
                    ShowError("پنجرهٔ برنامه باز نشد. دوباره تلاش کنید.");
                }
            });
        }

        /* ══ پایداری: پورت آزاد، نگهبان سرور و صفحهٔ خطای خودمان ════════
           شکایت کاربر: «بعضی وقت‌ها موقع باز کردن، صفحهٔ خطای مرورگر می‌آید».
           سه ریشه داشت و هر سه بسته شد:
             ۱) اگر پورت ۸۰۸۰ را برنامهٔ دیگری گرفته بود، سرور بالا نمی‌آمد
                ولی پنجره باز می‌شد ⇒ حالا پورت آزاد بعدی انتخاب می‌شود.
             ۲) اگر بارگذاری صفحه شکست می‌خورد، موتور نمایش (WebView2)
                صفحهٔ خطای انگلیسیِ خودش را نشان می‌داد ⇒ حالا رویداد
                NavigationCompleted گرفته می‌شود و صفحهٔ فارسی می‌آید.
             ۳) اگر سرور وسط کار می‌خوابید، پنجره «به سامانه نرسیدیم» می‌شد
                ⇒ حالا نگهبان هر ۶ ثانیه چک و سرور را دوباره بالا می‌آورد.
           هیچ‌جای این مسیرها مرورگر باز نمی‌شود. */

        /// <summary>
        /// در شروع سرد، health ممکن است چند ثانیه دیرتر از listener آماده شود.
        /// اگر supervisor زنده است، همان پورتی را که خودش برای child سرور نگه می‌دارد
        /// هدف می‌گیریم؛ انتخاب یک پورت آزاد دیگر در این فاصله باعث انتظار روی پورت غلط می‌شود.
        /// </summary>
        private int ActiveSupervisorPort()
        {
            try
            {
                string lockFile = Path.Combine(_dataDir, ".payesh-supervisor.lock");
                if (!File.Exists(lockFile)) return 0;
                string json = File.ReadAllText(lockFile, Encoding.UTF8);
                Match pidMatch = Regex.Match(json, "\"pid\"\\s*:\\s*(\\d+)");
                int pid;
                if (!pidMatch.Success || !int.TryParse(pidMatch.Groups[1].Value, out pid) || pid <= 0) return 0;
                using (Process owner = Process.GetProcessById(pid))
                {
                    if (owner.HasExited || !string.Equals(owner.ProcessName, "node", StringComparison.OrdinalIgnoreCase)) return 0;
                }
                Match portMatch = Regex.Match(json, "\"port\"\\s*:\\s*(\\d+)");
                int port = 0;
                if (!portMatch.Success || !int.TryParse(portMatch.Groups[1].Value, out port) || port <= 0 || port > 65535)
                    int.TryParse(ReadIni(_settingsFile, "port"), out port); // قفل supervisor نسخهٔ قدیمی
                return port > 0 && port <= 65535 ? port : 0;
            }
            catch { return 0; }
        }

        private void UseLocalPort(int port, string reason)
        {
            if (port <= 0 || port > 65535) return;
            _localPort = port;
            LocalUrl = "http://127.0.0.1:" + port;
            SaveIni(_settingsFile, "port", port.ToString());
            Log("local port = " + port + " (" + reason + ")");
        }

        /// <summary>اتصال به سرور محلیِ موجود پیش از راه‌اندازی نمونهٔ تازه.</summary>
        private async Task<bool> FindLocalServer()
        {
            var ports = new List<int>();
            int supervisorPort = ActiveSupervisorPort();
            if (supervisorPort > 0) ports.Add(supervisorPort);
            if (_localPort > 0 && !ports.Contains(_localPort)) ports.Add(_localPort);
            foreach (int p in PORT_CANDIDATES) if (!ports.Contains(p)) ports.Add(p);
            foreach (int p in ports)
            {
                string candidate = "http://127.0.0.1:" + p;
                if (!await Up(candidate)) continue;
                _localPort = p;
                LocalUrl = candidate;
                SaveIni(_settingsFile, "port", p.ToString());
                Log("attached to existing local Payesh server on port " + p);
                return true;
            }
            return false;
        }

        /// <summary>پورت آزاد برای سرور محلی (ترجیح: پورت ثبت‌شده، سپس ۸۰۸۰ و جایگزین‌ها).</summary>
        private void PickLocalPort()
        {
            int stored = 0;
            try { int.TryParse(ReadIni(_settingsFile, "port"), out stored); } catch { }
            var order = new List<int>();
            if (stored > 0) order.Add(stored);
            foreach (int p in PORT_CANDIDATES) if (!order.Contains(p)) order.Add(p);
            foreach (int p in order)
            {
                if (PortFree(p))
                {
                    _localPort = p;
                    LocalUrl = "http://127.0.0.1:" + p;
                    SaveIni(_settingsFile, "port", p.ToString());
                    Log("local port = " + p);
                    return;
                }
            }
            /* همه اشغال بودند: همان ۸۰۸۰ را امتحان می‌کنیم تا پیام روشن بدهیم */
            _localPort = 8080;
            LocalUrl = "http://127.0.0.1:8080";
            Log("no free local port found — sticking with 8080");
        }

        private static bool PortFree(int port)
        {
            TcpListener l = null;
            try
            {
                l = new TcpListener(IPAddress.Loopback, port);
                l.Start();
                return true;
            }
            catch { return false; }
            finally { try { if (l != null) l.Stop(); } catch { } }
        }

        /// <summary>نگهبان: هر ۶ ثانیه سرور محلی را چک می‌کند و اگر خوابیده باشد بیدارش می‌کند.</summary>
        private void StartWatchdog()
        {
            if (!_serverMode) return;
            OnUi(() =>
            {
                if (_watch == null)
                {
                    _watch = new System.Windows.Forms.Timer { Interval = 6000 };
                    _watch.Tick += async (s, e) => { try { await WatchTick(); } catch { } };
                }
                _watch.Start();
            });
        }

        private async Task WatchTick()
        {
            if (!_serverMode || _restarting != 0 || _connectToken == 0 || _closing) return;
            if (await Up(LocalUrl))
            {
                if (_error != null && _error.Visible && _currentUrl.Length > 0) RecoverTo(LocalUrl);
                return;
            }
            if (Interlocked.CompareExchange(ref _restarting, 1, 0) != 0) return;
            try
            {
                Log("watchdog: local server is not ready — checking the single supervisor");
                SetStatus("سامانه پاسخ نمی‌دهد — بازیابی خودکار…");
                OnUi(() => { _splash.Visible = true; _splash.BringToFront(); _error.Visible = false; });

                /* start.js تنها مالک فرایند سرور است و خودش پس از آپدیت/خروج ۷۵
                   نمونه را دوباره بالا می‌آورد. هنگام بالا آمدن آن، فرایند دوم نساز. */
                if (!SupervisorRunning() && !await FindLocalServer())
                {
                    int ownedPort = ActiveSupervisorPort();
                    if (ownedPort > 0) UseLocalPort(ownedPort, "existing supervisor");
                    else PickLocalPort();
                    StartServer();
                }
                for (int i = 0; i < 90 && !_closing; i++)
                {
                    if (await Up(LocalUrl)) { RecoverTo(LocalUrl); return; }
                    await Task.Delay(500);
                }
                if (await Up(LocalUrl)) RecoverTo(LocalUrl);
                else ShowError("سرور هنوز آماده نشده است؛ پایش هر چند ثانیه خودکار دوباره تلاش می‌کند. برنامه را نبندید.");
            }
            catch (Exception ex) { Log("watchdog error: " + ex.Message); }
            finally { Interlocked.Exchange(ref _restarting, 0); }
        }

        /// <summary>برگشتن بی‌صدا به برنامه بعد از قطعی موقت.</summary>
        private void RecoverTo(string url)
        {
            _pageHealthy = false;
            _navFails = 0;
            OnUi(() =>
            {
                try
                {
                    _splash.Visible = true;
                    _splash.BringToFront();
                    _error.Visible = false;
                    if (_offlineBar != null) _offlineBar.Visible = false;
                    if (_view == null) { ShowApp(url); return; }
                    _view.Visible = false;
                    SetStatus("در حال بازیابی اتصال…");
                    if (_view.CoreWebView2 != null) _view.CoreWebView2.Navigate(url);
                    else _view.Source = new Uri(url);
                }
                catch { }
            });
        }

        /// <summary>نتیجهٔ بارگذاری صفحه: موفق ⇒ پنهان‌کردن پیام‌ها، ناموفق ⇒ پیام فارسی خودمان.</summary>
        private void OnNavigated(bool ok, string status)
        {
            if (ok)
            {
                _pageHealthy = true;
                _navFails = 0;
                OnUi(() =>
                {
                    if (_view != null) { _view.Visible = true; _view.BringToFront(); }
                    _splash.Visible = false;
                    _error.Visible = false;
                });
                return;
            }
            _pageHealthy = false;
            _navFails++;
            Log("navigation failed (" + status + ") for " + _currentUrl + " — attempt " + _navFails);
            /* صفحهٔ خطای موتور نمایش پنهان می‌شود؛ کاربر هیچ صفحهٔ انگلیسی نمی‌بیند */
            OnUi(() =>
            {
                try
                {
                    if (_view != null) _view.Visible = false;
                    _splash.Visible = true;
                    _splash.BringToFront();
                }
                catch { }
            });
            if (_navFails <= 3)
            {
                SetStatus("بارگذاری دوباره… (" + _navFails + ")");
                Task.Delay(700).ContinueWith(_ =>
                {
                    if (_serverMode && _currentUrl.Length > 0)
                    {
                        Task.Run(async () =>
                        {
                            if (!await Up(LocalUrl)) { try { StartServer(); } catch { } }
                            ShowApp(_currentUrl);
                        });
                    }
                    else if (_currentUrl.Length > 0) ShowApp(_currentUrl);
                });
                return;
            }
            ShowLoadFail(status);
        }

        private void ShowLoadFail(string status)
        {
            ShowError("صفحهٔ برنامه باز نشد (" + status + "). «تلاش دوباره» را بزنید.");
        }

        /* ── موتور نمایش (WebView2) ──────────────────────────────────── */
        private static bool RuntimeReady()
        {
            try
            {
                string v = CoreWebView2Environment.GetAvailableBrowserVersionString();
                return !string.IsNullOrEmpty(v);
            }
            catch { return false; }
        }

        /// <summary>نصب بی‌صدا از فایل همراهِ بسته (بدون اینترنت هم کار می‌کند).</summary>
        private bool TryInstallWebViewRuntime()
        {
            if (_runtimeTried) return RuntimeReady();
            _runtimeTried = true;
            string[] spots =
            {
                Path.Combine(_appDir, "runtime", "MicrosoftEdgeWebView2Setup.exe"),
                Path.Combine(_appDir, "install", "windows", "MicrosoftEdgeWebView2Setup.exe"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "MicrosoftEdgeWebView2Setup.exe"),
            };
            foreach (string exe in spots)
            {
                if (!File.Exists(exe)) continue;
                try
                {
                    Log("installing WebView2 runtime from " + exe);
                    SetStatus("نصب موتور نمایش…");
                    var p = Process.Start(new ProcessStartInfo(exe, "/silent /install") { UseShellExecute = false });
                    if (p != null) p.WaitForExit(240000);
                }
                catch (Exception ex) { Log("webview2 install failed: " + ex.Message); }
                if (RuntimeReady()) return true;
            }
            return RuntimeReady();
        }

        /// <summary>موتور نمایش نصب نیست: پیام فارسی خودمان، بدون باز کردن مرورگر.</summary>
        private void ShowEngineMissing()
        {
            OnUi(() =>
            {
                _splash.Visible = false;
                _error.Visible = true;
                _error.BringToFront();
                FillDiag();
                _errorLabel.Text =
                    "موتور نمایش برنامه روی این ویندوز نصب نیست." + Environment.NewLine +
                    "این برنامه هیچ مرورگری باز نمی‌کند؛ فقط باید یک جزء رسمی مایکروسافت " +
                    "(WebView2) یک بار نصب شود. نصب‌کنندهٔ پایش خودش این کار را می‌کند؛ " +
                    "اگر انجام نشد، برنامه را دوباره نصب کنید یا دکمهٔ «نصب موتور نمایش» را بزنید.";
            });
        }

        /// <summary>این رایانه را سرور می‌کند و دوباره وصل می‌شود (اگر تشخیص خودکار اشتباه بود).</summary>
        private void ForceServerMode()
        {
            SaveIni(_settingsFile, "mode", "server");
            SaveIni(Path.Combine(_appDir, "payesh.ini"), "role", "server");
            _serverMode = true;
            Log("user forced server mode");
            StartConnect();
        }

        private void ShowOffline()
        {
            string last = ReadIni(_settingsFile, "last_url");
            if (last.Length == 0) last = Normalize(ReadIni(_settingsFile, "server_url"));
            if (last.Length == 0) return;
            Log("offline view: " + last);
            if (_offlineBar != null) _offlineBar.Visible = true;
            ShowApp(last);
        }

        private void FillDiag()
        {
            try
            {
                string serverJs = File.Exists(Path.Combine(_appDir, "server", "index.js")) ? "هست" : "نیست";
                string node = NodePath();
                _diagLabel.Text =
                    "این رایانه: " + (_serverMode ? "سیستم اصلی مدرسه" : "کاربر (به سیستم مدرسه وصل می‌شود)") +
                    "   ·   پوشهٔ نصب: " + _appDir + Environment.NewLine +
                    "داده (همیشه همین‌جا): " + _dataDir + Environment.NewLine +
                    "سرور: " + serverJs + "   ·   Node: " + (node == null ? "پیدا نشد" : Path.GetFileName(Path.GetDirectoryName(node)) + "\\" + Path.GetFileName(node)) +
                    "   ·   گزارش: %LOCALAPPDATA%\\Payesh\\app.log";

                /* آخرین خط لاگ سرور، تا کاربر لازم نباشد فایل را باز کند */
                try
                {
                    string logFile = Path.Combine(_dataDir, "server.log");
                    if (File.Exists(logFile))
                    {
                        string[] all = File.ReadAllLines(logFile, Encoding.UTF8);
                        int from = Math.Max(0, all.Length - 2);
                        string tail = "";
                        for (int i = from; i < all.Length; i++) tail += all[i] + " ";
                        tail = tail.Trim();
                        if (tail.Length > 0)
                        {
                            if (tail.Length > 220) tail = tail.Substring(tail.Length - 220);
                            _diagLabel.Text += Environment.NewLine + "آخرین خط سرور: " + tail;
                        }
                    }
                }
                catch { }
            }
            catch { }
        }

        /// <summary>نمایش مجدد پنجره و اعتبارسنجی اتصال پس از برگشت از سینی/اجرای دوم.</summary>
        internal void BringToFrontFromSecond() { RevealWindow(); }

        private void RevealWindow()
        {
            OnUi(() =>
            {
                bool wasHidden = !Visible;
                try
                {
                    ShowInTaskbar = true;
                    Show();
                    WindowState = FormWindowState.Normal;
                    Activate();
                    BringToFront();
                }
                catch { }

                /* بستن با X فقط پنجره را مخفی می‌کند؛ ممکن است در این فاصله آدرس
                   localhost از کار افتاده باشد. نمایش دوباره نباید همان صفحهٔ خطا
                   را زنده کند: اول health را می‌سنجیم و در صورت نیاز reconnect می‌کنیم. */
                bool needsCheck = wasHidden || !_pageHealthy || (_error != null && _error.Visible);
                if (needsCheck)
                    Task.Run(async () => { await Task.Delay(120); await CheckConnectionOnRestore(); });
            });
        }

        private async Task CheckConnectionOnRestore()
        {
            if (_closing) return;
            string target = _serverMode ? LocalUrl : _currentUrl;
            if (string.IsNullOrWhiteSpace(target))
            {
                OnUi(() => { if (!_closing) StartConnect(); });
                return;
            }

            bool ready = await Up(target);
            if (_closing) return;
            OnUi(() =>
            {
                if (_closing) return;
                if (!ready)
                {
                    Log("restore health-check failed for " + target + " — reconnecting");
                    StartConnect();
                    return;
                }
                if (!_pageHealthy || (_error != null && _error.Visible))
                {
                    string resume = _serverMode ? LocalUrl : target;
                    Log("restore health-check succeeded — reloading " + resume);
                    RecoverTo(resume);
                }
            });
        }

        /// <summary>اجرای امن روی رشتهٔ رابط کاربری، حتی پیش از ساخته شدن پنجره.</summary>
        private void OnUi(Action action)
        {
            if (IsDisposed) return;
            try
            {
                if (IsHandleCreated)
                {
                    if (InvokeRequired) BeginInvoke(action);
                    else action();
                }
                else
                {
                    EventHandler once = null;
                    once = (s, e) =>
                    {
                        HandleCreated -= once;
                        try { BeginInvoke(action); } catch { }
                    };
                    HandleCreated += once;
                }
            }
            catch { }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private bool TryCreateWebView()
        {
            try
            {
                var dataDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Payesh", "WebView2");
                Directory.CreateDirectory(dataDir);

                _view = new WebView2 { Dock = DockStyle.Fill };
                _view.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = dataDir };
                _view.CoreWebView2InitializationCompleted += (s, e) =>
                {
                    if (!e.IsSuccess)
                    {
                        try { _view.Dispose(); } catch { }
                        _view = null;
                        Log("webview2 init failed: " + (e.InitializationException == null ? "?" : e.InitializationException.Message));
                        ShowEngineMissing();
                        return;
                    }
                    try
                    {
                        var st = _view.CoreWebView2.Settings;
                        st.AreDefaultContextMenusEnabled = false;
                        st.IsStatusBarEnabled = false;
                        st.AreDevToolsEnabled = false;
                        st.AreBrowserAcceleratorKeysEnabled = false;
                        _view.CoreWebView2.NewWindowRequested += (s2, e2) =>
                        {
                            /* صفحهٔ محلی هرگز به Edge بیرونی فرستاده نشود؛ هنگام restart
                               آن کاربر را به ERR_CONNECTION_REFUSED می‌برد و پنجرهٔ برنامه را
                               از ناظر بازیابی جدا می‌کند. محلی را در همان WebView باز می‌کنیم. */
                            e2.Handled = true;
                            try
                            {
                                Uri target;
                                if (!Uri.TryCreate(e2.Uri, UriKind.Absolute, out target)) return;
                                if (target.IsLoopback)
                                {
                                    if (_view != null && _view.CoreWebView2 != null)
                                        _view.CoreWebView2.Navigate(target.AbsoluteUri);
                                    return;
                                }
                                if (target.Scheme == Uri.UriSchemeHttp || target.Scheme == Uri.UriSchemeHttps)
                                    Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true });
                            }
                            catch { }
                        };
                        /* completion قدیمی نباید نتیجهٔ navigation تازه‌تر را overwrite کند. */
                        _view.CoreWebView2.NavigationStarting += (s2, e2) => _activeNavigationId = e2.NavigationId;
                        /* WebView فقط پس از تکمیل ناوبریِ جاری نمایش داده می‌شود؛ اگر شکست بخورد
                           صفحهٔ داخلی Edge پشت صفحهٔ بازیابی می‌ماند و هرگز به کاربر چشمک نمی‌زند. */
                        _view.CoreWebView2.NavigationCompleted += (s2, e2) =>
                        {
                            if (e2.NavigationId != _activeNavigationId) return;
                            OnNavigated(e2.IsSuccess, e2.WebErrorStatus.ToString());
                        };
                        _view.CoreWebView2.ProcessFailed += (s2, e2) =>
                        {
                            Log("renderer process failed: " + e2.ProcessFailedKind);
                            try { _view.CoreWebView2.Reload(); } catch { }
                        };
                    }
                    catch { }
                };
                Controls.Add(_view);
                return true;
            }
            catch
            {
                _view = null;
                return false;
            }
        }

        /* ── سرور: یک ناظر واحد برای restart، crash و آپدیت ─────────── */
        private bool SupervisorRunning()
        {
            lock (_serverLock)
            {
                try { return _serverSupervisor != null && !_serverSupervisor.HasExited; }
                catch { _serverSupervisor = null; return false; }
            }
        }

        private void StartServer()
        {
            lock (_serverLock)
            {
                if (_closing) return;
                try
                {
                    if (_serverSupervisor != null && !_serverSupervisor.HasExited)
                    {
                        Log("supervisor already running pid=" + _serverSupervisor.Id + " — duplicate start ignored");
                        return;
                    }
                }
                catch { }
                try { if (_serverSupervisor != null) _serverSupervisor.Dispose(); } catch { }
                _serverSupervisor = null;

                try
                {
                    string node = NodePath();
                    if (node == null)
                    {
                        Log("error: node.exe پیدا نشد (نه همراه بسته، نه نصب‌شده)");
                        SetStatus("Node.js پیدا نشد — سرور بالا نمی‌آید");
                        return;
                    }

                    string supervisorJs = Path.Combine(_appDir, "server", "start.js");
                    if (!File.Exists(supervisorJs))
                    {
                        Log("error: server/start.js پیدا نشد در " + _appDir);
                        SetStatus("راه‌انداز پایدار سرور پیدا نشد");
                        return;
                    }

                    Directory.CreateDirectory(_dataDir);
                    var psi = new ProcessStartInfo(node, "\"server\\start.js\"")
                    {
                        WorkingDirectory = _appDir,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                    };
                    psi.EnvironmentVariables["PAYESH_TUNNEL_AUTO"] = "1";
                    psi.EnvironmentVariables["PORT"] = _localPort.ToString();
                    psi.EnvironmentVariables["PAYESH_DATA"] = _dataDir;

                    var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
                    string logPath = Path.Combine(_dataDir, "server.log");
                    DataReceivedEventHandler sink = (s2, e) =>
                    {
                        if (e.Data == null) return;
                        try { File.AppendAllText(logPath, e.Data + Environment.NewLine, Encoding.UTF8); } catch { }
                    };
                    proc.OutputDataReceived += sink;
                    proc.ErrorDataReceived += sink;
                    proc.Exited += (s2, e) =>
                    {
                        string exit = "?";
                        try { exit = proc.ExitCode.ToString(); } catch { }
                        lock (_serverLock)
                        {
                            if (Object.ReferenceEquals(_serverSupervisor, proc)) _serverSupervisor = null;
                        }
                        Log("server supervisor exited code=" + exit);
                        /* Dispose را به فراخواننده نسپاریم: فرآیند تکراری ممکن است
                           پیش از BeginOutputReadLine خارج شود. */
                    };

                    /* ثبت پیش از Start تا watchdog هم‌زمان ناظر دومی نسازد. */
                    _serverSupervisor = proc;
                    if (!proc.Start()) throw new InvalidOperationException("start.js شروع نشد");
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    Log("server supervisor started pid=" + proc.Id + " node=" + node + " port=" + _localPort);
                }
                catch (Exception ex)
                {
                    try { if (_serverSupervisor != null) _serverSupervisor.Dispose(); } catch { }
                    _serverSupervisor = null;
                    Log("error: راه‌اندازی ناظر سرور ناموفق — " + ex.Message);
                    SetStatus("راه‌اندازی سرور ناموفق — تلاش خودکار ادامه دارد");
                }
            }
        }

        /* ── بررسی سلامت ────────────────────────────────────────────── */
        private async Task<bool> Up(string baseUrl)
        {
            string body = await HttpGet(baseUrl.TrimEnd('/') + "/api/health", 1800);
            if (body == null) return false;
            if (body.IndexOf("payesh-local", StringComparison.Ordinal) < 0) return false;

            Match m = Regex.Match(body, "\"public_url\"\\s*:\\s*\"([^\"]+)\"");
            if (!m.Success)
                m = Regex.Match(body, "\"publicUrl\"\\s*:\\s*\"([^\"]+)\"");
            if (m.Success)
            {
                string pub = m.Groups[1].Value.Replace("\\/", "/").Trim();
                if (pub.Length > 0)
                {
                    _learnedPublic = pub;
                    SaveIni(_settingsFile, "public_url", pub);
                }
            }
            return true;
        }

        /// <summary>آدرس‌های مخزن: هم «url» تکی هم آرایهٔ «urls» (چند سرور).</summary>
        private static async Task<List<string>> RemoteAddresses()
        {
            var list = new List<string>();
            string body = await HttpGet(RemoteConfig, 6000);
            if (body == null) return list;
            foreach (Match m in Regex.Matches(body, "\"urls\"\\s*:\\s*\\[(.*?)\\]", RegexOptions.Singleline))
            {
                foreach (Match item in Regex.Matches(m.Groups[1].Value, "\"([^\"]*)\""))
                    AddCandidate(list, PlaceholderSafe(item.Groups[1].Value));
            }
            Match single = Regex.Match(body, "\"url\"\\s*:\\s*\"([^\"]*)\"");
            if (single.Success) AddCandidate(list, PlaceholderSafe(single.Groups[1].Value));
            return list;
        }

        private static string PlaceholderSafe(string raw)
        {
            string url = Normalize(raw);
            if (Regex.IsMatch(url, "XXXX|example", RegexOptions.IgnoreCase)) return "";
            return url;
        }

        private static async Task<string> HttpGet(string url, int timeoutMs)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.AllowAutoRedirect = true;
                req.UserAgent = "PayeshDesktop/1.0";
                using (var resp = (HttpWebResponse)await req.GetResponseAsync())
                using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    if ((int)resp.StatusCode != 200) return null;
                    return await reader.ReadToEndAsync();
                }
            }
            catch { return null; }
        }

        /* ── جستجوی شبکهٔ محلی ──────────────────────────────────────── */
        private async Task<string> ScanLan(int token)
        {
            string local = LocalIPv4();
            if (local == null) return null;
            string prefix = local.Substring(0, local.LastIndexOf('.') + 1);
            var found = new string[1];
            var gate = new object();

            var tasks = new List<Task>();
            for (int i = 1; i <= 254; i++)
            {
                int host = i;
                tasks.Add(Task.Run(async () =>
                {
                    if (Volatile.Read(ref found[0]) != null || token != _connectToken) return;
                    foreach (int port in PORT_CANDIDATES)
                    {
                        if (Volatile.Read(ref found[0]) != null || token != _connectToken) return;
                        string candidate = "http://" + prefix + host + ":" + port;
                        if (await Up(candidate)) { lock (gate) { if (found[0] == null) found[0] = candidate; } return; }
                    }
                }));
                if (tasks.Count >= 400) { await Task.WhenAll(tasks); tasks.Clear(); }
            }
            await Task.WhenAll(tasks);
            return found[0];
        }

        private static string LocalIPv4()
        {
            try
            {
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up) continue;
                    if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                    foreach (UnicastIPAddressInformation info in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (info.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                        string ip = info.Address.ToString();
                        if (ip.StartsWith("192.168.") || ip.StartsWith("10.") || ip.StartsWith("172."))
                            return ip;
                    }
                }
            }
            catch { }
            return null;
        }

        /* ── کمکی‌ها ────────────────────────────────────────────────── */
        private void SetStatus(string text)
        {
            OnUi(() => { _statusLabel.Text = text; });
        }

        private void ShowError(string detail = null)
        {
            OnUi(() =>
            {
                _splash.Visible = false;
                _error.Visible = true;
                _error.BringToFront();
                if (_trayMode && _tray != null)
                {
                    try { _tray.ShowBalloonTip(4000, "پایش", "اتصال به سامانه برقرار نشد — آیکون کنار ساعت را بزنید.", ToolTipIcon.Warning); } catch { }
                }
                FillDiag();
                _errorLabel.Text =
                    "سامانهٔ مدرسه در دسترس نیست." + Environment.NewLine +
                    "اگر سیستم مدرسه خاموش است این طبیعی است: با «نمایش آخرین وضعیت» " +
                    "همان صفحه‌ای که آخرین بار دیدید باز می‌شود و ثبت‌های جدید در صف می‌مانند " +
                    "تا سیستم مدرسه روشن شود." +
                    (detail != null ? Environment.NewLine + "جزئیات: " + detail : "");
            });
        }

        private void SaveAddress()
        {
            string url = Normalize(_addrBox.Text);
            if (url.Length == 0) return;
            SaveIni(_settingsFile, "server_url", url);
            _learnedPublic = "";
            StartConnect();
        }

        /* قبلاً اینجا mode=client ذخیره می‌شد و سیستم مدرسه برای همیشه «کاربر» می‌ماند.
           حالا فقط همان لحظه جستجوی شبکه انجام می‌شود. */
        private void SearchLanNow()
        {
            SaveIni(_settingsFile, "lan_now", "1");
            StartConnect();
        }

        private static string Normalize(string raw)
        {
            string u = (raw ?? "").Trim();
            if (u.Length == 0) return "";
            if (!u.StartsWith("http://") && !u.StartsWith("https://"))
            {
                bool local = Regex.IsMatch(u, @"^(localhost|[0-9.]+)(:.*)?$") || u.StartsWith("192.168.") || u.StartsWith("10.");
                u = (local ? "http://" : "https://") + u;
            }
            return u.TrimEnd('/');
        }

        private static string ReadIni(string file, string key)
        {
            try
            {
                if (!File.Exists(file)) return "";
                foreach (string line in File.ReadAllLines(file, Encoding.UTF8))
                {
                    int i = line.IndexOf('=');
                    if (i <= 0) continue;
                    if (line.Substring(0, i).Trim() == key) return line.Substring(i + 1).Trim();
                }
            }
            catch { }
            return "";
        }

        private static void SaveIni(string file, string key, string value)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                var lines = File.Exists(file) ? new List<string>(File.ReadAllLines(file, Encoding.UTF8)) : new List<string>();
                bool done = false;
                for (int i = 0; i < lines.Count; i++)
                {
                    int eq = lines[i].IndexOf('=');
                    if (eq > 0 && lines[i].Substring(0, eq).Trim() == key)
                    {
                        lines[i] = key + "=" + value;
                        done = true;
                        break;
                    }
                }
                if (!done) lines.Add(key + "=" + value);
                File.WriteAllLines(file, lines.ToArray(), Encoding.UTF8);
            }
            catch { }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (_trayMode) Hide();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_reallyExit && e.CloseReason == CloseReason.UserClosing && _tray != null)
            {
                e.Cancel = true;
                Hide();
                _tray.ShowBalloonTip(2000, "پایش", "برنامه در سینی سیستم فعال است.", ToolTipIcon.Info);
                return;
            }
            _closing = true;
            try { if (_watch != null) _watch.Stop(); } catch { }
            try { if (_tray != null) _tray.Visible = false; } catch { }
            base.OnFormClosing(e);
        }
    }
}
