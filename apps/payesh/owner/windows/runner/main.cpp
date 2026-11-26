#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>

#include <string>

#include "flutter_window.h"
#include "utils.h"

namespace {

// Row 196: up to build 1.1.223 the owner panel capped ITSELF with a Windows Job
// Object (CPU rate control, HARD_CAP). On the owner's PC that was 10% of 8 cores
// for the whole process, UI and raster threads included, so every page stuttered.
// The cap is gone from the code, but a job is inherited by every child process:
// the old build's update script (cmd -> powershell -> Start-Process) starts the
// new build INSIDE the old capped job. If this process is in such a job, hand the
// launch to the Windows shell (explorer.exe "<this exe>", the same as a double
// click; tested on the owner's PC: the started program is outside the job) and
// exit with code 0 (the update health check treats exit 0 as healthy).
struct CpuRateInfo {
  DWORD control_flags;
  DWORD cpu_rate;
};

bool InHardCpuCapJob() {
  BOOL in_job = FALSE;
  if (!::IsProcessInJob(::GetCurrentProcess(), nullptr, &in_job) || !in_job) {
    return false;
  }
  CpuRateInfo info = {};
  // 15 = JobObjectCpuRateControlInformation (Windows 8+; fails on Windows 7).
  if (!::QueryInformationJobObject(nullptr, static_cast<JOBOBJECTINFOCLASS>(15),
                                   &info, sizeof(info), nullptr)) {
    return false;
  }
  const DWORD kEnable = 0x1, kHardCap = 0x4;
  return (info.control_flags & kEnable) && (info.control_flags & kHardCap) &&
         info.cpu_rate < 10000;
}

// True when a fresh copy was started outside the job (this one should exit).
bool EscapeCpuCapJob() {
  if (!InHardCpuCapJob()) return false;
  wchar_t local[MAX_PATH];
  const DWORD n = ::GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return false;
  const std::wstring dir = std::wstring(local) + L"\\PayeshOwner";
  const std::wstring stamp = dir + L"\\cpu-job-escape.stamp";
  // Never loop: if a hand-off happened in the last minute, just run (capped).
  WIN32_FILE_ATTRIBUTE_DATA fa;
  if (::GetFileAttributesExW(stamp.c_str(), GetFileExInfoStandard, &fa)) {
    FILETIME now;
    ::GetSystemTimeAsFileTime(&now);
    ULARGE_INTEGER a, b;
    a.LowPart = fa.ftLastWriteTime.dwLowDateTime;
    a.HighPart = fa.ftLastWriteTime.dwHighDateTime;
    b.LowPart = now.dwLowDateTime;
    b.HighPart = now.dwHighDateTime;
    if (b.QuadPart >= a.QuadPart && b.QuadPart - a.QuadPart < 600000000ULL) {
      return false;
    }
  }
  ::CreateDirectoryW(dir.c_str(), nullptr);
  HANDLE f = ::CreateFileW(stamp.c_str(), GENERIC_WRITE, 0, nullptr,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;  // no stamp => no hand-off
  ::CloseHandle(f);
  wchar_t exe[32768];
  const DWORD el = ::GetModuleFileNameW(nullptr, exe, 32768);
  if (el == 0 || el >= 32768) return false;
  wchar_t win[MAX_PATH];
  const UINT wl = ::GetWindowsDirectoryW(win, MAX_PATH);
  if (wl == 0 || wl >= MAX_PATH) return false;
  const std::wstring explorer = std::wstring(win) + L"\\explorer.exe";
  std::wstring cmd = L"\"" + explorer + L"\" \"" + std::wstring(exe) + L"\"";
  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi = {};
  if (!::CreateProcessW(explorer.c_str(), &cmd[0], nullptr, nullptr, FALSE, 0,
                        nullptr, nullptr, &si, &pi)) {
    return false;
  }
  ::CloseHandle(pi.hThread);
  ::CloseHandle(pi.hProcess);
  return true;
}

}  // namespace

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Row 196: never run inside an old self-imposed hard CPU cap (see above).
  if (EscapeCpuCapJob()) {
    return EXIT_SUCCESS;
  }

  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1280, 720);
  if (!window.Create(L"\u067E\u0646\u0644 \u0645\u0627\u0644\u06A9 \u067E\u0627\u06CC\u0634", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
