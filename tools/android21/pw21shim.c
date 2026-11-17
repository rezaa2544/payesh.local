/*
 * Row 168: libpayeshw21.so — Android 5.0/5.1/6.0 (API 21-23) compatibility for Flutter's
 * 64-bit libflutter.so (arm64-v8a, x86_64), which the engine links for API 24 and which
 * therefore imports libc symbols that only exist from Android 6.0 / 7.0:
 *
 *   stdin stdout stderr __register_atfork __gnu_strerror_r posix_madvise   (API 23)
 *   __poll_chk __pread_chk __pread64_chk __readlink_chk                    (API 23)
 *   __write_chk __fwrite_chk getifaddrs freeifaddrs                        (API 24)
 *
 * tools/android21/patch-engine.py rewrites libflutter.so's DT_NEEDED "libjnigraphics.so"
 * (no version requirements, 3 imports) into "libpayeshw21.so" and bundles this library next
 * to it. The dynamic linker searches libc.so before this library (it is the last DT_NEEDED),
 * so on Android 7.0+ every symbol still comes from the system libc; these definitions are
 * only used where libc lacks them. The library has no symbol versions, which satisfies the
 * versioned references (LIBC / LIBC_N) on the API 23 linker; API 21/22 ignore versions.
 *
 * AndroidBitmap_* are forwarded to the real libjnigraphics.so (looked up with dlopen/dlsym, so
 * calling them can never resolve back to these forwarders).
 *
 * Build: clang --target=<aarch64|x86_64>-linux-android21 -O2 -fPIC -shared -nostdlib++
 *        -Wl,-soname,libpayeshw21.so -o libpayeshw21.so pw21shim.c -ldl
 */
#include <android/bitmap.h>
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <jni.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>

#define PW_EXPORT __attribute__((visibility("default")))

/* ── stdio streams: before Android 6.0 libc only exports the __sF array ───────────────── */
#undef stdin
#undef stdout
#undef stderr
PW_EXPORT FILE* stdin = &__sF[0];
PW_EXPORT FILE* stdout = &__sF[1];
PW_EXPORT FILE* stderr = &__sF[2];

/* ── fork handlers: __register_atfork(prepare, parent, child, dso) = pthread_atfork ──────
 * The dso handle only lets bionic drop the handlers when the library is unloaded;
 * libflutter.so is never unloaded. */
PW_EXPORT int __register_atfork(void (*prepare)(void), void (*parent)(void), void (*child)(void), void* dso) {
  (void)dso;
  return pthread_atfork(prepare, parent, child);
}

/* ── GNU strerror_r (returns the message pointer) ─────────────────────────────────────── */
PW_EXPORT char* __gnu_strerror_r(int err, char* buf, size_t n) {
  if (buf == NULL || n == 0) return (char*)"";
  const char* m = strerror(err); /* thread-safe in bionic for known errors */
  if (m == NULL) m = "Unknown error";
  strncpy(buf, m, n - 1);
  buf[n - 1] = '\0';
  return buf;
}

#ifndef POSIX_MADV_DONTNEED
#define POSIX_MADV_DONTNEED 4 /* bionic <sys/mman.h>, hidden below API 23 */
#endif
PW_EXPORT int posix_madvise(void* addr, size_t len, int advice) {
  /* bionic: POSIX_MADV_DONTNEED is a no-op (it would discard data under POSIX semantics) */
  if (advice == POSIX_MADV_DONTNEED) return 0;
  return madvise(addr, len, advice) == 0 ? 0 : errno;
}

/* ── _FORTIFY_SOURCE checks: same contract as bionic (abort on overflow) ──────────────── */
static void pw_fortify_fail(const char* what) {
  /* bionic prints "FORTIFY: <what>: prevented ..." and aborts; keep the abort semantics */
  (void)what;
  abort();
}

PW_EXPORT int __poll_chk(struct pollfd* fds, nfds_t nfds, int timeout, size_t fds_size) {
  if (fds_size / sizeof(*fds) < nfds) pw_fortify_fail("poll");
  return poll(fds, nfds, timeout);
}

PW_EXPORT ssize_t __pread_chk(int fd, void* buf, size_t count, off_t offset, size_t buf_size) {
  if (count > buf_size) pw_fortify_fail("pread");
  return pread(fd, buf, count, offset);
}

PW_EXPORT ssize_t __pread64_chk(int fd, void* buf, size_t count, off64_t offset, size_t buf_size) {
  if (count > buf_size) pw_fortify_fail("pread64");
  return pread64(fd, buf, count, offset);
}

