/*
 * pw7selftest.exe — proves that every Windows 7 implementation in pw7.dll behaves like the
 * real Windows 8+ function (row 168). Run on Windows 10/11: the real functions come from the
 * system DLLs, the Windows 7 ones from pw7.dll loaded with PAYESH_W7SHIM_FORCE=1.
 * Output: one "PASS"/"FAIL" line per check and "PW7-SELFTEST-OK n" (exit 0) or exit 1.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

typedef HRESULT(WINAPI *t_alloc)(PCWSTR, ULONG, PWSTR *);
typedef HRESULT(WINAPI *t_combine)(PWSTR, SIZE_T, PCWSTR, PCWSTR, ULONG);
typedef HRESULT(WINAPI *t_remove)(PWSTR, SIZE_T);
typedef VOID(WINAPI *t_limits)(PULONG_PTR, PULONG_PTR);
typedef BOOL(WINAPI *t_wait)(volatile VOID *, PVOID, SIZE_T, DWORD);
typedef VOID(WINAPI *t_wake)(PVOID);
typedef int(WSAAPI *t_host)(PWSTR, int);
typedef VOID(WINAPI *t_time)(LPFILETIME);
typedef HANDLE(WINAPI *t_cf2)(LPCWSTR, DWORD, DWORD, DWORD, void *);
typedef HRESULT(WINAPI *t_copy2)(PCWSTR, PCWSTR, void *);
typedef int(WINAPI *t_info)(void);
#ifdef _WIN64
typedef DWORD(NTAPI *t_addgrow)(PVOID *, PRUNTIME_FUNCTION, DWORD, DWORD, ULONG_PTR, ULONG_PTR);
typedef VOID(NTAPI *t_delgrow)(PVOID);
#endif

static int g_pass = 0, g_fail = 0;

static void check(int ok, const char *what, const wchar_t *detail) {
  if (ok) {
    g_pass++;
    printf("PASS %s\n", what);
  } else {
    g_fail++;
    printf("FAIL %s %ls\n", what, detail ? detail : L"");
  }
}

static FARPROC sys(const wchar_t *dll, const char *name) {
  HMODULE h = LoadLibraryW(dll);
  return h ? GetProcAddress(h, name) : NULL;
}

static const wchar_t *kCanon[] = {
    L"C:\\a\\b\\c.txt", L"C:\\a\\.\\b\\..\\c", L"C:\\a\\b\\..\\..\\..\\x", L"C:\\", L"C:\\a\\", L"C:\\a\\.",
    L"C:\\a\\..", L"C:\\a\\..\\", L"C:\\a\\b\\.\\", L"\\\\server\\share\\a\\..\\b", L"\\\\server\\share",
    L"\\\\server\\share\\", L"\\\\?\\C:\\a\\..\\b", L"\\\\?\\UNC\\srv\\shr\\x\\..\\y", L"C:\\Program Files\\Payesh\\data\\app.so",
    L"C:\\Users\\R.M\\AppData\\Local\\Payesh\\..\\Payesh\\db.sqlite", L"C:\\پوشه\\فایل.txt", L"C:\\a..b\\c.",
    L"C:\\a\\...\\b", L"D:\\x\\y\\z\\..\\..", L"C:\\a\\b\\..\\..", L"C:\\a.\\b", L"C:\\a\\b..",
    L"C:\\a\\b. ", L"C:\\a\\b.\\", L"C:\\a\\..\\..\\", L"\\\\srv\\shr\\a\\..", L"\\\\srv\\shr\\..\\x",
    L"\\\\?\\C:\\a\\..", L"\\\\?\\UNC\\srv\\shr\\a\\..", L"C:\\a\\\\b", L"C:\\.\\a", L"C:\\..\\a", L"\\\\?\\C:\\a\\c.", L"\\\\?\\C:\\a\\\\b",
    L"\\\\srv\\shr\\a\\\\b\\..", L"C:\\a\\\\..\\b", L"C:\\a\\b\\\\", NULL};

static const wchar_t *kCombine[][2] = {{L"C:\\a\\b", L"c.txt"},     {L"C:\\a\\b\\", L"..\\c"},
                                       {L"C:\\a\\b", L"D:\\x"},      {L"C:\\a\\b", L"\\x\\y"},
                                       {L"C:\\a", L"..\\..\\..\\x"}, {L"\\\\srv\\shr\\a", L"..\\b"},
                                       {L"C:\\a\\b", L".\\c\\.\\d"}, {L"C:\\", L"x"},
                                       {L"C:\\a\\b", L""},           {L"\\\\?\\C:\\a", L"..\\b"},
                                       {L"C:\\a\\Link", L"..\\Dir\\MyFile"}, {NULL, NULL}};

static const wchar_t *kRemove[] = {L"\\\\srv\\shr\\", L"\\\\?\\UNC\\srv\\shr\\x", L"C:", L"C:a", L"\\x", L"C:\\a\\b\\c.txt", L"C:\\a", L"C:\\", L"C:\\a\\b\\", L"\\\\srv\\shr\\x",
                                   L"\\\\srv\\shr", L"\\\\?\\C:\\a\\b", L"\\\\?\\C:\\", L"a\\b", L"a", NULL};

static volatile LONG g_word = 0;
static t_wait g_wait;
static t_wake g_wake1;

static DWORD WINAPI waker(LPVOID p) {
  (void)p;
  Sleep(150);
  InterlockedExchange(&g_word, 1);
  g_wake1((PVOID)&g_word);
  return 0;
}

static volatile LONG g_counter = 0;
static volatile LONG g_ticket = 0;
static DWORD WINAPI hammer(LPVOID p) {
  int i;
  (void)p;
  for (i = 0; i < 20000; i++) {
    LONG v;
    /* spin-lock built on WaitOnAddress: 0 = free, 1 = held */
    while ((v = InterlockedCompareExchange(&g_ticket, 1, 0)) != 0) {
      LONG one = 1;
      g_wait(&g_ticket, &one, sizeof(LONG), INFINITE);
    }
    g_counter++;
    InterlockedExchange(&g_ticket, 0);
    g_wake1((PVOID)&g_ticket);
  }
  return 0;
}

