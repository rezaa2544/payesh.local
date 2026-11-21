// Payesh web32 shell — app file server inside CEF (row 169, D-50).
#include "scheme.h"

#include <string>

#include "include/cef_parser.h"
#include "include/cef_scheme.h"
#include "include/cef_stream.h"
#include "include/wrapper/cef_stream_resource_handler.h"
#include "util.h"

namespace payesh {

namespace {

std::wstring MimeOf(const std::wstring& path) {
  size_t dot = path.find_last_of(L'.');
  std::wstring ext = dot == std::wstring::npos ? L"" : path.substr(dot + 1);
  for (auto& c : ext) c = static_cast<wchar_t>(towlower(c));
  if (ext == L"html") return L"text/html";
  if (ext == L"js" || ext == L"mjs") return L"text/javascript";
  if (ext == L"wasm") return L"application/wasm";
  if (ext == L"json") return L"application/json";
  if (ext == L"css") return L"text/css";
  if (ext == L"png") return L"image/png";
  if (ext == L"ttf") return L"font/ttf";
  if (ext == L"otf") return L"font/otf";
  if (ext == L"svg") return L"image/svg+xml";
  CefString m = CefGetMimeType(ext);
  return m.empty() ? L"application/octet-stream" : m.ToWString();
}

class AppSchemeFactory : public CefSchemeHandlerFactory {
 public:
  AppSchemeFactory() : root_(ExeDir() + L"\\web") {}

  CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                       const CefString& scheme_name,
                                       CefRefPtr<CefRequest> request) override {
    CefURLParts parts;
    if (!CefParseURL(request->GetURL(), parts)) return NotFound();
    std::wstring path = CefURIDecode(CefString(&parts.path), true,
                                     static_cast<cef_uri_unescape_rule_t>(
                                         UU_SPACES | UU_URL_SPECIAL_CHARS_EXCEPT_PATH_SEPARATORS))
                            .ToWString();
    if (path.empty() || path == L"/") path = L"/index.html";
    // No way out of the web folder.
    if (path.find(L"..") != std::wstring::npos || path.find(L':') != std::wstring::npos ||
        path.find(L'\\') != std::wstring::npos) {
      return NotFound();
    }
    std::wstring file = root_;
    for (wchar_t c : path) file.push_back(c == L'/' ? L'\\' : c);
    DWORD attrs = GetFileAttributesW(file.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
      return NotFound();
    }
    CefRefPtr<CefStreamReader> stream = CefStreamReader::CreateForFile(file);
    if (!stream) return NotFound();
    CefResponse::HeaderMap headers;
    headers.insert(std::make_pair("Cache-Control", "no-cache"));
    headers.insert(std::make_pair("X-Content-Type-Options", "nosniff"));
    return new CefStreamResourceHandler(200, "OK", MimeOf(file), headers, stream);
  }

 private:
  CefRefPtr<CefResourceHandler> NotFound() {
    static const char body[] = "not found";
    CefRefPtr<CefStreamReader> s =
        CefStreamReader::CreateForData(const_cast<char*>(body), sizeof(body) - 1);
    return new CefStreamResourceHandler(404, "Not Found", "text/plain",
                                        CefResponse::HeaderMap(), s);
  }

  const std::wstring root_;
  IMPLEMENT_REFCOUNTING(AppSchemeFactory);
};

}  // namespace

void RegisterAppScheme() {
  CefRegisterSchemeHandlerFactory("http", kAppHost, new AppSchemeFactory());
}

}  // namespace payesh