PW_EXPORT ssize_t __readlink_chk(const char* path, char* buf, size_t size, size_t buf_size) {
  if (size > buf_size) pw_fortify_fail("readlink");
  return readlink(path, buf, size);
}

PW_EXPORT ssize_t __write_chk(int fd, const void* buf, size_t count, size_t buf_size) {
  if (count > buf_size) pw_fortify_fail("write");
  return write(fd, buf, count);
}

PW_EXPORT size_t __fwrite_chk(const void* buf, size_t size, size_t count, FILE* stream, size_t buf_size) {
  size_t total;
  if (__builtin_mul_overflow(size, count, &total) || total > buf_size) pw_fortify_fail("fwrite");
  return fwrite(buf, size, count, stream);
}

/* ── getifaddrs / freeifaddrs (API 24) ────────────────────────────────────────────────────
 * IPv4: SIOCGIFCONF + SIOCGIF{FLAGS,NETMASK,BRDADDR,DSTADDR}; IPv6: /proc/net/if_inet6.
 * Every entry and its addresses are one malloc block, so freeifaddrs frees each node. */
struct pw_ifaddrs {
  struct pw_ifaddrs* ifa_next;
  char* ifa_name;
  unsigned int ifa_flags;
  struct sockaddr* ifa_addr;
  struct sockaddr* ifa_netmask;
  struct sockaddr* ifa_broadaddr; /* union with ifa_dstaddr */
  void* ifa_data;
};

struct pw_node {
  struct pw_ifaddrs ifa;
  struct sockaddr_storage addr, mask, bcast;
  char name[IFNAMSIZ + 1];
};

static struct pw_node* pw_new(const char* name, unsigned flags) {
  struct pw_node* n = (struct pw_node*)calloc(1, sizeof(*n));
  if (n == NULL) return NULL;
  strncpy(n->name, name, IFNAMSIZ);
  n->ifa.ifa_name = n->name;
  n->ifa.ifa_flags = flags;
  return n;
}

static unsigned pw_flags(int fd, const char* name) {
  struct ifreq r;
  memset(&r, 0, sizeof(r));
  strncpy(r.ifr_name, name, IFNAMSIZ - 1);
  return ioctl(fd, SIOCGIFFLAGS, &r) == 0 ? (unsigned short)r.ifr_flags : 0;
}

PW_EXPORT void freeifaddrs(struct pw_ifaddrs* list) {
  while (list != NULL) {
    struct pw_ifaddrs* next = list->ifa_next;
    free(list); /* ifa is the first member of the node */
    list = next;
  }
}