int wmain(void) {
  HMODULE shim;
  t_alloc a_real, a_shim;
  t_combine c_real, c_shim;
  t_remove r_real, r_shim;
  t_limits l_real, l_shim;
  t_host h_real, h_shim;
  t_time t_real, t_shim;
  t_cf2 cf2;
  t_copy2 cp2;
  t_info info;
  int i;
  wchar_t msg[2048];

  SetEnvironmentVariableW(L"PAYESH_W7SHIM_FORCE", L"1");
  shim = LoadLibraryW(L"pw7.dll");
  if (!shim) {
    printf("FAIL load pw7.dll (%lu)\n", GetLastError());
    return 1;
  }
  info = (t_info)(void *)GetProcAddress(shim, "pw7_Info");
  check(info && info() == 1, "windows7-implementations-active", NULL);

  a_real = (t_alloc)(void *)sys(L"api-ms-win-core-path-l1-1-0.dll", "PathAllocCanonicalize");
  a_shim = (t_alloc)(void *)GetProcAddress(shim, "PathAllocCanonicalize");
  c_real = (t_combine)(void *)sys(L"api-ms-win-core-path-l1-1-0.dll", "PathCchCombineEx");
  c_shim = (t_combine)(void *)GetProcAddress(shim, "PathCchCombineEx");
  r_real = (t_remove)(void *)sys(L"api-ms-win-core-path-l1-1-0.dll", "PathCchRemoveFileSpec");
  r_shim = (t_remove)(void *)GetProcAddress(shim, "PathCchRemoveFileSpec");

  if (a_real && a_shim) {
    ULONG flagsets[] = {0, 0x10 /* ENSURE_IS_EXTENDED_LENGTH_PATH */, 0x1 /* ALLOW_LONG_PATHS */};
    int f;
    for (f = 0; f < 3; f++) {
      for (i = 0; kCanon[i]; i++) {
        PWSTR x = NULL, y = NULL;
        HRESULT hx = a_real(kCanon[i], flagsets[f], &x), hy = a_shim(kCanon[i], flagsets[f], &y);
        int ok = (hx == hy) && (FAILED(hx) || wcscmp(x, y) == 0);
        swprintf(msg, 2048, L"flags=0x%lx in=[%ls] real=%08lx[%ls] w7=%08lx[%ls]", flagsets[f], kCanon[i],
                 (unsigned long)hx, SUCCEEDED(hx) ? x : L"", (unsigned long)hy, SUCCEEDED(hy) ? y : L"");
        check(ok, "PathAllocCanonicalize", msg);
        if (!ok) printf("     %ls\n", msg);
        if (x) LocalFree(x);
        if (y) LocalFree(y);
      }
    }
    {
      /* a path longer than MAX_PATH, as Dart builds for every file it opens */
      static wchar_t longp[1200];
      PWSTR x = NULL, y = NULL;
      HRESULT hx, hy;
      wcscpy(longp, L"C:\\");
      for (i = 0; i < 60; i++) wcscat(longp, L"segment_____\\");
      wcscat(longp, L"..\\file.txt");
      for (f = 0; f < 3; f++) {
        x = NULL;
        y = NULL;
        hx = a_real(longp, flagsets[f], &x);
        hy = a_shim(longp, flagsets[f], &y);
        swprintf(msg, 2048, L"long flags=0x%lx real=%08lx[%.40ls] w7=%08lx[%.40ls]", flagsets[f], (unsigned long)hx,
                 SUCCEEDED(hx) ? x : L"", (unsigned long)hy, SUCCEEDED(hy) ? y : L"");
        check(hx == hy && (FAILED(hx) || wcscmp(x, y) == 0), "PathAllocCanonicalize-long", msg);
        if (x) LocalFree(x);
        if (y) LocalFree(y);
      }
      {
        static wchar_t longx[1300];
        wcscpy(longx, L"\\\\?\\");
        wcscat(longx, longp);
        for (f = 0; f < 3; f++) {
          x = NULL;
          y = NULL;
          hx = a_real(longx, flagsets[f], &x);
          hy = a_shim(longx, flagsets[f], &y);
          swprintf(msg, 2048, L"longx flags=0x%lx real=%08lx[%.40ls] w7=%08lx[%.40ls]", flagsets[f], (unsigned long)hx,
                   SUCCEEDED(hx) ? x : L"", (unsigned long)hy, SUCCEEDED(hy) ? y : L"");
          check(hx == hy && (FAILED(hx) || wcscmp(x, y) == 0), "PathAllocCanonicalize-longx", msg);
          if (x) LocalFree(x);
          if (y) LocalFree(y);
        }
      }
    }
  } else {
    check(0, "PathAllocCanonicalize-present", NULL);
  }

  if (c_real && c_shim) {
    for (i = 0; kCombine[i][0]; i++) {
      wchar_t x[600], y[600];
      HRESULT hx = c_real(x, 600, kCombine[i][0], kCombine[i][1], 1),
              hy = c_shim(y, 600, kCombine[i][0], kCombine[i][1], 1);
      int ok = (hx == hy) && (FAILED(hx) || wcscmp(x, y) == 0);
      swprintf(msg, 2048, L"in=[%ls]+[%ls] real=%08lx[%ls] w7=%08lx[%ls]", kCombine[i][0], kCombine[i][1],
               (unsigned long)hx, SUCCEEDED(hx) ? x : L"", (unsigned long)hy, SUCCEEDED(hy) ? y : L"");
      check(ok, "PathCchCombineEx", msg);
      if (!ok) printf("     %ls\n", msg);
    }
    {
      /* in-place, exactly like Dart's File::CreateLink */
      wchar_t x[64] = L"C:\\A\\B\\", y[64] = L"C:\\A\\B\\";
      HRESULT hx = c_real(x, 64, x, L"MyFile", 1), hy = c_shim(y, 64, y, L"MyFile", 1);
      check(hx == hy && wcscmp(x, y) == 0, "PathCchCombineEx-inplace", NULL);
      hx = c_real(x, 8, L"C:\\abc", L"defghijk", 1);
      hy = c_shim(y, 8, L"C:\\abc", L"defghijk", 1);
      swprintf(msg, 2048, L"small buffer real=%08lx w7=%08lx", (unsigned long)hx, (unsigned long)hy);
      check(hx == hy, "PathCchCombineEx-small-buffer", msg);
    }
  } else {
    check(0, "PathCchCombineEx-present", NULL);
  }

  if (r_real && r_shim) {
    for (i = 0; kRemove[i]; i++) {
      wchar_t x[300], y[300];
      HRESULT hx, hy;
      wcscpy(x, kRemove[i]);
      wcscpy(y, kRemove[i]);
      hx = r_real(x, 300);
      hy = r_shim(y, 300);
      swprintf(msg, 2048, L"in=[%ls] real=%08lx[%ls] w7=%08lx[%ls]", kRemove[i], (unsigned long)hx, x,
               (unsigned long)hy, y);
      check(hx == hy && wcscmp(x, y) == 0, "PathCchRemoveFileSpec", msg);
      if (!(hx == hy && wcscmp(x, y) == 0)) printf("     %ls\n", msg);
    }
  } else {
    check(0, "PathCchRemoveFileSpec-present", NULL);
  }

  l_real = (t_limits)(void *)sys(L"kernel32.dll", "GetCurrentThreadStackLimits");
  l_shim = (t_limits)(void *)GetProcAddress(shim, "GetCurrentThreadStackLimits");
  if (l_real && l_shim) {
    ULONG_PTR a = 0, b = 0, c = 0, d = 0;
    l_real(&a, &b);
    l_shim(&c, &d);
    swprintf(msg, 2048, L"real=%p..%p w7=%p..%p", (void *)a, (void *)b, (void *)c, (void *)d);
    check(a == c && b == d && a < b, "GetCurrentThreadStackLimits", msg);
  } else {
    check(0, "GetCurrentThreadStackLimits-present", NULL);
  }

  g_wait = (t_wait)(void *)GetProcAddress(shim, "WaitOnAddress");
  g_wake1 = (t_wake)(void *)GetProcAddress(shim, "WakeByAddressSingle");
  if (g_wait && g_wake1) {
    LONG zero = 0, one = 1;
    DWORD t0;
    BOOL r;
    HANDLE th, hs[4];
    r = g_wait(&g_word, &one, sizeof(LONG), 0); /* value differs -> immediate TRUE */
    check(r == TRUE, "WaitOnAddress-differs", NULL);
    t0 = GetTickCount();
    r = g_wait(&g_word, &zero, sizeof(LONG), 120);
    check(r == FALSE && GetLastError() == ERROR_TIMEOUT && GetTickCount() - t0 >= 100, "WaitOnAddress-timeout", NULL);
    th = CreateThread(NULL, 0, waker, NULL, 0, NULL);
    t0 = GetTickCount();
    while (g_word == 0) g_wait(&g_word, &zero, sizeof(LONG), 5000);
    check(g_word == 1 && GetTickCount() - t0 < 4000, "WaitOnAddress-woken", NULL);
    WaitForSingleObject(th, INFINITE);
    CloseHandle(th);
    for (i = 0; i < 4; i++) hs[i] = CreateThread(NULL, 0, hammer, NULL, 0, NULL);
    WaitForMultipleObjects(4, hs, TRUE, 60000);
    for (i = 0; i < 4; i++) CloseHandle(hs[i]);
    swprintf(msg, 2048, L"counter=%ld", g_counter);
    check(g_counter == 80000, "WaitOnAddress-lock-80000", msg);
  } else {
    check(0, "WaitOnAddress-present", NULL);
  }

  h_real = (t_host)(void *)sys(L"ws2_32.dll", "GetHostNameW");
  h_shim = (t_host)(void *)GetProcAddress(shim, "GetHostNameW");
  if (h_real && h_shim) {
    WSADATA wd;
    wchar_t x[256], y[256];
    int rx, ry;
    WSAStartup(MAKEWORD(2, 2), &wd);
    rx = h_real(x, 256);
    ry = h_shim(y, 256);
    swprintf(msg, 2048, L"real=%d[%ls] w7=%d[%ls]", rx, x, ry, y);
    check(rx == 0 && ry == 0 && _wcsicmp(x, y) == 0, "GetHostNameW", msg);
    ry = h_shim(y, 1);
    check(ry == SOCKET_ERROR && WSAGetLastError() == WSAEFAULT, "GetHostNameW-small", NULL);
  } else {
    check(0, "GetHostNameW-present", NULL);
  }

  t_real = (t_time)(void *)sys(L"kernel32.dll", "GetSystemTimePreciseAsFileTime");
  t_shim = (t_time)(void *)GetProcAddress(shim, "GetSystemTimePreciseAsFileTime");
  if (t_real && t_shim) {
    FILETIME x, y;
    ULONGLONG ux, uy, diff;
    t_real(&x);
    t_shim(&y);
    ux = ((ULONGLONG)x.dwHighDateTime << 32) | x.dwLowDateTime;
    uy = ((ULONGLONG)y.dwHighDateTime << 32) | y.dwLowDateTime;
    diff = ux > uy ? ux - uy : uy - ux;
    check(diff < 1000000ULL /* 100 ms */, "GetSystemTimePreciseAsFileTime", NULL);
  } else {
    check(0, "GetSystemTimePreciseAsFileTime-present", NULL);
  }

  cf2 = (t_cf2)(void *)GetProcAddress(shim, "CreateFile2");
  cp2 = (t_copy2)(void *)GetProcAddress(shim, "CopyFile2");
  if (cf2 && cp2) {
    wchar_t dir[MAX_PATH], f1[MAX_PATH], f2[MAX_PATH];
    HANDLE h;
    DWORD w = 0;
    struct {
      DWORD dwSize, dwFileAttributes, dwFileFlags, dwSecurityQosFlags;
      LPSECURITY_ATTRIBUTES sa;
      HANDLE t;
    } ext;
    struct {
      DWORD dwSize, dwCopyFlags;
      BOOL *pfCancel;
      void *prog;
      PVOID ctx;
    } cext;
    HRESULT hr;
    GetTempPathW(MAX_PATH, dir);
    swprintf(f1, MAX_PATH, L"%lspw7-%lu-a.txt", dir, GetCurrentProcessId());
    swprintf(f2, MAX_PATH, L"%lspw7-%lu-b.txt", dir, GetCurrentProcessId());
    memset(&ext, 0, sizeof ext);
    ext.dwSize = sizeof ext;
    ext.dwFileAttributes = FILE_ATTRIBUTE_NORMAL;
    h = cf2(f1, GENERIC_WRITE, 0, CREATE_ALWAYS, &ext);
    check(h != INVALID_HANDLE_VALUE && WriteFile(h, "payesh", 6, &w, NULL) && w == 6, "CreateFile2-write", NULL);
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    h = cf2(f1, GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING, NULL);
    check(h != INVALID_HANDLE_VALUE, "CreateFile2-open-null-params", NULL);
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    h = cf2(L"Z:\\definitely\\missing\\file", GENERIC_READ, 0, OPEN_EXISTING, NULL);
    check(h == INVALID_HANDLE_VALUE && (GetLastError() == ERROR_PATH_NOT_FOUND || GetLastError() == ERROR_FILE_NOT_FOUND),
          "CreateFile2-missing", NULL);
    memset(&cext, 0, sizeof cext);
    cext.dwSize = sizeof cext;
    hr = cp2(f1, f2, &cext);
    check(hr == S_OK && GetFileAttributesW(f2) != INVALID_FILE_ATTRIBUTES, "CopyFile2", NULL);
    cext.dwCopyFlags = 1; /* FAIL_IF_EXISTS */
    hr = cp2(f1, f2, &cext);
    check(hr == HRESULT_FROM_WIN32(ERROR_FILE_EXISTS), "CopyFile2-fail-if-exists", NULL);
    DeleteFileW(f1);
    DeleteFileW(f2);
  } else {
    check(0, "CreateFile2/CopyFile2-present", NULL);
  }

#ifdef _WIN64
  {
    t_addgrow add = (t_addgrow)(void *)GetProcAddress(shim, "RtlAddGrowableFunctionTable");
    t_delgrow del = (t_delgrow)(void *)GetProcAddress(shim, "RtlDeleteGrowableFunctionTable");
    if (add && del) {
      BYTE *mem = (BYTE *)VirtualAlloc(NULL, 65536, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
      RUNTIME_FUNCTION *rf = (RUNTIME_FUNCTION *)(mem + 60000);
      PVOID table = NULL;
      DWORD st;
      DWORD64 base = 0;
      PRUNTIME_FUNCTION found;
      BYTE *unwind = mem + 61000;
      mem[0] = 0xC3; /* ret */
      unwind[0] = 1;  /* UNWIND_INFO v1, no codes */
      rf->BeginAddress = 0;
      rf->EndAddress = 1;
      rf->UnwindData = 61000;
      st = add(&table, rf, 1, 1, (ULONG_PTR)mem, (ULONG_PTR)mem + 65536);
      found = RtlLookupFunctionEntry((DWORD64)mem, &base, NULL);
      check(st == 0 && table != NULL && found == rf && base == (DWORD64)mem, "RtlAddGrowableFunctionTable", NULL);
      del(table);
      found = RtlLookupFunctionEntry((DWORD64)mem, &base, NULL);
      check(found == NULL, "RtlDeleteGrowableFunctionTable", NULL);
      VirtualFree(mem, 0, MEM_RELEASE);
    } else {
      check(0, "RtlAddGrowableFunctionTable-present", NULL);
    }
  }
#endif

  if (g_fail) {
    printf("PW7-SELFTEST-FAILED pass=%d fail=%d\n", g_pass, g_fail);
    return 1;
  }
  printf("PW7-SELFTEST-OK %d\n", g_pass);
  return 0;
}
