/*
 * pw7.dll — Windows 7 / 8 compatibility layer for Payesh (row 168).
 *
 * Why: the Flutter engine (flutter_windows.dll), the MSVC C++ runtime (msvcp140.dll) and
 * Node.js 22 (node.exe) import a handful of functions that only exist since Windows 8.
 * On Windows 7 the loader refuses such a binary outright ("entry point not found"), so the
 * program never starts. tools/win7/w7patch.mjs renames, inside those binaries, every import
 * descriptor that contains such a function (e.g. "KERNEL32.dll", "WS2_32.dll") to "pw7.dll";
 * this DLL then
 *   - implements each Windows 8+ function: it calls the REAL function whenever the running
 *     Windows has it (Windows 8, 10, 11 behave exactly as before) and otherwise a faithful
 *     Windows 7 implementation built from Windows 7 APIs;
 *   - forwards every other function of the renamed descriptors to the original DLL
 *     (export forwarders generated into pw7.def by w7patch.mjs), resolved by the loader.
 *
 * PAYESH_W7SHIM_FORCE=1 forces the Windows 7 implementations on any Windows (tests/CI).
 * PAYESH_W7SHIM_LOG=<file> appends "PW7-FALLBACK <pid> <function>" the first time a process
 * uses the Windows 7 implementation of a function (proof that the path ran).
 * No C runtime: only kernel32 / ws2_32 / ntdll-through-kernel32 are used.
 */
#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <winsock2.h>
#include <windows.h>

#ifdef _MSC_VER
#pragma comment(lib, "kernel32.lib")
#pragma comment(lib, "ws2_32.lib")
#endif

typedef LONG PW7_NTSTATUS;

static volatile LONG g_force = -1;

static int pw7_forced(void) {
  if (g_force < 0) {
    WCHAR v[4];
    DWORD n = GetEnvironmentVariableW(L"PAYESH_W7SHIM_FORCE", v, 4);
    g_force = (n == 1 && v[0] == L'1') ? 1 : 0;
  }
  return g_force;
}

/* Address of the real function in a system DLL, or NULL (Windows 7, or forced). */
static FARPROC pw7_real(const WCHAR *dll, const char *name) {
  HMODULE h;
  if (pw7_forced()) return NULL;
  h = GetModuleHandleW(dll);
  if (!h) h = LoadLibraryW(dll);
  if (!h) return NULL;
  return GetProcAddress(h, name);
}

/* First use of a fallback: one line in %PAYESH_W7SHIM_LOG% (if set). */
static void pw7_note(const char *name) {
  WCHAR path[520];
  char line[160];
  DWORD n = GetEnvironmentVariableW(L"PAYESH_W7SHIM_LOG", path, 520), pid, len = 0, w;
  HANDLE h;
  const char *pre = "PW7-FALLBACK ";
  char num[16];
  int k = 0;
  if (n == 0 || n >= 520) return;
  while (*pre) line[len++] = *pre++;
  pid = GetCurrentProcessId();
  do {
    num[k++] = (char)('0' + pid % 10);
    pid /= 10;
  } while (pid && k < 15);
  while (k) line[len++] = num[--k];
  line[len++] = ' ';
  while (*name && len < sizeof(line) - 3) line[len++] = *name++;
  line[len++] = '\r';
  line[len++] = '\n';
  h = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (h == INVALID_HANDLE_VALUE) return;
  WriteFile(h, line, len, &w, NULL);
  CloseHandle(h);
}

