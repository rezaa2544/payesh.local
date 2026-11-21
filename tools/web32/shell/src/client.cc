// Payesh web32 shell — browser-side handlers (row 169, D-50).
#include "client.h"

#include <shellapi.h>

#include <string>

#include "host_v8.h"
#include "util.h"

namespace payesh {

namespace {

bool IsAppUrl(const std::string& url) {
  const std::string prefix = std::string(kAppOrigin) + "/";
  return url.compare(0, prefix.size(), prefix) == 0;
}

bool IsWebLink(const std::wstring& url) {
  return url.compare(0, 8, L"https://") == 0 || url.compare(0, 7, L"http://") == 0;
}

}  // namespace

void OpenExternal(const std::wstring& url) {
  if (!IsWebLink(url)) return;
  ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

bool ShellClient::OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                           CefRefPtr<CefFrame> frame,
                                           CefProcessId source_process,
                                           CefRefPtr<CefProcessMessage> message) {
  // Only the app's own page may ask (the host object exists nowhere else).
  if (!frame || !IsAppUrl(frame->GetURL().ToString())) return false;
  const std::string name = message->GetName().ToString();
  if (name == kMsgExit) {
    RequestExit(message->GetArgumentList()->GetInt(1));
    return true;
  }
  if (name == kMsgOpenUrl) {
    OpenExternal(message->GetArgumentList()->GetString(0).ToWString());
    return true;
  }
  return false;
}

bool ShellClient::OnBeforePopup(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                const CefString& target_url, const CefString& target_frame_name,
                                CefLifeSpanHandler::WindowOpenDisposition target_disposition,
                                bool user_gesture,
                                const CefPopupFeatures& popupFeatures, CefWindowInfo& windowInfo,
                                CefRefPtr<CefClient>& client, CefBrowserSettings& settings,
                                CefRefPtr<CefDictionaryValue>& extra_info,
                                bool* no_javascript_access) {
  // No second windows: web links go to the system browser.
  if (user_gesture) OpenExternal(target_url.ToWString());
  return true;
}

void ShellClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) { OnBrowserCreated(browser); }

bool ShellClient::DoClose(CefRefPtr<CefBrowser> browser) { return false; }

void ShellClient::OnBeforeClose(CefRefPtr<CefBrowser> browser) { OnBrowserClosed(); }

bool ShellClient::OnBeforeBrowse(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                 CefRefPtr<CefRequest> request, bool user_gesture,
                                 bool is_redirect) {
  const std::string url = request->GetURL().ToString();
  if (IsAppUrl(url) || url == "about:blank") return false;
  // The window only ever shows the app; anything else opens outside.
  if (user_gesture) OpenExternal(request->GetURL().ToWString());
  ShellLog(L"blocked navigation to " + request->GetURL().ToWString());
  return true;
}

void ShellClient::OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser,
                                            TerminationStatus status) {
  ShellLog(L"renderer terminated, status " + std::to_wstring(static_cast<int>(status)));
  if (++crashes_ <= 3) browser->GetMainFrame()->LoadURL(kAppUrl);
}

void ShellClient::OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) {
  std::wstring t = title.ToWString();
  if (!t.empty() && t.find(L"payesh.localhost") == std::wstring::npos) SetWindowTitle(t);
}

bool ShellClient::OnConsoleMessage(CefRefPtr<CefBrowser> browser, cef_log_severity_t level,
                                   const CefString& message, const CefString& source,
                                   int line) {
  if (level >= LOGSEVERITY_WARNING) ShellLog(L"[console] " + message.ToWString());
  return false;
}

void ShellClient::OnBeforeContextMenu(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                      CefRefPtr<CefContextMenuParams> params,
                                      CefRefPtr<CefMenuModel> model) {
  // Same feel as the 64-bit app: no browser menu (Back/Reload/View source).
  model->Clear();
}

void ShellClient::OnLoadError(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                              ErrorCode errorCode, const CefString& errorText,
                              const CefString& failedUrl) {
  if (errorCode == ERR_ABORTED) return;
  ShellLog(L"load error " + std::to_wstring(static_cast<int>(errorCode)) + L" " +
           errorText.ToWString() + L" " + failedUrl.ToWString());
}

}  // namespace payesh