PW_EXPORT int getifaddrs(struct pw_ifaddrs** out) {
  if (out == NULL) { errno = EINVAL; return -1; }
  *out = NULL;
  struct pw_ifaddrs *head = NULL, **tail = &head;
  int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;

  /* IPv4 */
  int len = 32 * (int)sizeof(struct ifreq);
  char* buf = NULL;
  struct ifconf ifc;
  for (;;) {
    char* nb = (char*)realloc(buf, (size_t)len);
    if (nb == NULL) { free(buf); close(fd); errno = ENOMEM; return -1; }
    buf = nb;
    ifc.ifc_len = len;
    ifc.ifc_buf = buf;
    if (ioctl(fd, SIOCGIFCONF, &ifc) < 0) { free(buf); close(fd); return -1; }
    if (ifc.ifc_len < len) break;
    len *= 2;
  }
  for (char* p = buf; p < buf + ifc.ifc_len; p += sizeof(struct ifreq)) {
    struct ifreq* r = (struct ifreq*)p;
    if (r->ifr_addr.sa_family != AF_INET) continue;
    unsigned flags = pw_flags(fd, r->ifr_name);
    struct pw_node* n = pw_new(r->ifr_name, flags);
    if (n == NULL) { free(buf); close(fd); freeifaddrs(head); errno = ENOMEM; return -1; }
    memcpy(&n->addr, &r->ifr_addr, sizeof(struct sockaddr_in));
    n->ifa.ifa_addr = (struct sockaddr*)&n->addr;
    struct ifreq q;
    memset(&q, 0, sizeof(q));
    strncpy(q.ifr_name, r->ifr_name, IFNAMSIZ - 1);
    if (ioctl(fd, SIOCGIFNETMASK, &q) == 0) {
      memcpy(&n->mask, &q.ifr_netmask, sizeof(struct sockaddr_in));
      n->mask.ss_family = AF_INET;
      n->ifa.ifa_netmask = (struct sockaddr*)&n->mask;
    }
    if ((flags & IFF_BROADCAST) && ioctl(fd, SIOCGIFBRDADDR, &q) == 0) {
      memcpy(&n->bcast, &q.ifr_broadaddr, sizeof(struct sockaddr_in));
      n->ifa.ifa_broadaddr = (struct sockaddr*)&n->bcast;
    } else if ((flags & IFF_POINTOPOINT) && ioctl(fd, SIOCGIFDSTADDR, &q) == 0) {
      memcpy(&n->bcast, &q.ifr_dstaddr, sizeof(struct sockaddr_in));
      n->ifa.ifa_broadaddr = (struct sockaddr*)&n->bcast;
    }
    *tail = &n->ifa;
    tail = &n->ifa.ifa_next;
  }
  free(buf);

  /* IPv6: "<32 hex addr> <ifindex> <prefixlen> <scope> <flags> <name>" */
  FILE* f = fopen("/proc/net/if_inet6", "re");
  if (f != NULL) {
    char hex[33], name[IFNAMSIZ + 1];
    unsigned idx, plen, scope, fl;
    while (fscanf(f, "%32s %x %x %x %x %16s", hex, &idx, &plen, &scope, &fl, name) == 6) {
      struct pw_node* n = pw_new(name, pw_flags(fd, name));
      if (n == NULL) break;
      struct sockaddr_in6* a = (struct sockaddr_in6*)&n->addr;
      struct sockaddr_in6* m = (struct sockaddr_in6*)&n->mask;
      a->sin6_family = AF_INET6;
      for (int i = 0; i < 16; i++) {
        unsigned b;
        sscanf(hex + 2 * i, "%2x", &b);
        a->sin6_addr.s6_addr[i] = (uint8_t)b;
      }
      if (IN6_IS_ADDR_LINKLOCAL(&a->sin6_addr) || IN6_IS_ADDR_MC_LINKLOCAL(&a->sin6_addr)) a->sin6_scope_id = idx;
      m->sin6_family = AF_INET6;
      for (unsigned i = 0; i < 16 && plen > 0; i++) {
        unsigned bits = plen >= 8 ? 8 : plen;
        m->sin6_addr.s6_addr[i] = (uint8_t)(0xff << (8 - bits));
        plen -= bits;
      }
      n->ifa.ifa_addr = (struct sockaddr*)a;
      n->ifa.ifa_netmask = (struct sockaddr*)m;
      *tail = &n->ifa;
      tail = &n->ifa.ifa_next;
    }
    fclose(f);
  }
  close(fd);
  *out = head;
  return 0;
}

/* ── libjnigraphics forwarders (the DT_NEEDED slot this library took over) ─────────────── */
static void* pw_jnig(const char* sym) {
  static void* h;
  if (h == NULL) h = dlopen("libjnigraphics.so", RTLD_NOW);
  return h != NULL ? dlsym(h, sym) : NULL;
}

PW_EXPORT int AndroidBitmap_getInfo(JNIEnv* env, jobject bitmap, AndroidBitmapInfo* info) {
  static int (*real)(JNIEnv*, jobject, AndroidBitmapInfo*);
  if (real == NULL) real = (int (*)(JNIEnv*, jobject, AndroidBitmapInfo*))pw_jnig("AndroidBitmap_getInfo");
  return real != NULL ? real(env, bitmap, info) : ANDROID_BITMAP_RESULT_JNI_EXCEPTION;
}

PW_EXPORT int AndroidBitmap_lockPixels(JNIEnv* env, jobject bitmap, void** addr) {
  static int (*real)(JNIEnv*, jobject, void**);
  if (real == NULL) real = (int (*)(JNIEnv*, jobject, void**))pw_jnig("AndroidBitmap_lockPixels");
  return real != NULL ? real(env, bitmap, addr) : ANDROID_BITMAP_RESULT_JNI_EXCEPTION;
}

PW_EXPORT int AndroidBitmap_unlockPixels(JNIEnv* env, jobject bitmap) {
  static int (*real)(JNIEnv*, jobject);
  if (real == NULL) real = (int (*)(JNIEnv*, jobject))pw_jnig("AndroidBitmap_unlockPixels");
  return real != NULL ? real(env, bitmap) : ANDROID_BITMAP_RESULT_JNI_EXCEPTION;
}
