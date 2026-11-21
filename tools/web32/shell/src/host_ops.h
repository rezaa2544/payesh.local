// Payesh web32 shell — the Win32 side of `window.payeshHost` (row 169, D-50).
// Runs in the renderer process (sandbox off) so the calls can be synchronous, exactly like
// dart:io's *Sync methods in the 64-bit build. Contract: tools/web32/shell/README.md and
// apps/payesh/packages/payesh_core/lib/src/io/web/host.dart (must match).
#pragma once

#include <windows.h>

#include <cstdint>
#include <string>
#include <vector>

namespace payesh {

// Error raised to JavaScript as "<code>|<message>".
struct HostErr {
  DWORD code = 0;
  std::wstring msg;
  bool failed() const { return code != 0; }
  void Set(DWORD c, const std::wstring& context);
  void SetLast(const std::wstring& context) { Set(GetLastError(), context); }
};

using Bytes = std::string;  // raw bytes

struct HostStat {
  wchar_t type = L'n';  // 'f' | 'd' | 'n'
  int64_t size = 0;
  int64_t modifiedMs = 0;
};

struct HostRunResult {
  DWORD pid = 0;
  int64_t code = -1;
  std::wstring out;
  std::wstring err;
};

HostStat StatPath(const std::wstring& path);
Bytes ReadPath(const std::wstring& path, int64_t start, int64_t end, HostErr& e);
void WritePath(const std::wstring& path, const Bytes& data, bool append, HostErr& e);
std::vector<std::pair<std::wstring, wchar_t>> ListDir(const std::wstring& path, HostErr& e);
void MakeDirs(const std::wstring& path, HostErr& e);
void RemovePath(const std::wstring& path, bool recursive, HostErr& e);
void RenamePath(const std::wstring& from, const std::wstring& to, HostErr& e);
void CopyPath(const std::wstring& from, const std::wstring& to, HostErr& e);
void SetModified(const std::wstring& path, int64_t ms, HostErr& e);

int FileOpen(const std::wstring& path, const std::wstring& mode, HostErr& e);
Bytes FileRead(int h, int64_t pos, int64_t len, HostErr& e);
void FileWrite(int h, int64_t pos, const Bytes& data, HostErr& e);
int64_t FileSize(int h, HostErr& e);
void FileTruncate(int h, int64_t len, HostErr& e);
void FileSync(int h, HostErr& e);
void FileClose(int h, HostErr& e);

Bytes Dpapi(const Bytes& data, const Bytes& entropy, bool protect, HostErr& e);
HostRunResult RunProcess(const std::wstring& exe, const std::vector<std::wstring>& args,
                         const std::wstring& cwd, DWORD timeoutMs, HostErr& e);
DWORD SpawnProcess(const std::wstring& exe, const std::vector<std::wstring>& args,
                   const std::wstring& cwd, HostErr& e);
bool KillProcess(DWORD pid);
std::vector<std::wstring> Resolve(const std::wstring& host, HostErr& e);

// Platform facts for info().
std::wstring OsVersionText();
std::wstring LocaleName();
std::wstring HostName();
std::wstring TempDir();
std::vector<std::pair<std::wstring, std::wstring>> Environment();
int CpuCount();

}  // namespace payesh