#define PW7_RESOLVE(var, type, dll, name)                       \
  static volatile LONG var##_done = 0;                          \
  static type var = NULL;                                       \
  if (!var##_done) {                                            \
    var = (type)(void *)pw7_real(dll, name);                    \
    if (InterlockedExchange(&var##_done, 1) == 0 && !var) pw7_note(name); \
  }

/* ───────────────────────── tiny helpers (no CRT) ───────────────────────── */

static SIZE_T pw7_wcslen(const WCHAR *s) {
  SIZE_T n = 0;
  if (!s) return 0;
  while (s[n]) n++;
  return n;
}

static void pw7_wmemcpy(WCHAR *d, const WCHAR *s, SIZE_T n) {
  SIZE_T i;
  if (d < s) {
    for (i = 0; i < n; i++) d[i] = s[i];
  } else {
    for (i = n; i > 0; i--) d[i - 1] = s[i - 1];
  }
}

static int pw7_isalpha(WCHAR c) { return (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z'); }

static WCHAR pw7_upper(WCHAR c) { return (c >= L'a' && c <= L'z') ? (WCHAR)(c - 32) : c; }

static int pw7_prefix(const WCHAR *s, const WCHAR *p) {
  while (*p) {
    if (pw7_upper(*s) != pw7_upper(*p)) return 0;
    s++;
    p++;
  }
  return 1;
}

static WCHAR *pw7_alloc(SIZE_T cch) {
  return (WCHAR *)HeapAlloc(GetProcessHeap(), 0, cch * sizeof(WCHAR));
}

static void pw7_free(void *p) {
  if (p) HeapFree(GetProcessHeap(), 0, p);
}

/* ───────────────────────── kernel32: time ───────────────────────── */

typedef VOID(WINAPI *pfn_GetSystemTimePreciseAsFileTime)(LPFILETIME);

VOID WINAPI pw7_GetSystemTimePreciseAsFileTime(LPFILETIME ft) {
  PW7_RESOLVE(real, pfn_GetSystemTimePreciseAsFileTime, L"kernel32.dll", "GetSystemTimePreciseAsFileTime");
  if (real) {
    real(ft);
    return;
  }
  GetSystemTimeAsFileTime(ft);
}

/* ───────────────────────── kernel32: files ───────────────────────── */

typedef struct {
  DWORD dwSize;
  DWORD dwFileAttributes;
  DWORD dwFileFlags;
  DWORD dwSecurityQosFlags;
  LPSECURITY_ATTRIBUTES lpSecurityAttributes;
  HANDLE hTemplateFile;
} PW7_CREATEFILE2_EXTENDED_PARAMETERS;

typedef HANDLE(WINAPI *pfn_CreateFile2)(LPCWSTR, DWORD, DWORD, DWORD, PW7_CREATEFILE2_EXTENDED_PARAMETERS *);

HANDLE WINAPI pw7_CreateFile2(LPCWSTR name, DWORD access, DWORD share, DWORD disposition,
                              PW7_CREATEFILE2_EXTENDED_PARAMETERS *p) {
  DWORD flags = 0;
  LPSECURITY_ATTRIBUTES sa = NULL;
  HANDLE tmpl = NULL;
  PW7_RESOLVE(real, pfn_CreateFile2, L"kernel32.dll", "CreateFile2");
  if (real) return real(name, access, share, disposition, p);
  if (p) {
    flags = p->dwFileAttributes | p->dwFileFlags | p->dwSecurityQosFlags;
    sa = p->lpSecurityAttributes;
    tmpl = p->hTemplateFile;
  }
  return CreateFileW(name, access, share, sa, disposition, flags, tmpl);
}

typedef struct {
  DWORD dwSize;
  DWORD dwCopyFlags;
  BOOL *pfCancel;
  void *pProgressRoutine;
  PVOID pvCallbackContext;
} PW7_COPYFILE2_EXTENDED_PARAMETERS;

typedef HRESULT(WINAPI *pfn_CopyFile2)(PCWSTR, PCWSTR, PW7_COPYFILE2_EXTENDED_PARAMETERS *);

HRESULT WINAPI pw7_CopyFile2(PCWSTR src, PCWSTR dst, PW7_COPYFILE2_EXTENDED_PARAMETERS *p) {
  DWORD flags = 0;
  BOOL *cancel = NULL;
  PW7_RESOLVE(real, pfn_CopyFile2, L"kernel32.dll", "CopyFile2");
  if (real) return real(src, dst, p);
  if (p) {
    /* the CopyFileEx flags Windows 7 understands (same bit values in CopyFile2) */
    flags = p->dwCopyFlags & (0x00000001 /* FAIL_IF_EXISTS */ | 0x00000002 /* RESTARTABLE */ |
                              0x00000004 /* OPEN_SOURCE_FOR_WRITE */ |
                              0x00000008 /* ALLOW_DECRYPTED_DESTINATION */ |
                              0x00000800 /* COPY_SYMLINK */ | 0x00001000 /* NO_BUFFERING */);
    cancel = p->pfCancel;
  }
  if (CopyFileExW(src, dst, NULL, NULL, cancel, flags)) return S_OK;
  return HRESULT_FROM_WIN32(GetLastError());
}

/* ───────────────────────── kernel32: threads ───────────────────────── */

typedef VOID(WINAPI *pfn_GetCurrentThreadStackLimits)(PULONG_PTR, PULONG_PTR);

VOID WINAPI pw7_GetCurrentThreadStackLimits(PULONG_PTR low, PULONG_PTR high) {
  NT_TIB *tib;
  PW7_RESOLVE(real, pfn_GetCurrentThreadStackLimits, L"kernel32.dll", "GetCurrentThreadStackLimits");
  if (real) {
    real(low, high);
    return;
  }
  tib = (NT_TIB *)NtCurrentTeb();
  *high = (ULONG_PTR)tib->StackBase;
  /* TEB.DeallocationStack: the reserved bottom of the stack (what the real function returns) */
#ifdef _WIN64
  *low = *(ULONG_PTR *)((BYTE *)tib + 0x1478);
#else
  *low = *(ULONG_PTR *)((BYTE *)tib + 0x0E0C);
#endif
}

/* ───────────────────── api-ms-win-core-synch-l1-2-0: WaitOnAddress ───────────────────── */

#define PW7_BUCKETS 256
static SRWLOCK g_lock[PW7_BUCKETS];             /* zero == SRWLOCK_INIT */
static CONDITION_VARIABLE g_cond[PW7_BUCKETS];  /* zero == CONDITION_VARIABLE_INIT */

static unsigned pw7_bucket(volatile const void *a) {
  ULONG_PTR x = (ULONG_PTR)a;
  x ^= x >> 4;
  x ^= x >> 12;
  x ^= x >> 20;
  return (unsigned)(x % PW7_BUCKETS);
}

static int pw7_same(volatile const void *addr, const void *cmp, SIZE_T size) {
  switch (size) {
    case 1: return *(volatile const BYTE *)addr == *(const BYTE *)cmp;
    case 2: return *(volatile const WORD *)addr == *(const WORD *)cmp;
    case 4: return *(volatile const DWORD *)addr == *(const DWORD *)cmp;
    default: return *(volatile const ULONGLONG *)addr == *(const ULONGLONG *)cmp;
  }
}

typedef BOOL(WINAPI *pfn_WaitOnAddress)(volatile VOID *, PVOID, SIZE_T, DWORD);
typedef VOID(WINAPI *pfn_WakeByAddress)(PVOID);

BOOL WINAPI pw7_WaitOnAddress(volatile VOID *addr, PVOID cmp, SIZE_T size, DWORD ms) {
  unsigned b;
  BOOL ok;
  DWORD err;
  PW7_RESOLVE(real, pfn_WaitOnAddress, L"kernelbase.dll", "WaitOnAddress");
  if (real) return real(addr, cmp, size, ms);
  if (size != 1 && size != 2 && size != 4 && size != 8) {
    SetLastError(ERROR_INVALID_PARAMETER);
    return FALSE;
  }
  b = pw7_bucket(addr);
  AcquireSRWLockExclusive(&g_lock[b]);
  if (!pw7_same(addr, cmp, size)) {
    ReleaseSRWLockExclusive(&g_lock[b]);
    return TRUE;
  }
  /* a waker changes the value BEFORE taking this bucket lock, so a wake can never be lost */
  ok = SleepConditionVariableSRW(&g_cond[b], &g_lock[b], ms, 0);
  err = ok ? ERROR_SUCCESS : GetLastError();
  ReleaseSRWLockExclusive(&g_lock[b]);
  if (!ok) {
    SetLastError(err == ERROR_TIMEOUT ? ERROR_TIMEOUT : err);
    return FALSE;
  }
  return TRUE; /* spurious wake-ups are allowed by the WaitOnAddress contract */
}

static void pw7_wake(PVOID addr) {
  unsigned b = pw7_bucket(addr);
  AcquireSRWLockExclusive(&g_lock[b]);
  WakeAllConditionVariable(&g_cond[b]); /* waiters re-check their own address */
  ReleaseSRWLockExclusive(&g_lock[b]);
}

VOID WINAPI pw7_WakeByAddressSingle(PVOID addr) {
  PW7_RESOLVE(real, pfn_WakeByAddress, L"kernelbase.dll", "WakeByAddressSingle");
  if (real) {
    real(addr);
    return;
  }
  pw7_wake(addr);
}

VOID WINAPI pw7_WakeByAddressAll(PVOID addr) {
  PW7_RESOLVE(real, pfn_WakeByAddress, L"kernelbase.dll", "WakeByAddressAll");
  if (real) {
    real(addr);
    return;
  }
  pw7_wake(addr);
}

/* ───────────────────── api-ms-win-core-path-l1-1-0: PathCch* ───────────────────── */

#define PW7_PATHCCH_MAX_CCH 32768
#define PW7_MAX_PATH 260
#define PW7_ALLOW_LONG_PATHS 0x00000001
#define PW7_FORCE_ENABLE_LONG_NAME_PROCESS 0x00000002
#define PW7_FORCE_DISABLE_LONG_NAME_PROCESS 0x00000004
#define PW7_DO_NOT_NORMALIZE_SEGMENTS 0x00000008
#define PW7_ENSURE_IS_EXTENDED_LENGTH_PATH 0x00000010
#define PW7_ENSURE_TRAILING_SLASH 0x00000020
#define PW7_E_INSUFFICIENT HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER)
#define PW7_E_TOO_LONG HRESULT_FROM_WIN32(ERROR_FILENAME_EXCED_RANGE)

/*
 * Splits a path into its prefix ("\\?\", "\\?\UNC\", "\\.\" or ""), its root and the rest.
 * Returns the number of characters (prefix + root; for UNC without the separator after the
 * share). *kind: 0 none, 1 drive ("C:\"),
 * 2 drive-relative ("C:"), 3 root-relative ("\x"), 4 UNC ("\\server\share"),
 * 5 extended drive ("\\?\C:\"), 6 extended UNC ("\\?\UNC\server\share"),
 * 7 other extended/device ("\\?\Volume{..}\", "\\.\pipe\")
 */
static SIZE_T pw7_root(const WCHAR *p, SIZE_T n, int *kind) {
  SIZE_T i, parts;
  *kind = 0;
  if (n >= 4 && p[0] == L'\\' && p[1] == L'\\' && (p[2] == L'?' || p[2] == L'.') && p[3] == L'\\') {
    if (p[2] == L'?' && n >= 8 && pw7_prefix(p + 4, L"UNC\\")) {
      i = 8;
      parts = 0;
      while (i < n) {
        if (p[i] == L'\\') {
          if (++parts == 2) break;
        }
        i++;
      }
      *kind = 6;
      return i;
    }
    if (n >= 6 && pw7_isalpha(p[4]) && p[5] == L':') {
      *kind = 5;
      return (n >= 7 && p[6] == L'\\') ? 7 : 6;
    }
    i = 4;
    while (i < n && p[i] != L'\\') i++;
    *kind = 7;
    return i < n ? i + 1 : n;
  }
  if (n >= 2 && p[0] == L'\\' && p[1] == L'\\') {
    i = 2;
    parts = 0;
    while (i < n) {
      if (p[i] == L'\\') {
        if (++parts == 2) break;
      }
      i++;
    }
    *kind = 4;
    return i;
  }
  if (n >= 2 && pw7_isalpha(p[0]) && p[1] == L':') {
    if (n >= 3 && p[2] == L'\\') {
      *kind = 1;
      return 3;
    }
    *kind = 2;
    return 2;
  }
  if (n >= 1 && p[0] == L'\\') {
    *kind = 3;
    return 1;
  }
  return 0;
}

/*
 * Canonicalises src into a new heap buffer like PathAllocCanonicalize: removes "." and ".."
 * segments (never above the root) and the trailing dots of the last segment; the "\\?\" form
 * is used when asked for (ENSURE_IS_EXTENDED_LENGTH_PATH) or when a long path needs it, and
 * dropped when the path fits in MAX_PATH. Returns S_OK and *out (HeapAlloc).
 * (Matched against the real function by tools/win7/pw7selftest.c.)
 */
static HRESULT pw7_canon(const WCHAR *src, ULONG flags, WCHAR **out, SIZE_T *outLen) {
  SIZE_T n = pw7_wcslen(src), rl, i, o, rootFrom, nt = 0, t, plainLen;
  SIZE_T *ts, *tl; /* segment start / length; empty segments are kept ("a\\b") */
  int kind, hadSeg = 0, ext;
  WCHAR *buf;
  *out = NULL;
  if (n >= PW7_PATHCCH_MAX_CCH) return PW7_E_TOO_LONG;
  rl = pw7_root(src, n, &kind);
  if (kind == 4 || kind == 6) {
    /* for "." / ".." the share is an ordinary segment: "\\srv\shr\..\x" -> "\\srv\x" */
    rl = (kind == 4) ? 2 : 8;
    while (rl < n && src[rl] != L'\\') rl++;
    if (rl < n) rl++;
  }
  ts = (SIZE_T *)HeapAlloc(GetProcessHeap(), 0, (n + 2) * 2 * sizeof(SIZE_T));
  if (!ts) return E_OUTOFMEMORY;
  tl = ts + n + 2;
  if (rl < n) {
    i = rl;
    for (;;) {
      SIZE_T st = i, len;
      while (i < n && src[i] != L'\\') i++;
      len = i - st;
      if (len == 1 && src[st] == L'.') {
        hadSeg = 1;
      } else if (len == 2 && src[st] == L'.' && src[st + 1] == L'.') {
        hadSeg = 1;
        if (nt > 0) nt--;
      } else {
        if (len) hadSeg = 1;
        ts[nt] = st;
        tl[nt] = len;
        nt++;
      }
      if (i >= n) break;
      i++; /* separator */
      if (i == n) { /* trailing separator == one empty last segment */
        ts[nt] = n;
        tl[nt] = 0;
        nt++;
        break;
      }
    }
    /* "C:\a\." / "C:\a\.." with a trailing "\" after "." or ".." already handled by the empty segment */
  }
  /* plain length: root (plain) + segments */
  rootFrom = (kind == 5) ? 4 : (kind == 6) ? 8 : 0;
  plainLen = (kind == 6 ? 2 : 0) + (rl - rootFrom);
  for (t = 0; t < nt; t++) plainLen += tl[t] + (t ? 1 : 0);
  ext = 0;
  if (kind == 7) ext = 2; /* device / volume paths keep their own prefix */
  else if ((kind == 1 || kind == 4 || kind == 5 || kind == 6) && (flags & PW7_ENSURE_IS_EXTENDED_LENGTH_PATH)) ext = 1;
  else if ((kind == 1 || kind == 4 || kind == 5 || kind == 6) && plainLen >= PW7_MAX_PATH && (flags & PW7_ALLOW_LONG_PATHS)) ext = 1;
  else if ((kind == 5 || kind == 6) && plainLen >= PW7_MAX_PATH) ext = 1;
  /* the plain form drops the trailing dots of the last segment ("c." -> "c") */
  if (ext != 1 && nt > 0 && tl[nt - 1] > 0) {
    SIZE_T k = tl[nt - 1];
    while (k > 0 && src[ts[nt - 1] + k - 1] == L'.') k--;
    if (k > 0) tl[nt - 1] = k;
  }
  buf = pw7_alloc(plainLen + 16);
  if (!buf) {
    HeapFree(GetProcessHeap(), 0, ts);
    return E_OUTOFMEMORY;
  }
  o = 0;
  if (ext == 1) {
    if (kind == 4 || kind == 6) {
      pw7_wmemcpy(buf, L"\\\\?\\UNC\\", 8);
      o = 8;
      rootFrom = (kind == 4) ? 2 : 8;
    } else {
      pw7_wmemcpy(buf, L"\\\\?\\", 4);
      o = 4;
    }
  } else if (kind == 6) {
    buf[o++] = L'\\';
    buf[o++] = L'\\';
  }
  for (i = rootFrom; i < rl; i++) buf[o++] = src[i];
  for (t = 0; t < nt; t++) {
    if (t) buf[o++] = L'\\';
    pw7_wmemcpy(buf + o, src + ts[t], tl[t]);
    o += tl[t];
  }
  /* "C:\a\.." in the extended form is "\\?\C:" (what Windows returns) */
  if (ext == 1 && (kind == 1 || kind == 5) && hadSeg && nt == 0 && o > 0 && buf[o - 1] == L'\\') o--;
  /* UNC: "\\srv\shr\a\.." -> "\\srv\shr" (no separator after the last kept segment) */
  if ((kind == 4 || kind == 6) && nt == 0 && hadSeg && o > 0 && buf[o - 1] == L'\\') o--;
  if ((flags & PW7_ENSURE_TRAILING_SLASH) && o > 0 && buf[o - 1] != L'\\') buf[o++] = L'\\';
  buf[o] = 0;
  HeapFree(GetProcessHeap(), 0, ts);
  *out = buf;
  *outLen = o;
  return S_OK;
}

typedef HRESULT(WINAPI *pfn_PathAllocCanonicalize)(PCWSTR, ULONG, PWSTR *);

HRESULT WINAPI pw7_PathAllocCanonicalize(PCWSTR in, ULONG flags, PWSTR *out) {
  WCHAR *tmp, *res;
  SIZE_T len;
  HRESULT hr;
  PW7_RESOLVE(real, pfn_PathAllocCanonicalize, L"api-ms-win-core-path-l1-1-0.dll", "PathAllocCanonicalize");
  if (real) return real(in, flags, out);
  if (!out) return E_INVALIDARG;
  *out = NULL;
  if (!in) return E_INVALIDARG;
  hr = pw7_canon(in, flags, &tmp, &len);
  if (FAILED(hr)) return hr;
  if (len >= PW7_MAX_PATH && !(flags & (PW7_ALLOW_LONG_PATHS | PW7_ENSURE_IS_EXTENDED_LENGTH_PATH))) {
    pw7_free(tmp);
    return PW7_E_TOO_LONG;
  }
  res = (WCHAR *)LocalAlloc(LMEM_FIXED, (len + 1) * sizeof(WCHAR));
  if (!res) {
    pw7_free(tmp);
    return E_OUTOFMEMORY;
  }
  pw7_wmemcpy(res, tmp, len + 1);
  pw7_free(tmp);
  *out = res;
  return S_OK;
}

typedef HRESULT(WINAPI *pfn_PathCchCombineEx)(PWSTR, SIZE_T, PCWSTR, PCWSTR, ULONG);

HRESULT WINAPI pw7_PathCchCombineEx(PWSTR out, SIZE_T cch, PCWSTR in, PCWSTR more, ULONG flags) {
  SIZE_T ni, nm, len, rl;
  int kind;
  WCHAR *joined, *canon;
  HRESULT hr;
  PW7_RESOLVE(real, pfn_PathCchCombineEx, L"api-ms-win-core-path-l1-1-0.dll", "PathCchCombineEx");
  if (real) return real(out, cch, in, more, flags);
  if (!out || cch == 0 || cch > PW7_PATHCCH_MAX_CCH) return E_INVALIDARG;
  ni = pw7_wcslen(in);
  nm = pw7_wcslen(more);
  joined = pw7_alloc(ni + nm + 4);
  if (!joined) return E_OUTOFMEMORY;
  len = 0;
  pw7_root(more ? more : L"", nm, &kind);
  if (nm && (kind == 1 || kind == 4 || kind == 5 || kind == 6 || kind == 7)) {
    pw7_wmemcpy(joined, more, nm); /* "more" is fully qualified: it wins */
    len = nm;
  } else if (nm && kind == 3) {
    rl = pw7_root(in ? in : L"", ni, &kind); /* "\x": relative to the root of "in" */
    while (rl > 0 && in[rl - 1] == L'\\') rl--;
    pw7_wmemcpy(joined, in, rl);
    len = rl;
    pw7_wmemcpy(joined + len, more, nm);
    len += nm;
  } else {
    pw7_wmemcpy(joined, in ? in : L"", ni);
    len = ni;
    if (nm) {
      if (len > 0 && joined[len - 1] != L'\\') joined[len++] = L'\\';
      pw7_wmemcpy(joined + len, more, nm);
      len += nm;
    }
  }
  joined[len] = 0;
  hr = pw7_canon(joined, 0, &canon, &len);
  pw7_free(joined);
  if (FAILED(hr)) {
    out[0] = 0;
    return hr;
  }
  if (len == 0 && cch >= 2) {
    canon[0] = L'\\';
    canon[1] = 0;
    len = 1;
  }
  if (len >= PW7_MAX_PATH && !(flags & PW7_ALLOW_LONG_PATHS)) {
    pw7_free(canon);
    out[0] = 0;
    return PW7_E_TOO_LONG;
  }
  if (len + 1 > cch) {
    pw7_free(canon);
    out[0] = 0;
    return PW7_E_INSUFFICIENT;
  }
  pw7_wmemcpy(out, canon, len + 1);
  pw7_free(canon);
  return S_OK;
}

typedef HRESULT(WINAPI *pfn_PathCchRemoveFileSpec)(PWSTR, SIZE_T);

HRESULT WINAPI pw7_PathCchRemoveFileSpec(PWSTR path, SIZE_T cch) {
  SIZE_T n, rl, i;
  int kind;
  PW7_RESOLVE(real, pfn_PathCchRemoveFileSpec, L"api-ms-win-core-path-l1-1-0.dll", "PathCchRemoveFileSpec");
  if (real) return real(path, cch);
  if (!path || cch == 0 || cch > PW7_PATHCCH_MAX_CCH) return E_INVALIDARG;
  n = pw7_wcslen(path);
  rl = pw7_root(path, n, &kind);
  if (n <= rl) return S_FALSE;
  i = n;
  while (i > rl && path[i - 1] != L'\\') i--;
  /* i: start of the last segment (or rl); drop the segment and the separator before it */
  if (i > rl) i--;
  if (i == n) return S_FALSE;
  path[i] = 0;
  return S_OK;
}

/* ───────────────────────── ntdll: growable function tables (x64) ───────────────────────── */

#ifdef _WIN64
typedef DWORD(NTAPI *pfn_RtlAddGrowableFunctionTable)(PVOID *, PRUNTIME_FUNCTION, DWORD, DWORD, ULONG_PTR, ULONG_PTR);
typedef VOID(NTAPI *pfn_RtlDeleteGrowableFunctionTable)(PVOID);
typedef VOID(NTAPI *pfn_RtlGrowFunctionTable)(PVOID, DWORD);

DWORD NTAPI pw7_RtlAddGrowableFunctionTable(PVOID *table, PRUNTIME_FUNCTION fns, DWORD count, DWORD max,
                                            ULONG_PTR base, ULONG_PTR end) {
  PW7_RESOLVE(real, pfn_RtlAddGrowableFunctionTable, L"ntdll.dll", "RtlAddGrowableFunctionTable");
  if (real) return real(table, fns, count, max, base, end);
  (void)max;
  (void)end;
  /* Windows 7: the same unwind records registered as a (fixed) function table */
  if (!RtlAddFunctionTable(fns, count, (DWORD64)base)) return (DWORD)0xC0000017L; /* STATUS_NO_MEMORY */
  *table = fns;
  return 0;
}

VOID NTAPI pw7_RtlDeleteGrowableFunctionTable(PVOID table) {
  PW7_RESOLVE(real, pfn_RtlDeleteGrowableFunctionTable, L"ntdll.dll", "RtlDeleteGrowableFunctionTable");
  if (real) {
    real(table);
    return;
  }
  if (table) RtlDeleteFunctionTable((PRUNTIME_FUNCTION)table);
}

VOID NTAPI pw7_RtlGrowFunctionTable(PVOID table, DWORD count) {
  PW7_RESOLVE(real, pfn_RtlGrowFunctionTable, L"ntdll.dll", "RtlGrowFunctionTable");
  if (real) {
    real(table, count);
    return;
  }
  (void)table;
  (void)count; /* fixed table on Windows 7: entries were registered up front */
}
#endif

/* ───────────────────────── ws2_32 ───────────────────────── */

typedef int(WSAAPI *pfn_GetHostNameW)(PWSTR, int);

int WSAAPI pw7_GetHostNameW(PWSTR name, int namelen) {
  char buf[256];
  int need;
  PW7_RESOLVE(real, pfn_GetHostNameW, L"ws2_32.dll", "GetHostNameW");
  if (real) return real(name, namelen);
  if (gethostname(buf, (int)sizeof(buf)) != 0) return SOCKET_ERROR;
  need = MultiByteToWideChar(CP_ACP, 0, buf, -1, NULL, 0);
  if (need <= 0 || !name || namelen < need) {
    WSASetLastError(WSAEFAULT);
    return SOCKET_ERROR;
  }
  MultiByteToWideChar(CP_ACP, 0, buf, -1, name, namelen);
  return 0;
}

/* ───────────────────────── advapi32 ───────────────────────── */

typedef ULONG(WINAPI *pfn_EventSetInformation)(ULONGLONG, int, PVOID, ULONG);

ULONG WINAPI pw7_EventSetInformation(ULONGLONG reg, int cls, PVOID info, ULONG len) {
  PW7_RESOLVE(real, pfn_EventSetInformation, L"advapi32.dll", "EventSetInformation");
  if (real) return real(reg, cls, info, len);
  /* ETW provider traits do not exist on Windows 7; tracing simply keeps its defaults */
  return ERROR_NOT_SUPPORTED;
}

/* ───────────────────────── self-test hooks ───────────────────────── */

/* 1 when the Windows 7 implementations are in use (forced or the OS lacks the functions) */
int WINAPI pw7_Info(void) {
  return pw7_forced() || pw7_real(L"kernel32.dll", "GetSystemTimePreciseAsFileTime") == NULL;
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved) {
  (void)reserved;
  if (reason == DLL_PROCESS_ATTACH) {
    WCHAR v[4];
    DisableThreadLibraryCalls(h);
    /* Node.js 22 refuses to start before Windows 8.1 unless NODE_SKIP_PLATFORM_CHECK=1
     * (node_main.cc reads it in wmain, after this DllMain). With pw7.dll the Win8+ imports
     * are handled, so the check is satisfied here; child processes inherit it. No effect
     * on Windows 8.1+, where node never consults the variable. */
    if (GetEnvironmentVariableW(L"NODE_SKIP_PLATFORM_CHECK", v, 4) == 0) SetEnvironmentVariableW(L"NODE_SKIP_PLATFORM_CHECK", L"1");
  }
  return TRUE;
}
