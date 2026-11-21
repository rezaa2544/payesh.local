// Payesh web32 shell — entry point and the top-level window (row 169, D-50).
//
// The 32-bit Windows edition of the school app (payesh_app.exe) and of the owner panel
// (payesh_owner.exe): the same Flutter code as the 64-bit build, compiled to JavaScript
// (`flutter build web`) and shown by Chromium 109 (CEF, the last Chromium for Windows 7).
// Files under <exe dir>\web are served as http://payesh.localhost/ without any network.
#include <windows.h>

#include <string>

#include "app.h"
#include "client.h"
#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_command_line.h"
#include "util.h"

namespace payesh {

namespace {

HWND g_main = nullptr;
CefRefPtr<CefBrowser> g_browser;
bool g_closing = false;
int g_exit_code = 0;
bool g_minimized = false;

int Scale(int v) {
  HDC dc = GetDC(nullptr);
  int dpi = dc ? GetDeviceCaps(dc, LOGPIXELSX) : 96;
  if (dc) ReleaseDC(nullptr, dc);
  return MulDiv(v, dpi, 96);
}

void ResizeBrowser() {
  if (!g_browser || !g_main) return;
  HWND bw = g_browser->GetHost()->GetWindowHandle();
  if (!bw) return;
  RECT rc;
  GetClientRect(g_main, &rc);
  SetWindowPos(bw, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_SIZE:
      ResizeBrowser();
      return 0;
    case WM_SETFOCUS:
      if (g_browser) g_browser->GetHost()->SetFocus(true);
      return 0;
    case WM_ERASEBKGND:
      if (g_browser) return 1;
      break;
    case WM_GETMINMAXINFO: {
      auto* mm = reinterpret_cast<MINMAXINFO*>(lp);
      mm->ptMinTrackSize.x = Scale(760);
      mm->ptMinTrackSize.y = Scale(540);
      return 0;
    }
    case 0x02E0: {  // WM_DPICHANGED (per-monitor DPI, Windows 8.1+)
      const RECT* r = reinterpret_cast<const RECT*>(lp);
      SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
                   SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_CLOSE:
      if (g_browser && !g_closing) {
        g_closing = true;
        g_browser->GetHost()->CloseBrowser(false);
        return 0;
      }
      break;
    case WM_DESTROY:
      g_main = nullptr;
      if (!g_browser) CefQuitMessageLoop();
      return 0;
    default:
      break;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

}  // namespace

void OnBrowserCreated(CefRefPtr<CefBrowser> browser) {
  if (!g_browser) g_browser = browser;
  ResizeBrowser();
}

void OnBrowserClosed() {
  g_browser = nullptr;
  if (g_main) DestroyWindow(g_main);
  CefQuitMessageLoop();
}

void SetWindowTitle(const std::wstring& title) {
  if (g_main) SetWindowTextW(g_main, title.c_str());
}

void RequestExit(int code) {
  g_exit_code = code;
  ShellLog(L"exit(" + std::to_wstring(code) + L") requested by the app");
  if (g_browser) {
    g_closing = true;
    g_browser->GetHost()->CloseBrowser(true);
  } else {
    CefQuitMessageLoop();
  }
}

void CreateMainWindow() {
  HINSTANCE inst = GetModuleHandleW(nullptr);
  const AppIdentity& id = Identity();
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = WndProc;
  wc.hInstance = inst;
  wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
  wc.hIconSm = wc.hIcon;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(WHITE_BRUSH));
  wc.lpszClassName = id.windowClass;
  RegisterClassExW(&wc);

  RECT work;
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  int ww = work.right - work.left, wh = work.bottom - work.top;
  int w = Scale(1280), h = Scale(820);
  if (w > ww * 92 / 100) w = ww * 92 / 100;
  if (h > wh * 92 / 100) h = wh * 92 / 100;
  int x = work.left + (ww - w) / 2, y = work.top + (wh - h) / 2;

  g_main = CreateWindowExW(0, id.windowClass, id.title, WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                           x, y, w, h, nullptr, nullptr, inst, nullptr);
  if (!g_main) {
    ShellLog(L"CreateWindowEx failed: " + ErrorText(GetLastError()));
    CefQuitMessageLoop();
    return;
  }
  ShowWindow(g_main, g_minimized ? SW_SHOWMINNOACTIVE : SW_SHOWNORMAL);
  UpdateWindow(g_main);

  RECT rc;
  GetClientRect(g_main, &rc);
  CefWindowInfo info;
  info.SetAsChild(g_main, CefRect(0, 0, rc.right - rc.left, rc.bottom - rc.top));
  CefBrowserSettings bs;
  bs.background_color = CefColorSetARGB(255, 255, 255, 255);
  CefBrowserHost::CreateBrowser(info, new ShellClient(), kAppUrl, bs, nullptr, nullptr);
}

int Main(HINSTANCE instance) {
  CefMainArgs args(instance);
  CefRefPtr<ShellApp> app(new ShellApp());
  int code = CefExecuteProcess(args, app.get(), nullptr);
  if (code >= 0) return code;  // a Chromium child process finished

  CefRefPtr<CefCommandLine> cl = CefCommandLine::CreateCommandLine();
  cl->InitFromString(GetCommandLineW());
  g_minimized = cl->HasSwitch("payesh-minimized");

  const AppIdentity& id = Identity();
  HANDLE mutex = CreateMutexW(nullptr, TRUE, id.mutexName);
  if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
    // One window per user, like the 64-bit app: bring the running one forward.
    HWND other = FindWindowW(id.windowClass, nullptr);
    if (other) {
      if (IsIconic(other)) ShowWindow(other, SW_RESTORE);
      SetForegroundWindow(other);
    }
    CloseHandle(mutex);
    return 0;
  }

  const std::wstring data = DataDir();
  CefSettings s;
  s.no_sandbox = true;
  CefString(&s.root_cache_path) = data + L"\\cef";
  CefString(&s.cache_path) = data + L"\\cef";
  CefString(&s.log_file) = data + L"\\cef.log";
  s.log_severity = LOGSEVERITY_ERROR;
  CefString(&s.locale) = "fa";
  CefString(&s.accept_language_list) = "fa-IR,fa,en-US,en";
  s.background_color = CefColorSetARGB(255, 255, 255, 255);
  s.persist_session_cookies = true;

  ShellLog(L"start " + ExePath());
  if (!CefInitialize(args, s, app.get(), nullptr)) {
    ShellLog(L"CefInitialize failed");
    MessageBoxW(nullptr, L"برنامه نتوانست شروع شود (CEF). لطفاً دوباره نصب کنید.", id.title,
                MB_ICONERROR | MB_OK);
    if (mutex) CloseHandle(mutex);
    return 1;
  }
  CefRunMessageLoop();
  CefShutdown();
  ShellLog(L"exit " + std::to_wstring(g_exit_code));
  if (mutex) CloseHandle(mutex);
  return g_exit_code;
}

}  // namespace payesh

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR cmd_line, int show) {
#if defined(ARCH_CPU_32_BITS)
  // CEF's main thread needs a bigger stack than the 32-bit default: run on a fiber.
  int fiber = CefRunWinMainWithPreferredStackSize(wWinMain, instance, cmd_line, show);
  if (fiber >= 0) return fiber;
#endif
  return payesh::Main(instance);
}
