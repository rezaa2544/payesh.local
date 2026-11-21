// Payesh web32 shell — process setup (row 169, D-50).
#include "app.h"

#include <shellapi.h>

#include <string>

#include "host_v8.h"
#include "include/cef_command_line.h"
#include "include/cef_origin_whitelist.h"
#include "include/cef_parser.h"
#include "include/cef_values.h"
#include "scheme.h"
#include "util.h"

namespace payesh {

void ShellApp::OnBeforeCommandLineProcessing(const CefString& process_type,
                                             CefRefPtr<CefCommandLine> cl) {
  if (!process_type.empty()) return;
  // Chrome's own root store (ISRG, current CAs) instead of the stale Windows 7 roots.
  cl->AppendSwitchWithValue("enable-features", "ChromeRootStoreUsed");
  // The school server is on the LAN (http://192.168.x.x): no Private Network Access
  // blocking/preflights for the app's own origin; no occlusion throttling.
  cl->AppendSwitchWithValue(
      "disable-features",
      "BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,"
      "PrivateNetworkAccessRespectPreflightResults,CalculateNativeWinOcclusion");
  // CORS off for this browser (like the 64-bit build's HttpClient: the school server sends no
  // CORS headers). Safe here: every frame can only ever show the app's own origin
  // (client.cc OnBeforeBrowse), popups are refused, there is no address bar.
  cl->AppendSwitch("disable-web-security");
  cl->AppendSwitch("disable-extensions");
  cl->AppendSwitch("disable-pdf-extension");
  cl->AppendSwitch("disable-spell-checking");
  cl->AppendSwitchWithValue("lang", "fa");
  cl->AppendSwitch("no-proxy-server");
}

void ShellApp::OnContextInitialized() {
  RegisterAppScheme();
  // CORS: the app (and only the app origin) may call any http/https endpoint, like the
  // 64-bit build's HttpClient does. Navigation never leaves the app (client.cc).
  CefAddCrossOriginWhitelistEntry(kAppOrigin, "https", "", true);
  CefAddCrossOriginWhitelistEntry(kAppOrigin, "http", "", true);
  CreateMainWindow();
}

void ShellApp::OnBeforeChildProcessLaunch(CefRefPtr<CefCommandLine> cl) {
  cl->AppendSwitchWithValue(kSwitchBrowserPid, std::to_string(GetCurrentProcessId()));
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  CefRefPtr<CefListValue> list = CefListValue::Create();
  size_t n = 0;
  for (int i = 1; argv && i < argc; ++i) list->SetString(n++, argv[i]);
  if (argv) LocalFree(argv);
  CefRefPtr<CefValue> v = CefValue::Create();
  v->SetList(list);
  cl->AppendSwitchWithValue(kSwitchArgs,
                            HexOf(CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString()));
}

void ShellApp::OnContextCreated(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                CefRefPtr<CefV8Context> context) {
  if (!frame->IsMain()) return;
  const std::string url = frame->GetURL().ToString();
  const std::string prefix = std::string(kAppOrigin) + "/";
  // The host functions exist only for the app's own pages, never for any other origin.
  if (url.compare(0, prefix.size(), prefix) != 0) return;
  InstallHost(context);
}

}  // namespace payesh
