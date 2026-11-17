/*
 * pw7run.exe — start a GUI program on a private, invisible desktop, let it run for N seconds,
 * report whether it is still alive and which windows it created, then kill it (and its
 * children, via a job object). Used to smoke-test the Windows 7 patched builds on a machine
 * someone is using, without ever taking the foreground.
 *
 *   pw7run.exe <seconds> <program> [arguments...]
 * prints: PW7RUN-ALIVE pid=<pid> windows=<n> visible=<n> classes=<list>   (exit 0)
 *     or: PW7RUN-EXITED code=0x<code>                                       (exit 1)
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static DWORD g_pid;
static int g_windows, g_visible;
static wchar_t g_classes[1024];

static BOOL CALLBACK onWindow(HWND w, LPARAM lp) {
  DWORD pid = 0;
  (void)lp;
  GetWindowThreadProcessId(w, &pid);
  if (pid == g_pid) {
    wchar_t cls[128];
    g_windows++;
    if (IsWindowVisible(w)) g_visible++;
    if (GetClassNameW(w, cls, 128) && wcslen(g_classes) + wcslen(cls) + 2 < 1024) {
      if (!wcsstr(g_classes, cls)) {
        if (g_classes[0]) wcscat(g_classes, L",");
        wcscat(g_classes, cls);
      }
    }
  }
  return TRUE;
}

int wmain(int argc, wchar_t **argv) {
  wchar_t cmd[4096] = L"";
  int i, secs;
  HDESK desk;
  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  HANDLE job;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim;
  DWORD code = 0;
  if (argc < 3) {
    fwprintf(stderr, L"usage: pw7run <seconds> <program> [args]\n");
    return 2;
  }
  secs = _wtoi(argv[1]);
  for (i = 2; i < argc; i++) {
    if (i > 2) wcscat(cmd, L" ");
    wcscat(cmd, L"\"");
    wcscat(cmd, argv[i]);
    wcscat(cmd, L"\"");
  }
  desk = CreateDesktopW(L"pw7test", NULL, NULL, 0, GENERIC_ALL, NULL);
  if (!desk) {
    fwprintf(stderr, L"CreateDesktop failed %lu\n", GetLastError());
    return 2;
  }
  job = CreateJobObjectW(NULL, NULL);
  ZeroMemory(&lim, sizeof lim);
  lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(job, JobObjectExtendedLimitInformation, &lim, sizeof lim);
  ZeroMemory(&si, sizeof si);
  si.cb = sizeof si;
  si.lpDesktop = L"WinSta0\\pw7test";
  if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_SUSPENDED, NULL, NULL, &si, &pi)) {
    fwprintf(stderr, L"CreateProcess failed %lu\n", GetLastError());
    return 2;
  }
  AssignProcessToJobObject(job, pi.hProcess);
  ResumeThread(pi.hThread);
  g_pid = pi.dwProcessId;
  if (WaitForSingleObject(pi.hProcess, (DWORD)secs * 1000) == WAIT_OBJECT_0) {
    GetExitCodeProcess(pi.hProcess, &code);
    wprintf(L"PW7RUN-EXITED code=0x%08lx\n", code);
    CloseHandle(job);
    CloseDesktop(desk);
    return 1;
  }
  EnumDesktopWindows(desk, onWindow, 0);
  wprintf(L"PW7RUN-ALIVE pid=%lu windows=%d visible=%d classes=%ls\n", g_pid, g_windows, g_visible, g_classes);
  fflush(stdout);
  TerminateJobObject(job, 0);
  WaitForSingleObject(pi.hProcess, 5000);
  CloseHandle(job);
  CloseDesktop(desk);
  return 0;
}
