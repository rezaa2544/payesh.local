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
        private const string LocalUrl = "http://127.0.0.1:8080";
        /* همان فایل پیکربندی که اپ اندروید می‌خواند — یک جای مشخص برای آدرس عمومی */
        private const string RemoteConfig =
            "https://raw.githubusercontent.com/rezaa2544/payesh.local/main/android-config.json";
        private readonly string _baseDir;
        private readonly string _appDir;
        private bool _serverMode;
        private readonly string _settingsFile;

        private WebView2 _view;
        private Panel _splash;
        private Panel _error;
        private Label _statusLabel;
        private Label _errorLabel;
        private Label _diagLabel;
        private TextBox _addrBox;
        private NotifyIcon _tray;
        private string _currentUrl = "";
        private string _learnedPublic = "";
        private bool _reallyExit;
        private bool _trayMode;
        private int _connectToken;

        public Shell(string[] args)
        {
            _baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            /* برنامه در {app}\desktop می‌نشیند و سرور در {app}\server → ریشهٔ نصب یک پله بالاتر است.
               این نکته در نسخهٔ 0.4.2 فراموش شده بود و برنامه اشتباهاً «حالت کاربر» می‌شد. */
            _appDir = ResolveRoot(_baseDir);
            _settingsFile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Payesh", "settings.ini");

            bool forceClient = Array.IndexOf(args, "--client") >= 0;
            bool forceServer = Array.IndexOf(args, "--server") >= 0;
            _trayMode = Array.IndexOf(args, "--tray") >= 0;
            string role = ReadIni(Path.Combine(_appDir, "payesh.ini"), "role");
            bool installedAsClient = role == "client" || ReadIni(_settingsFile, "mode") == "client";
            _serverMode = forceServer || (!forceClient && !installedAsClient
                && File.Exists(Path.Combine(_appDir, "server", "index.js")));

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

            /* صفحهٔ خطا */
            _error = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(11, 27, 51), Visible = false };
            _errorLabel = new Label
            {
                ForeColor = Color.FromArgb(231, 237, 246),
                Font = new Font("Tahoma", 11f),
                Dock = DockStyle.Top,
                Height = 90,
                TextAlign = ContentAlignment.MiddleCenter,
                Text = "اتصال برقرار نشد.",
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
            btnRow.Controls.Add(MakeButton("راه‌اندازی سرور در همین رایانه", (s, e) => { ForceServerMode(); }));
            btnRow.Controls.Add(MakeButton("تلاش دوباره", (s, e) => StartConnect()));
            btnRow.Controls.Add(MakeButton("جستجوی شبکهٔ مدرسه", (s, e) => { SaveMode(); StartConnect(); }));
            btnRow.Controls.Add(MakeButton("باز کردن در مرورگر", (s, e) => OpenInBrowser(_addrBox.Text.Trim().Length > 0 ? Normalize(_addrBox.Text) : LocalUrl)));

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
                menu.Items.Add("باز کردن پایش", null, (s, e) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
                menu.Items.Add("نمایش در مرورگر", null, (s, e) => OpenInBrowser(_currentUrl.Length > 0 ? _currentUrl : LocalUrl));
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("خروج", null, (s, e) => { _reallyExit = true; Close(); });
                _tray.ContextMenuStrip = menu;
                _tray.DoubleClick += (s, e) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
            }
            catch { }
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
            SetStatus("در حال آماده‌سازی…");
            _splash.Visible = true;
            _splash.BringToFront();
            _error.Visible = false;

            Task.Run(async () =>
            {
                try
                {
                    if (_serverMode)
                    {
                        if (!await Up(LocalUrl))
                        {
                            SetStatus("راه‌اندازی سامانه…");
                            StartServer();
                            for (int i = 0; i < 60 && token == _connectToken; i++)
                            {
                                if (await Up(LocalUrl)) break;
                                await Task.Delay(500);
                            }
                        }
                        if (await Up(LocalUrl))
                        {
                            ShowApp(LocalUrl);
                            return;
                        }
                        SetStatus("سرور بالا نیامد — تلاش برای اتصال به سامانهٔ دیگر…");
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
                        string remote = await RemoteAddress();
                        if (remote.Length > 0 && await Up(remote) && token == _connectToken)
                        {
                            SaveIni(_settingsFile, "server_url", remote);
                            ShowApp(remote);
                            return;
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
            AddCandidate(list, _learnedPublic);
            AddCandidate(list, ReadIni(_settingsFile, "public_url"));
            return list;
        }

        private static void AddCandidate(List<string> list, string raw)
        {
            string u = Normalize(raw);
            if (u.Length > 0 && !list.Contains(u)) list.Add(u);
        }

        private void ShowApp(string url)
        {
            _currentUrl = url;
            OnUi(() =>
            {
                try
                {
                    if (_view == null && !TryCreateWebView())
                    {
                        _reallyExit = true;
                        OpenInBrowser(url);
                        Close();
                        return;
                    }
                    _splash.Visible = false;
                    _error.Visible = false;
                    _view.Visible = true;
                    _view.BringToFront();
                    try { _tray.Text = "پایش — " + new Uri(url).Host; } catch { }
                    _view.Source = new Uri(url);
                }
                catch
                {
                    _reallyExit = true;
                    OpenInBrowser(url);
                    Close();
                }
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

        private void FillDiag()
        {
            try
            {
                string serverJs = File.Exists(Path.Combine(_appDir, "server", "index.js")) ? "هست" : "نیست";
                string node = NodePath();
                _diagLabel.Text =
                    "نقش: " + (_serverMode ? "سرور همین رایانه" : "کاربر (اتصال به سرور مدرسه)") +
                    "   ·   پوشهٔ نصب: " + _appDir + Environment.NewLine +
                    "سرور: " + serverJs + "   ·   Node: " + (node == null ? "پیدا نشد" : Path.GetFileName(Path.GetDirectoryName(node)) + "\\" + Path.GetFileName(node)) +
                    "   ·   گزارش: %LOCALAPPDATA%\\Payesh\\app.log";

                /* آخرین خط لاگ سرور، تا کاربر لازم نباشد فایل را باز کند */
                try
                {
                    string logFile = Path.Combine(_appDir, "data", "server.log");
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

        /// <summary>وقتی کاربر دوباره روی آیکون برنامه کلیک می‌کند: پنجرهٔ موجود را نشان بده.</summary>
        internal void BringToFrontFromSecond()
        {
            OnUi(() =>
            {
                try
                {
                    ShowInTaskbar = true;
                    Show();
                    WindowState = FormWindowState.Normal;
                    Activate();
                    BringToFront();
                }
                catch { }
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
                        _reallyExit = true;
                        OpenInBrowser(_currentUrl);
                        Close();
                        return;
                    }
                    try
                    {
                        var st = _view.CoreWebView2.Settings;
                        st.AreDefaultContextMenusEnabled = false;
                        st.IsStatusBarEnabled = false;
                        st.AreDevToolsEnabled = false;
                        _view.CoreWebView2.NewWindowRequested += (s2, e2) =>
                        {
                            e2.Handled = true;
                            try { Process.Start(e2.Uri); } catch { }
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

        /// <summary>اگر WebView2 نبود: حالت «برنامه»ی Edge (بدون نوار آدرس) و در نهایت مرورگر.</summary>
        private void OpenInBrowser(string url)
        {
            try
            {
                string[] edges =
                {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                };
                foreach (string edge in edges)
                {
                    if (!File.Exists(edge)) continue;
                    string profile = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Payesh", "browser");
                    Process.Start(new ProcessStartInfo(edge,
                        "--app=" + url + " --window-size=1240,880 --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check")
                    { UseShellExecute = false });
                    return;
                }
                Process.Start(url);
            }
            catch { }
        }

        /* ── سرور ───────────────────────────────────────────────────── */
        private void StartServer()
        {
            try
            {
                string node = NodePath();
                if (node == null)
                {
                    Log("error: node.exe پیدا نشد (نه همراه بسته، نه نصب‌شده)");
                    SetStatus("Node.js پیدا نشد — سرور بالا نمی‌آید");
                    return;
                }

                string serverJs = Path.Combine(_appDir, "server", "index.js");
                if (!File.Exists(serverJs))
                {
                    Log("error: server/index.js پیدا نشد در " + _appDir);
                    return;
                }

                Directory.CreateDirectory(Path.Combine(_appDir, "data"));
                var psi = new ProcessStartInfo(node,
                    "--experimental-sqlite --disable-warning=ExperimentalWarning \"server\\index.js\"")
                {
                    WorkingDirectory = _appDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                psi.EnvironmentVariables["PAYESH_TUNNEL_AUTO"] = "1";

                var proc = new Process { StartInfo = psi };
                string logPath = Path.Combine(_appDir, "data", "server.log");
                DataReceivedEventHandler sink = (s2, e) =>
                {
                    if (e.Data == null) return;
                    try { File.AppendAllText(logPath, e.Data + Environment.NewLine, Encoding.UTF8); } catch { }
                };
                proc.OutputDataReceived += sink;
                proc.ErrorDataReceived += sink;
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                Log("server started pid=" + proc.Id + " node=" + node);
            }
            catch (Exception ex)
            {
                Log("error: راه‌اندازی سرور ناموفق — " + ex.Message);
                SetStatus("راه‌اندازی سرور ناموفق");
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

        private static async Task<string> RemoteAddress()
        {
            string body = await HttpGet(RemoteConfig, 6000);
            if (body == null) return "";
            Match m = Regex.Match(body, "\"url\"\\s*:\\s*\"([^\"]*)\"");
            if (!m.Success) return "";
            string url = Normalize(m.Groups[1].Value);
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
                    string candidate = "http://" + prefix + host + ":8080";
                    if (await Up(candidate)) lock (gate) { if (found[0] == null) found[0] = candidate; }
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
                    "اتصال به سامانه برقرار نشد." + Environment.NewLine +
                    "اینترنت/شبکه را بررسی کنید یا آدرس سامانه را وارد کنید." +
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

        private void SaveMode()
        {
            SaveIni(_settingsFile, "mode", "client");
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
            try { if (_tray != null) _tray.Visible = false; } catch { }
            base.OnFormClosing(e);
        }
    }
}
