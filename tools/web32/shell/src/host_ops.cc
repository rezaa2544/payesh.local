// Payesh web32 shell — Win32 implementation of the host contract (row 169, D-50).
#include <winsock2.h>
#include <ws2tcpip.h>

#include "host_ops.h"

#include <wincrypt.h>

#include <map>
#include <mutex>
#include <set>

#include "util.h"

namespace payesh {

namespace {

constexpr int64_t kEpochDiff100ns = 116444736000000000LL;

int64_t FileTimeToMs(const FILETIME& ft) {
  ULARGE_INTEGER u;
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  return (static_cast<int64_t>(u.QuadPart) - kEpochDiff100ns) / 10000;
}

FILETIME MsToFileTime(int64_t ms) {
  ULARGE_INTEGER u;
  u.QuadPart = static_cast<ULONGLONG>(ms * 10000 + kEpochDiff100ns);
  FILETIME ft;
  ft.dwLowDateTime = u.LowPart;
  ft.dwHighDateTime = u.HighPart;
  return ft;
}

constexpr DWORD kShareAll = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

std::wstring Strip(const std::wstring& p) {
  std::wstring s = p;
  for (auto& c : s) {
    if (c == L'/') c = L'\\';
  }
  while (s.size() > 3 && s.back() == L'\\') s.pop_back();
  return s;
}

bool ReadAt(HANDLE h, int64_t pos, char* buf, DWORD len, DWORD* got) {
  OVERLAPPED ov = {};
  ov.Offset = static_cast<DWORD>(pos & 0xffffffff);
  ov.OffsetHigh = static_cast<DWORD>(pos >> 32);
  *got = 0;
  if (ReadFile(h, buf, len, got, &ov)) return true;
  return GetLastError() == ERROR_HANDLE_EOF;
}

bool WriteAt(HANDLE h, int64_t pos, const char* buf, DWORD len) {
  DWORD done = 0;
  while (done < len) {
    OVERLAPPED ov = {};
    int64_t p = pos + done;
    ov.Offset = static_cast<DWORD>(p & 0xffffffff);
    ov.OffsetHigh = static_cast<DWORD>(p >> 32);
    DWORD n = 0;
    if (!WriteFile(h, buf + done, len - done, &n, &ov)) return false;
    if (n == 0) return false;
    done += n;
  }
  return true;
}

// Open file handles (fopen/fread/...). The renderer's main thread is the only caller.
std::map<int, HANDLE>& Handles() {
  static std::map<int, HANDLE> m;
  return m;
}
int g_next_handle = 1;

HANDLE HandleOf(int h, HostErr& e) {
  auto it = Handles().find(h);
  if (it == Handles().end()) {
    e.Set(ERROR_INVALID_HANDLE, L"bad handle");
    return INVALID_HANDLE_VALUE;
  }
  return it->second;
}

std::wstring CommandLine(const std::wstring& exe, const std::vector<std::wstring>& args) {
  std::wstring cl = QuoteArg(exe);
  for (const auto& a : args) {
    cl += L' ';
    cl += QuoteArg(a);
  }
  return cl;
}

struct PipeReader {
  HANDLE pipe = nullptr;
  std::string data;
};

DWORD WINAPI ReadPipeThread(LPVOID p) {
  auto* r = static_cast<PipeReader*>(p);
  char buf[8192];
  DWORD n = 0;
  while (ReadFile(r->pipe, buf, sizeof(buf), &n, nullptr) && n > 0) {
    if (r->data.size() < 64u * 1024u * 1024u) r->data.append(buf, n);
  }
  return 0;
}

bool RemoveTree(const std::wstring& dir, HostErr& e) {
  WIN32_FIND_DATAW fd;
  HANDLE f = FindFirstFileW((dir + L"\\*").c_str(), &fd);
  if (f != INVALID_HANDLE_VALUE) {
    do {
      std::wstring name = fd.cFileName;
      if (name == L"." || name == L"..") continue;
      std::wstring p = dir + L"\\" + name;
      bool isDir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      bool isLink = (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_READONLY) {
        SetFileAttributesW(p.c_str(), fd.dwFileAttributes & ~FILE_ATTRIBUTE_READONLY);
      }
      if (isDir && !isLink) {
        if (!RemoveTree(p, e)) {
          FindClose(f);
          return false;
        }
      } else if (isDir) {
        if (!RemoveDirectoryW(p.c_str())) {
          e.SetLast(L"Deletion failed, path = '" + p + L"'");
          FindClose(f);
          return false;
        }
      } else if (!DeleteFileW(p.c_str())) {
        e.SetLast(L"Deletion failed, path = '" + p + L"'");
        FindClose(f);
        return false;
      }
    } while (FindNextFileW(f, &fd));
    FindClose(f);
  }
  if (!RemoveDirectoryW(dir.c_str())) {
    e.SetLast(L"Deletion failed, path = '" + dir + L"'");
    return false;
  }
  return true;
}

}  // namespace

void HostErr::Set(DWORD c, const std::wstring& context) {
  code = c == 0 ? ERROR_GEN_FAILURE : c;
  msg = context + L" (OS Error: " + ErrorText(code) + L", errno = " + std::to_wstring(code) +
        L")";
}

HostStat StatPath(const std::wstring& path) {
  HostStat s;
  WIN32_FILE_ATTRIBUTE_DATA fa;
  if (!GetFileAttributesExW(Strip(path).c_str(), GetFileExInfoStandard, &fa)) return s;
  s.type = (fa.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? L'd' : L'f';
  s.size = (static_cast<int64_t>(fa.nFileSizeHigh) << 32) | fa.nFileSizeLow;
  if (s.type == L'd') s.size = 0;
  s.modifiedMs = FileTimeToMs(fa.ftLastWriteTime);
  return s;
}

Bytes ReadPath(const std::wstring& path, int64_t start, int64_t end, HostErr& e) {
  HANDLE h = CreateFileW(Strip(path).c_str(), GENERIC_READ, kShareAll, nullptr, OPEN_EXISTING,
                         FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    e.SetLast(L"Cannot open file, path = '" + path + L"'");
    return Bytes();
  }
  LARGE_INTEGER size;
  GetFileSizeEx(h, &size);
  int64_t s = start < 0 ? 0 : (start > size.QuadPart ? size.QuadPart : start);
  int64_t t = end < 0 ? size.QuadPart : (end > size.QuadPart ? size.QuadPart : end);
  if (t < s) t = s;
  Bytes out;
  out.resize(static_cast<size_t>(t - s));
  size_t done = 0;
  while (done < out.size()) {
    DWORD chunk = static_cast<DWORD>(out.size() - done > (1u << 24) ? (1u << 24) : out.size() - done);
    DWORD got = 0;
    if (!ReadAt(h, s + static_cast<int64_t>(done), &out[done], chunk, &got)) {
      e.SetLast(L"Cannot read file, path = '" + path + L"'");
      CloseHandle(h);
      return Bytes();
    }
    if (got == 0) break;
    done += got;
  }
  out.resize(done);
  CloseHandle(h);
  return out;
}

void WritePath(const std::wstring& path, const Bytes& data, bool append, HostErr& e) {
  HANDLE h = CreateFileW(Strip(path).c_str(), append ? FILE_APPEND_DATA : GENERIC_WRITE,
                         FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr,
                         append ? OPEN_ALWAYS : CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE && !append && GetLastError() == ERROR_ACCESS_DENIED) {
    // Hidden/system files refuse CREATE_ALWAYS; truncate instead (same as dart:io).
    h = CreateFileW(Strip(path).c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE,
                    nullptr, TRUNCATE_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  }
  if (h == INVALID_HANDLE_VALUE) {
    e.SetLast(L"Cannot open file, path = '" + path + L"'");
    return;
  }
  size_t done = 0;
  while (done < data.size()) {
    DWORD chunk = static_cast<DWORD>(data.size() - done > (1u << 24) ? (1u << 24) : data.size() - done);
    DWORD n = 0;
    if (!WriteFile(h, data.data() + done, chunk, &n, nullptr) || n == 0) {
      e.SetLast(L"Cannot write file, path = '" + path + L"'");
      CloseHandle(h);
      return;
    }
    done += n;
  }
  CloseHandle(h);
}

std::vector<std::pair<std::wstring, wchar_t>> ListDir(const std::wstring& path, HostErr& e) {
  std::vector<std::pair<std::wstring, wchar_t>> out;
  std::wstring dir = Strip(path);
  if (StatPath(dir).type != L'd') {
    e.Set(ERROR_PATH_NOT_FOUND, L"Directory listing failed, path = '" + path + L"'");
    return out;
  }
  WIN32_FIND_DATAW fd;
  std::wstring pattern = dir;
  if (pattern.back() != L'\\') pattern += L'\\';
  pattern += L'*';
  HANDLE f = FindFirstFileW(pattern.c_str(), &fd);
  if (f == INVALID_HANDLE_VALUE) {
    if (GetLastError() == ERROR_FILE_NOT_FOUND) return out;
    e.SetLast(L"Directory listing failed, path = '" + path + L"'");
    return out;
  }
  do {
    std::wstring name = fd.cFileName;
    if (name == L"." || name == L"..") continue;
    out.emplace_back(name, (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? L'd' : L'f');
  } while (FindNextFileW(f, &fd));
  FindClose(f);
  return out;
}

void MakeDirs(const std::wstring& path, HostErr& e) {
  std::wstring p = Strip(path);
  if (StatPath(p).type == L'd') return;
  size_t cut = p.find_last_of(L'\\');
  if (cut != std::wstring::npos && cut > 2) {
    MakeDirs(p.substr(0, cut), e);
    if (e.failed()) return;
  }
  if (!CreateDirectoryW(p.c_str(), nullptr)) {
    DWORD c = GetLastError();
    if (c == ERROR_ALREADY_EXISTS && StatPath(p).type == L'd') return;
    e.Set(c, L"Creation failed, path = '" + path + L"'");
  }
}

void RemovePath(const std::wstring& path, bool recursive, HostErr& e) {
  std::wstring p = Strip(path);
  DWORD attrs = GetFileAttributesW(p.c_str());
  if (attrs == INVALID_FILE_ATTRIBUTES) {
    e.SetLast(L"Deletion failed, path = '" + path + L"'");
    return;
  }
  if (attrs & FILE_ATTRIBUTE_READONLY) {
    SetFileAttributesW(p.c_str(), attrs & ~FILE_ATTRIBUTE_READONLY);
  }
  if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
    if (!DeleteFileW(p.c_str())) e.SetLast(L"Deletion failed, path = '" + path + L"'");
    return;
  }
  if (recursive && !(attrs & FILE_ATTRIBUTE_REPARSE_POINT)) {
    RemoveTree(p, e);
    return;
  }
  if (!RemoveDirectoryW(p.c_str())) e.SetLast(L"Deletion failed, path = '" + path + L"'");
}

void RenamePath(const std::wstring& from, const std::wstring& to, HostErr& e) {
  std::wstring a = Strip(from), b = Strip(to);
  DWORD attrs = GetFileAttributesW(a.c_str());
  if (attrs == INVALID_FILE_ATTRIBUTES) {
    e.SetLast(L"Cannot rename file to '" + to + L"', path = '" + from + L"'");
    return;
  }
  DWORD flags = MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH;
  if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) flags |= MOVEFILE_REPLACE_EXISTING;
  if (!MoveFileExW(a.c_str(), b.c_str(), flags)) {
    e.SetLast(L"Cannot rename file to '" + to + L"', path = '" + from + L"'");
  }
}

void CopyPath(const std::wstring& from, const std::wstring& to, HostErr& e) {
  if (!CopyFileW(Strip(from).c_str(), Strip(to).c_str(), FALSE)) {
    e.SetLast(L"Cannot copy file to '" + to + L"', path = '" + from + L"'");
  }
}

void SetModified(const std::wstring& path, int64_t ms, HostErr& e) {
  HANDLE h = CreateFileW(Strip(path).c_str(), FILE_WRITE_ATTRIBUTES, kShareAll, nullptr,
                         OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    e.SetLast(L"Cannot set modification time, path = '" + path + L"'");
    return;
  }
  FILETIME ft = MsToFileTime(ms);
  if (!SetFileTime(h, nullptr, nullptr, &ft)) {
    e.SetLast(L"Cannot set modification time, path = '" + path + L"'");
  }
  CloseHandle(h);
}

int FileOpen(const std::wstring& path, const std::wstring& mode, HostErr& e) {
  DWORD access = GENERIC_READ;
  DWORD disp = OPEN_EXISTING;
  if (mode == L"w") {
    access = GENERIC_READ | GENERIC_WRITE;
    disp = CREATE_ALWAYS;
  } else if (mode == L"a" || mode == L"rw") {
    access = GENERIC_READ | GENERIC_WRITE;
    disp = OPEN_ALWAYS;
  } else if (mode != L"r") {
    e.Set(ERROR_INVALID_PARAMETER, L"bad open mode '" + mode + L"'");
    return 0;
  }
  HANDLE h = CreateFileW(Strip(path).c_str(), access, kShareAll, nullptr, disp,
                         FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    e.SetLast(L"Cannot open file, path = '" + path + L"'");
    return 0;
  }
  int id = g_next_handle++;
  Handles()[id] = h;
  return id;
}

Bytes FileRead(int id, int64_t pos, int64_t len, HostErr& e) {
  HANDLE h = HandleOf(id, e);
  if (e.failed() || len <= 0) return Bytes();
  Bytes out;
  out.resize(static_cast<size_t>(len));
  size_t done = 0;
  while (done < out.size()) {
    DWORD got = 0;
    DWORD chunk = static_cast<DWORD>(out.size() - done);
    if (!ReadAt(h, pos + static_cast<int64_t>(done), &out[done], chunk, &got)) {
      e.SetLast(L"readFrom failed");
      return Bytes();
    }
    if (got == 0) break;
    done += got;
  }
  out.resize(done);
  return out;
}

void FileWrite(int id, int64_t pos, const Bytes& data, HostErr& e) {
  HANDLE h = HandleOf(id, e);
  if (e.failed() || data.empty()) return;
  if (!WriteAt(h, pos, data.data(), static_cast<DWORD>(data.size()))) {
    e.SetLast(L"writeFrom failed");
  }
}

int64_t FileSize(int id, HostErr& e) {
  HANDLE h = HandleOf(id, e);
  if (e.failed()) return 0;
  LARGE_INTEGER s;
  if (!GetFileSizeEx(h, &s)) {
    e.SetLast(L"length failed");
    return 0;
  }
  return s.QuadPart;
}

void FileTruncate(int id, int64_t len, HostErr& e) {
  HANDLE h = HandleOf(id, e);
  if (e.failed()) return;
  LARGE_INTEGER p;
  p.QuadPart = len;
  if (!SetFilePointerEx(h, p, nullptr, FILE_BEGIN) || !SetEndOfFile(h)) {
    e.SetLast(L"truncate failed");
  }
}

void FileSync(int id, HostErr& e) {
  HANDLE h = HandleOf(id, e);
  if (e.failed()) return;
  if (!FlushFileBuffers(h)) e.SetLast(L"flush failed");
}

void FileClose(int id, HostErr& e) {
  HANDLE h = HandleOf(id, e);
  if (e.failed()) return;
  CloseHandle(h);
  Handles().erase(id);
}

Bytes Dpapi(const Bytes& data, const Bytes& entropy, bool protect, HostErr& e) {
  DATA_BLOB in;
  in.cbData = static_cast<DWORD>(data.size());
  in.pbData = reinterpret_cast<BYTE*>(const_cast<char*>(data.data()));
  DATA_BLOB ent;
  ent.cbData = static_cast<DWORD>(entropy.size());
  ent.pbData = reinterpret_cast<BYTE*>(const_cast<char*>(entropy.data()));
  DATA_BLOB out = {};
  BOOL ok = protect ? CryptProtectData(&in, nullptr, &ent, nullptr, nullptr,
                                       CRYPTPROTECT_UI_FORBIDDEN, &out)
                    : CryptUnprotectData(&in, nullptr, &ent, nullptr, nullptr,
                                         CRYPTPROTECT_UI_FORBIDDEN, &out);
  if (!ok) {
    e.SetLast(protect ? L"CryptProtectData failed" : L"CryptUnprotectData failed");
    return Bytes();
  }
  Bytes r(reinterpret_cast<char*>(out.pbData), out.cbData);
  SecureZeroMemory(out.pbData, out.cbData);
  LocalFree(out.pbData);
  return r;
}

HostRunResult RunProcess(const std::wstring& exe, const std::vector<std::wstring>& args,
                         const std::wstring& cwd, DWORD timeoutMs, HostErr& e) {
  HostRunResult r;
  SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, TRUE};
  HANDLE outR = nullptr, outW = nullptr, errR = nullptr, errW = nullptr;
  if (!CreatePipe(&outR, &outW, &sa, 0) || !CreatePipe(&errR, &errW, &sa, 0)) {
    e.SetLast(L"pipe");
    return r;
  }
  SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(errR, HANDLE_FLAG_INHERIT, 0);
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                           OPEN_EXISTING, 0, nullptr);
  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = nul;
  si.hStdOutput = outW;
  si.hStdError = errW;
  PROCESS_INFORMATION pi = {};
  std::wstring cl = CommandLine(exe, args);
  BOOL ok = CreateProcessW(nullptr, &cl[0], nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, nullptr,
                           cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
  DWORD startErr = GetLastError();
  CloseHandle(outW);
  CloseHandle(errW);
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  if (!ok) {
    CloseHandle(outR);
    CloseHandle(errR);
    e.Set(startErr, L"" + exe);
    return r;
  }
  PipeReader ro{outR, {}}, re{errR, {}};
  HANDLE threads[2] = {CreateThread(nullptr, 0, ReadPipeThread, &ro, 0, nullptr),
                       CreateThread(nullptr, 0, ReadPipeThread, &re, 0, nullptr)};
  r.pid = pi.dwProcessId;
  if (WaitForSingleObject(pi.hProcess, timeoutMs) == WAIT_TIMEOUT) {
    TerminateProcess(pi.hProcess, 1);
    WaitForSingleObject(pi.hProcess, 5000);
    re.data += "\r\n[payesh web32] process timed out";
  }
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  r.code = static_cast<int32_t>(code);
  // Grandchildren may keep the pipes open (e.g. `cmd /c start`): give the readers a moment.
  for (HANDLE t : threads) {
    if (t && WaitForSingleObject(t, 2000) == WAIT_TIMEOUT) {
      CancelSynchronousIo(t);
      WaitForSingleObject(t, 2000);
    }
  }
  for (HANDLE t : threads) {
    if (t) CloseHandle(t);
  }
  CloseHandle(outR);
  CloseHandle(errR);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  r.out = DecodeOutput(ro.data);
  r.err = DecodeOutput(re.data);
  return r;
}

DWORD SpawnProcess(const std::wstring& exe, const std::vector<std::wstring>& args,
                   const std::wstring& cwd, HostErr& e) {
  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi = {};
  std::wstring cl = CommandLine(exe, args);
  DWORD flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;
  BOOL ok = CreateProcessW(nullptr, &cl[0], nullptr, nullptr, FALSE,
                           flags | CREATE_BREAKAWAY_FROM_JOB, nullptr,
                           cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
  if (!ok && GetLastError() == ERROR_ACCESS_DENIED) {
    ok = CreateProcessW(nullptr, &cl[0], nullptr, nullptr, FALSE, flags, nullptr,
                        cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
  }
  if (!ok) {
    e.SetLast(exe);
    return 0;
  }
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return pi.dwProcessId;
}

bool KillProcess(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
  if (!h) return false;
  BOOL ok = TerminateProcess(h, 1);
  CloseHandle(h);
  return ok != FALSE;
}

std::vector<std::wstring> Resolve(const std::wstring& host, HostErr& e) {
  static bool started = false;
  if (!started) {
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    started = true;
  }
  std::vector<std::wstring> out;
  ADDRINFOW hints = {};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  ADDRINFOW* res = nullptr;
  int rc = GetAddrInfoW(host.c_str(), nullptr, &hints, &res);
  if (rc != 0) {
    e.Set(static_cast<DWORD>(rc), L"Failed host lookup: '" + host + L"'");
    return out;
  }
  std::set<std::wstring> seen;
  for (ADDRINFOW* a = res; a; a = a->ai_next) {
    wchar_t buf[NI_MAXHOST];
    if (GetNameInfoW(a->ai_addr, static_cast<socklen_t>(a->ai_addrlen), buf, NI_MAXHOST,
                     nullptr, 0, NI_NUMERICHOST) == 0) {
      std::wstring ip = buf;
      size_t pct = ip.find(L'%');
      if (pct != std::wstring::npos) ip.resize(pct);
      if (seen.insert(ip).second) out.push_back(ip);
    }
  }
  FreeAddrInfoW(res);
  return out;
}

std::wstring OsVersionText() {
  typedef LONG(WINAPI * RtlGetVersionFn)(OSVERSIONINFOEXW*);
  OSVERSIONINFOEXW v = {};
  v.dwOSVersionInfoSize = sizeof(v);
  auto fn = reinterpret_cast<RtlGetVersionFn>(reinterpret_cast<void*>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion")));
  if (fn) fn(&v);
  wchar_t product[256] = L"Windows";
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", 0,
                    KEY_READ | KEY_WOW64_64KEY, &key) == ERROR_SUCCESS) {
    wchar_t buf[256] = {};
    DWORD size = sizeof(buf) - sizeof(wchar_t);
    DWORD type = 0;
    if (RegQueryValueExW(key, L"ProductName", nullptr, &type, reinterpret_cast<BYTE*>(buf),
                         &size) == ERROR_SUCCESS &&
        type == REG_SZ && buf[0]) {
      wcscpy_s(product, buf);
    }
    RegCloseKey(key);
  }
  // Same shape as dart:io on Windows: "Windows 10 Pro" 10.0 (Build 19045)
  return L"\"" + std::wstring(product) + L"\" " + std::to_wstring(v.dwMajorVersion) + L"." +
         std::to_wstring(v.dwMinorVersion) + L" (Build " + std::to_wstring(v.dwBuildNumber) +
         L")";
}

std::wstring LocaleName() {
  wchar_t buf[LOCALE_NAME_MAX_LENGTH] = {};
  if (GetUserDefaultLocaleName(buf, LOCALE_NAME_MAX_LENGTH) > 0) return buf;
  return L"fa-IR";
}

std::wstring HostName() {
  wchar_t buf[256] = {};
  DWORD n = 256;
  if (GetComputerNameExW(ComputerNameDnsHostname, buf, &n)) return buf;
  n = 256;
  if (GetComputerNameW(buf, &n)) return buf;
  return L"localhost";
}

std::wstring TempDir() {
  wchar_t buf[MAX_PATH + 2] = {};
  DWORD n = GetTempPathW(MAX_PATH + 1, buf);
  std::wstring t(buf, n);
  while (t.size() > 3 && t.back() == L'\\') t.pop_back();
  return t;
}

std::vector<std::pair<std::wstring, std::wstring>> Environment() {
  std::vector<std::pair<std::wstring, std::wstring>> out;
  wchar_t* block = GetEnvironmentStringsW();
  if (!block) return out;
  for (wchar_t* p = block; *p; p += wcslen(p) + 1) {
    std::wstring kv = p;
    if (kv.empty() || kv[0] == L'=') continue;
    size_t eq = kv.find(L'=');
    if (eq == std::wstring::npos) continue;
    out.emplace_back(kv.substr(0, eq), kv.substr(eq + 1));
  }
  FreeEnvironmentStringsW(block);
  return out;
}

int CpuCount() {
  SYSTEM_INFO si;
  GetNativeSystemInfo(&si);
  return static_cast<int>(si.dwNumberOfProcessors);
}

}  // namespace payesh
