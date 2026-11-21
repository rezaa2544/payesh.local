// Payesh web32 shell — Win32 helpers (row 169, D-50).
#include "util.h"

#include <shlobj.h>

namespace payesh {

const AppIdentity& Identity() {
#if defined(PAYESH_OWNER)
  static const AppIdentity id{L"owner", L"پنل مالک پایش", L"PayeshOwner32",
                              L"PayeshWeb32Owner",
                              L"Local\\PayeshWeb32Owner.SingleInstance"};
#else
  static const AppIdentity id{L"app", L"پایش", L"PayeshNative32",
                              L"PayeshWeb32App",
                              L"Local\\PayeshWeb32App.SingleInstance"};
#endif
  return id;
}

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                              nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                      &out[0], n);
  return out;
}

std::string WideToUtf8(const std::wstring& s) {
  if (s.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                              nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                      &out[0], n, nullptr, nullptr);
  return out;
}

std::wstring ExePath() {
  std::wstring buf(32768, L'\0');
  DWORD n = GetModuleFileNameW(nullptr, &buf[0], static_cast<DWORD>(buf.size()));
  buf.resize(n);
  return buf;
}

std::wstring ExeDir() {
  std::wstring p = ExePath();
  size_t i = p.find_last_of(L"\\/");
  return i == std::wstring::npos ? p : p.substr(0, i);
}

std::wstring DataDir() {
  wchar_t* base = nullptr;
  std::wstring dir;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &base))) {
    dir = base;
  }
  CoTaskMemFree(base);
  if (dir.empty()) {
    wchar_t tmp[MAX_PATH + 1];
    DWORD n = GetTempPathW(MAX_PATH + 1, tmp);
    dir.assign(tmp, n);
    while (!dir.empty() && dir.back() == L'\\') dir.pop_back();
  }
  dir += L"\\";
  dir += Identity().dataFolder;
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}

std::wstring ErrorText(DWORD code) {
  wchar_t* msg = nullptr;
  DWORD n = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER |
                               FORMAT_MESSAGE_FROM_SYSTEM |
                               FORMAT_MESSAGE_IGNORE_INSERTS,
                           nullptr, code, MAKELANGID(LANG_ENGLISH, SUBLANG_ENGLISH_US),
                           reinterpret_cast<LPWSTR>(&msg), 0, nullptr);
  if (n == 0) {
    n = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
                           FORMAT_MESSAGE_IGNORE_INSERTS,
                       nullptr, code, 0, reinterpret_cast<LPWSTR>(&msg), 0, nullptr);
  }
  std::wstring out = n && msg ? std::wstring(msg, n) : L"Windows error " + std::to_wstring(code);
  if (msg) LocalFree(msg);
  while (!out.empty() && (out.back() == L'\n' || out.back() == L'\r' || out.back() == L' ')) {
    out.pop_back();
  }
  return out;
}

void ShellLog(const std::wstring& line) {
  static std::wstring path = DataDir() + L"\\web32-shell.log";
  WIN32_FILE_ATTRIBUTE_DATA fa;
  if (GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &fa) &&
      (fa.nFileSizeHigh > 0 || fa.nFileSizeLow > 1024 * 1024)) {
    std::wstring old = path + L".1";
    MoveFileExW(path.c_str(), old.c_str(), MOVEFILE_REPLACE_EXISTING);
  }
  HANDLE h = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return;
  SYSTEMTIME st;
  GetLocalTime(&st);
  wchar_t stamp[64];
  swprintf_s(stamp, L"%04u-%02u-%02u %02u:%02u:%02u.%03u [%lu] ", st.wYear, st.wMonth,
             st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds,
             GetCurrentProcessId());
  std::string text = WideToUtf8(std::wstring(stamp) + line + L"\r\n");
  DWORD written = 0;
  WriteFile(h, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
  CloseHandle(h);
}

std::wstring QuoteArg(const std::wstring& a) {
  if (!a.empty() && a.find_first_of(L" \t\n\v\"") == std::wstring::npos) return a;
  std::wstring r = L"\"";
  for (size_t i = 0;; ++i) {
    size_t slashes = 0;
    while (i < a.size() && a[i] == L'\\') {
      ++i;
      ++slashes;
    }
    if (i == a.size()) {
      r.append(slashes * 2, L'\\');
      break;
    }
    if (a[i] == L'"') {
      r.append(slashes * 2 + 1, L'\\');
      r.push_back(L'"');
    } else {
      r.append(slashes, L'\\');
      r.push_back(a[i]);
    }
  }
  r.push_back(L'"');
  return r;
}

std::wstring DecodeOutput(const std::string& b) {
  if (b.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, b.data(),
                              static_cast<int>(b.size()), nullptr, 0);
  UINT cp = n > 0 ? CP_UTF8 : GetOEMCP();
  n = MultiByteToWideChar(cp, 0, b.data(), static_cast<int>(b.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(cp, 0, b.data(), static_cast<int>(b.size()), &out[0], n);
  return out;
}

std::string HexOf(const std::string& s) {
  static const char d[] = "0123456789abcdef";
  std::string out;
  out.reserve(s.size() * 2);
  for (unsigned char c : s) {
    out.push_back(d[c >> 4]);
    out.push_back(d[c & 15]);
  }
  return out;
}

std::string FromHex(const std::string& s) {
  auto v = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  std::string out;
  for (size_t i = 0; i + 1 < s.size(); i += 2) {
    int hi = v(s[i]), lo = v(s[i + 1]);
    if (hi < 0 || lo < 0) break;
    out.push_back(static_cast<char>(hi * 16 + lo));
  }
  return out;
}

}  // namespace payesh
