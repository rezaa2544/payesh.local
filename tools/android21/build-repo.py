#!/usr/bin/env python3
"""Row 168: Flutter on Android 5.0 / 5.1 / 6.0 (API 21-23).

Flutter 3.35+ dropped API 21-23. Two parts of the engine build stop the app on those versions,
and this script produces fixed copies of both as a local Maven repository that the app's
build.gradle.kts substitutes for the official artifacts (io.flutter:*:1.0.0-<engine>-api21):

1. flutter_embedding_<mode>.jar (Java) calls a few API 24 methods without a version check
   (Context.getDataDir() while the engine starts, Configuration.getLocales() when it sends the
   locales, AccessibilityNodeInfo.setImportantForAccessibility(), PointerIcon). The embedding
   sources of the SAME engine build ship in the Flutter SDK (engine/src/flutter/shell/platform/
   android); small version-guarded edits are applied (each must match exactly once, so a Flutter
   upgrade that moves the code fails loudly), only the edited classes are compiled (Java 8
   bytecode like the original) against the official jar, and replace those classes (with their
   inner classes) in a copy of the jar.

2. The 64-bit libflutter.so (arm64_v8a_<mode>.jar, x86_64_<mode>.jar) is linked for API 24 and
   imports 13 libc symbols that Android 5.0/6.0 do not have (stdout, getifaddrs, __write_chk,
   ...): loading it fails with "cannot locate symbol". Its DT_NEEDED entry "libjnigraphics.so"
   (no symbol-version requirements) is rewritten in place to "libpayeshw21.so", a small library
   built here from tools/android21/pw21shim.c that defines exactly those symbols (plus
   forwarders to libjnigraphics.so) and is bundled next to libflutter.so in the same jar. libc
   stays first in the search order, so Android 7.0+ keeps using the system implementations.
   Every strong import of the result is verified against the NDK's API 21 libraries + the shim.
   The 32-bit armeabi_v7a libflutter.so already targets API 21 and is only verified.

usage: build-repo.py --flutter-root DIR --android-jar android-36.jar --ndk NDK_DIR --out REPO
                     [--modes release[,profile,debug]] [--work DIR] [--javac PATH]
Prints ANDROID21-REPO-OK.
"""
import argparse
import hashlib
import importlib.util
import os
import re
import shutil
import struct
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
STORAGE = os.environ.get('FLUTTER_STORAGE_BASE_URL', 'https://storage.googleapis.com') + '/download.flutter.io'
ANNOTATION = 'https://dl.google.com/android/maven2/androidx/annotation/annotation-jvm/1.8.1/annotation-jvm-1.8.1.jar'
SUFFIX = '-api21'
MARKER = 'META-INF/payesh-api21.txt'
SHIM_SRC = os.path.join(HERE, 'pw21shim.c')
SHIM_NAME = 'libpayeshw21.so'
REPLACED_NEEDED = 'libjnigraphics.so'
# engine artifact -> (abi directory in the jar, clang target, patch?)
ENGINE_ABIS = {
    'arm64_v8a': ('arm64-v8a', 'aarch64-linux-android21', True),
    'x86_64': ('x86_64', 'x86_64-linux-android21', True),
    'armeabi_v7a': ('armeabi-v7a', 'armv7a-linux-androideabi21', False),
}
STUB_TRIPLE = {'aarch64-linux-android21': 'aarch64-linux-android', 'x86_64-linux-android21': 'x86_64-linux-android',
               'armv7a-linux-androideabi21': 'arm-linux-androideabi'}

_spec = importlib.util.spec_from_file_location('check_so_api', os.path.join(HERE, 'check-so-api.py'))
check_so_api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_so_api)

GUARD_24 = 'android.os.Build.VERSION.SDK_INT >= 24'

# (relative source path, [(old, new), ...]); every `old` must occur exactly once.
PATCHES = [
    ('io/flutter/util/PathUtils.java', [
        ('    return applicationContext.getDataDir().getPath();',
         '    // payesh row 168: Context.getDataDir() is API 24; ApplicationInfo.dataDir is the same\n'
         '    // directory on every API level.\n'
         '    if (' + GUARD_24 + ') {\n'
         '      return applicationContext.getDataDir().getPath();\n'
         '    }\n'
         '    return applicationContext.getApplicationInfo().dataDir;'),
    ]),
    ('io/flutter/plugin/localization/LocalizationPlugin.java', [
        # API 24-25 branch of resolveNativeLocale (API 21-23 have no LocaleList)
        ('''      LocaleList localeList = context.getResources().getConfiguration().getLocales();
      for (int index = 0; index < localeList.size(); ++index) {
        Locale preferredLocale = localeList.get(index);''',
         '''      List<Locale> payeshPreferred = payeshLocales(context.getResources().getConfiguration());
      for (int index = 0; index < payeshPreferred.size(); ++index) {
        Locale preferredLocale = payeshPreferred.get(index);'''),
        ('''    List<Locale> locales = new ArrayList<>();
    LocaleList localeList = config.getLocales();
    int localeCount = localeList.size();
    for (int index = 0; index < localeCount; ++index) {
      Locale locale = localeList.get(index);
      locales.add(locale);
    }

    localizationChannel.sendLocales(locales);
  }''',
         '''    List<Locale> locales = payeshLocales(config);

    localizationChannel.sendLocales(locales);
  }

  // payesh row 168: Configuration.getLocales()/LocaleList are API 24; before that the
  // configuration has exactly one locale (Configuration.locale).
  @SuppressWarnings("deprecation")
  private static List<Locale> payeshLocales(@NonNull Configuration config) {
    List<Locale> locales = new ArrayList<>();
    if (''' + GUARD_24 + ''') {
      LocaleList localeList = config.getLocales();
      for (int index = 0; index < localeList.size(); ++index) {
        locales.add(localeList.get(index));
      }
    } else if (config.locale != null) {
      locales.add(config.locale);
    }
    return locales;
  }'''),
    ]),
    ('io/flutter/view/AccessibilityBridge.java', [
        ('''      result.setImportantForAccessibility(false);
      return result;''',
         '''      if (''' + GUARD_24 + ''') { // payesh row 168: API 24
        result.setImportantForAccessibility(false);
      }
      return result;'''),
        ('''    result.setImportantForAccessibility(isImportant(semanticsNode));''',
         '''    if (''' + GUARD_24 + ''') { // payesh row 168: API 24
      result.setImportantForAccessibility(isImportant(semanticsNode));
    }'''),
        ('''    if (semanticsNode.previousNodeId != -1) {
      // Requires at least android api 22.''',
         '''    if (semanticsNode.previousNodeId != -1
        && android.os.Build.VERSION.SDK_INT >= 22) { // payesh row 168
      // Requires at least android api 22.'''),
    ]),
    ('io/flutter/plugin/mouse/MouseCursorPlugin.java', [
        ('''          public void activateSystemCursor(@NonNull String kind) {
            mView.setPointerIcon(resolveSystemCursor(kind));''',
         '''          public void activateSystemCursor(@NonNull String kind) {
            if (!(''' + GUARD_24 + ''')) {
              return; // payesh row 168: PointerIcon is API 24
            }
            mView.setPointerIcon(resolveSystemCursor(kind));'''),
    ]),
]


def digest():
    h = hashlib.sha256(repr(PATCHES).encode('utf-8'))
    for f in (SHIM_SRC, os.path.abspath(__file__), os.path.join(HERE, 'check-so-api.py')):
        h.update(open(f, 'rb').read())
    return h.hexdigest()[:16]


def log(m):
    print(m, flush=True)


def fail(m):
    print('ANDROID21-REPO-FAIL ' + m, flush=True)
    sys.exit(1)


def fetch(url, dst):
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return dst
    tmp = dst + '.part'
    with urllib.request.urlopen(url, timeout=300) as r, open(tmp, 'wb') as f:
        shutil.copyfileobj(r, f)
    os.replace(tmp, dst)
    return dst


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def fetch_artifact(work, art, version):
    base = '%s/io/flutter/%s/%s/%s-%s' % (STORAGE, art, version, art, version)
    jar = fetch(base + '.jar', os.path.join(work, '%s-%s.jar' % (art, version)))
    pom = fetch(base + '.pom', os.path.join(work, '%s-%s.pom' % (art, version)))
    return jar, pom


def publish(out, art, version, src_jar, replace, add, drop, pom, note):
    """Write <out>/io/flutter/<art>/<version>-api21/{jar,pom}: entries of src_jar streamed
    unchanged except `replace` {name: bytes} and `drop(name)`; then `add` {name: bytes}."""
    vdir = os.path.join(out, 'io', 'flutter', art, version + SUFFIX)
    os.makedirs(vdir, exist_ok=True)
    jar = os.path.join(vdir, '%s-%s%s.jar' % (art, version, SUFFIX))
    with zipfile.ZipFile(src_jar) as zin, zipfile.ZipFile(jar + '.part', 'w', zipfile.ZIP_DEFLATED) as z:
        for info in zin.infolist():
            if info.filename == MARKER or drop(info.filename):
                continue
            if info.filename in replace:
                z.writestr(info, replace[info.filename])
                continue
            with zin.open(info) as src, z.open(info, 'w') as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
        for name in sorted(add):
            zi, data = entry(name, add[name])
            z.writestr(zi, data)
        z.writestr(zipfile.ZipInfo(MARKER, date_time=(2026, 1, 1, 0, 0, 0)), note)
    os.replace(jar + '.part', jar)
    text = open(pom, encoding='utf-8').read()
    if text.count('<version>%s</version>' % version) != 1:
        fail('unexpected pom layout in ' + pom)
    text = text.replace('<version>%s</version>' % version, '<version>%s%s</version>' % (version, SUFFIX))
    open(os.path.join(vdir, '%s-%s%s.pom' % (art, version, SUFFIX)), 'w', encoding='utf-8').write(text)
    return jar


def entry(name, data):
    zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.external_attr = 0o644 << 16
    return (zi, data)


# ── part 1: embedding ─────────────────────────────────────────────────────────────────────────
def build_embedding(a, work, src_root, engine, version, modes):
    psrc = os.path.join(work, 'src')
    shutil.rmtree(psrc, ignore_errors=True)
    files, outers = [], []
    for rel, edits in PATCHES:
        text = open(os.path.join(src_root, rel), encoding='utf-8').read()
        for old, new in edits:
            n = text.count(old)
            if n != 1:
                fail('%s: expected 1 match, found %d for:\n%s' % (rel, n, old))
            text = text.replace(old, new)
        dst = os.path.join(psrc, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        open(dst, 'w', encoding='utf-8').write(text)
        files.append(dst)
        outers.append(rel[:-len('.java')])
        log('  patched %s (%d edits)' % (rel, len(edits)))
    ann = fetch(ANNOTATION, os.path.join(work, 'annotation-jvm-1.8.1.jar'))

    def replaced(name):
        return any(name == o + '.class' or (name.startswith(o + '$') and name.endswith('.class')) for o in outers)

    done = []
    for mode in modes:
        art = 'flutter_embedding_' + mode
        try:
            jar, pom = fetch_artifact(work, art, version)
        except Exception as e:  # noqa: BLE001
            if mode == 'release':
                fail('cannot download %s: %s' % (art, e))
            log('  %s: not available (%s) — skipped' % (art, e))
            continue
        cls = os.path.join(work, 'classes-' + mode)
        shutil.rmtree(cls, ignore_errors=True)
        os.makedirs(cls)
        # --release 8: java.* from the JDK's Java 8 API (android.jar lacks
        # LambdaMetafactory.altMetafactory that javac needs for some lambdas; D8 desugars them),
        # android.* from android.jar on the class path.
        r = subprocess.run([a.javac, '-nowarn', '-Xlint:-options', '-encoding', 'UTF-8', '--release', '8',
                            '-cp', os.pathsep.join([a.android_jar, jar, ann]), '-d', cls] + files,
                           capture_output=True, text=True)
        if r.returncode != 0:
            fail('javac:\n' + r.stdout + r.stderr)
        new_classes = {}
        for dp, _, fs in os.walk(cls):
            for f in fs:
                p = os.path.join(dp, f)
                new_classes[os.path.relpath(p, cls).replace(os.sep, '/')] = open(p, 'rb').read()
        missing = [o for o in outers if o + '.class' not in new_classes]
        if missing:
            fail('classes not compiled: %s' % missing)
        with zipfile.ZipFile(jar) as z:
            dropped = sum(1 for n in z.namelist() if replaced(n))
        publish(a.out, art, version, jar, {}, new_classes, replaced, pom,
                'payesh row 168: API 21-23 guards in %s (engine %s)\n' % (', '.join(outers), engine))
        log('  %s%s: replaced %d classes with %d' % (art, SUFFIX, dropped, len(new_classes)))
        done.append(art)
    return done


# ── part 2: libflutter.so ─────────────────────────────────────────────────────────────────────
def elf_dyn_layout(data):
    """Section-level view: dynstr file offset, DT_NEEDED (dyn entry offset, str offset), and every
    dynstr offset referenced anywhere (dynamic entries, dynsym, verneed, verdef)."""
    if data[:4] != b'\x7fELF' or data[5] != 1:
        fail('not a little-endian ELF')
    is64 = data[4] == 2
    if is64:
        shoff, = struct.unpack_from('<Q', data, 40)
        shentsize, shnum = struct.unpack_from('<HH', data, 58)
    else:
        shoff, = struct.unpack_from('<I', data, 32)
        shentsize, shnum = struct.unpack_from('<HH', data, 46)
    secs = []
    for i in range(shnum):
        o = shoff + i * shentsize
        if is64:
            _, typ, _, _, off, size, link, _, _, entsize = struct.unpack_from('<IIQQQQIIQQ', data, o)
        else:
            _, typ, _, _, off, size, link, _, _, entsize = struct.unpack_from('<IIIIIIIIII', data, o)
        secs.append((typ, off, size, link, entsize))
    dyn = [s for s in secs if s[0] == 6]
    if len(dyn) != 1:
        fail('expected one SHT_DYNAMIC section')
    _, doff, dsize, dlink, _ = dyn[0]
    stroff, strsize = secs[dlink][1], secs[dlink][2]
    needed, refs = [], []
    step = 16 if is64 else 8
    for o in range(doff, doff + dsize, step):
        tag, val = struct.unpack_from('<qQ' if is64 else '<iI', data, o)
        if tag == 0:
            break
        if tag in (1, 14, 15, 29):  # NEEDED SONAME RPATH RUNPATH
            refs.append(val)
            if tag == 1:
                needed.append((o, val))
    for typ, off, size, link, entsize in secs:
        if typ == 11 and secs[link][1] == stroff:  # .dynsym
            for j in range(size // entsize):
                refs.append(struct.unpack_from('<I', data, off + j * entsize)[0])
        elif typ == 0x6ffffffe and secs[link][1] == stroff:  # .gnu.version_r
            o = off
            while True:
                vn_version, vn_cnt, vn_file, vn_aux, vn_next = struct.unpack_from('<HHIII', data, o)
                refs.append(vn_file)
                ao = o + vn_aux
                for _ in range(vn_cnt):
                    _, _, _, vna_name, vna_next = struct.unpack_from('<IHHII', data, ao)
                    refs.append(vna_name)
                    if not vna_next:
                        break
                    ao += vna_next
                if not vn_next:
                    break
                o += vn_next
        elif typ == 0x6ffffffd and secs[link][1] == stroff:  # .gnu.version_d
            o = off
            while True:
                _, _, _, vd_cnt, _, vd_aux, vd_next = struct.unpack_from('<HHHHIII', data, o)
                ao = o + vd_aux
                for _ in range(vd_cnt):
                    vda_name, vda_next = struct.unpack_from('<II', data, ao)
                    refs.append(vda_name)
                    if not vda_next:
                        break
                    ao += vda_next
                if not vd_next:
                    break
                o += vd_next
    return stroff, strsize, needed, refs


def cstr(data, off):
    return data[off:data.index(b'\0', off)].decode()


def rename_needed(data, old, new):
    stroff, strsize, needed, refs = elf_dyn_layout(data)
    hits = [(o, v) for o, v in needed if cstr(data, stroff + v) == old]
    if len(hits) != 1:
        fail('DT_NEEDED %s: expected 1 entry, found %d' % (old, len(hits)))
    if any(cstr(data, stroff + v) == new for _, v in needed):
        fail('DT_NEEDED %s already present' % new)
    _, v = hits[0]
    if len(new) > len(old):
        fail('replacement name longer than %s' % old)
    # the string must not be shared (tail merging) with any other reference
    span = range(v, v + len(old) + 1)
    shared = [r for r in refs if r in span and r != v]
    if shared or refs.count(v) != 1:
        fail('dynstr %r is shared with other references: %s' % (old, shared or 'same offset'))
    out = bytearray(data)
    pos = stroff + v
    out[pos:pos + len(old) + 1] = new.encode() + b'\0' * (len(old) + 1 - len(new))
    return bytes(out)


def ndk_clang(ndk):
    host = {'linux': 'linux-x86_64', 'darwin': 'darwin-x86_64', 'win32': 'windows-x86_64'}[sys.platform]
    b = os.path.join(ndk, 'toolchains', 'llvm', 'prebuilt', host)
    clang = os.path.join(b, 'bin', 'clang' + ('.exe' if sys.platform == 'win32' else ''))
    if not os.path.isfile(clang):
        fail('NDK clang not found: ' + clang)
    return clang, os.path.join(b, 'sysroot', 'usr', 'lib')


def api21_symbols(sysroot_lib, target):
    d = os.path.join(sysroot_lib, STUB_TRIPLE[target], '21')
    if not os.path.isdir(d):
        fail('NDK has no API 21 libraries: ' + d)
    syms = set()
    for f in os.listdir(d):
        data = open(os.path.join(d, f), 'rb').read() if f.endswith('.so') else b''
        if data[:4] == b'\x7fELF':  # libc++.so etc. are linker scripts
            syms |= check_so_api.elf_symbols(data)[3]
    return syms


def missing_imports(data, available):
    _, imports, _, _ = check_so_api.elf_symbols(data)
    return sorted(n for n, weak in imports if not weak and n not in available)


def build_engine(a, work, engine, version, modes):
    clang, sysroot_lib = ndk_clang(a.ndk)
    shims, done = {}, []
    for mode in modes:
        for abi_art, (abi, target, patch) in ENGINE_ABIS.items():
            art = '%s_%s' % (abi_art, mode)
            try:
                jar, pom = fetch_artifact(work, art, version)
            except Exception as e:  # noqa: BLE001
                if mode == 'release':
                    fail('cannot download %s: %s' % (art, e))
                log('  %s: not available (%s) — skipped' % (art, e))
                continue
            lib = 'lib/%s/libflutter.so' % abi
            with zipfile.ZipFile(jar) as z:
                if lib not in z.namelist():
                    fail('%s has no %s' % (art, lib))
                so = [z.read(lib)]
            stubs = api21_symbols(sysroot_lib, target)
            miss = missing_imports(so[0], stubs)
            if not miss:
                log('  %s: libflutter.so loads on API 21 as is' % art)
                continue
            if not patch:
                if mode == 'release':
                    fail('%s imports symbols missing on API 21: %s' % (art, ' '.join(miss)))
                log('  %s: needs %s — not patched (mode %s)' % (art, ' '.join(miss), mode))
                continue
            if target not in shims:
                out = os.path.join(work, 'shim-%s' % target, SHIM_NAME)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                r = subprocess.run([clang, '--target=' + target, '-O2', '-Wall', '-Werror', '-fPIC', '-shared',
                                    '-fvisibility=hidden', '-Wl,-soname,' + SHIM_NAME, '-Wl,-z,max-page-size=16384',
                                    '-Wl,--build-id=none', '-o', out, SHIM_SRC, '-ldl'], capture_output=True, text=True)
                if r.returncode != 0:
                    fail('building %s for %s:\n%s%s' % (SHIM_NAME, target, r.stdout, r.stderr))
                sdata = open(out, 'rb').read()
                smiss = missing_imports(sdata, stubs)
                if smiss:
                    fail('%s itself needs symbols missing on API 21: %s' % (SHIM_NAME, smiss))
                shims[target] = sdata
            sdata = shims[target]
            shim_defs = check_so_api.elf_symbols(sdata)[3]
            still = [s for s in miss if s not in shim_defs]
            if still:
                fail('%s: %s does not provide %s' % (art, SHIM_NAME, ' '.join(still)))
            jni_imports = [n for n, _ in check_so_api.elf_symbols(so[0])[1] if n.startswith('AndroidBitmap_')]
            nofwd = [n for n in jni_imports if n not in shim_defs]
            if nofwd:
                fail('%s: %s lacks forwarders for %s' % (art, SHIM_NAME, nofwd))
            patched = rename_needed(so[0], REPLACED_NEEDED, SHIM_NAME)
            needed_after = check_so_api.elf_symbols(patched)[2]
            if SHIM_NAME not in needed_after or REPLACED_NEEDED in needed_after:
                fail('%s: DT_NEEDED rewrite did not take effect' % art)
            if missing_imports(patched, stubs | shim_defs):
                fail('%s: unresolved imports remain after patching' % art)
            publish(a.out, art, version, jar, {lib: patched}, {'lib/%s/%s' % (abi, SHIM_NAME): sdata},
                    lambda n: False, pom,
                    'payesh row 168: libflutter.so DT_NEEDED %s -> %s; %s provides %s (engine %s)\n'
                    % (REPLACED_NEEDED, SHIM_NAME, SHIM_NAME, ' '.join(miss), engine))
            log('  %s%s: libflutter.so +%s for %s' % (art, SUFFIX, SHIM_NAME, ' '.join(miss)))
            done.append(art)
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--flutter-root', required=True)
    ap.add_argument('--android-jar', required=True)
    ap.add_argument('--ndk', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--modes', default='release')
    ap.add_argument('--work', default=None)
    ap.add_argument('--javac', default='javac')
    a = ap.parse_args()

    root = os.path.abspath(a.flutter_root)
    # the Flutter Gradle plugin uses bin/cache/engine.stamp for io.flutter:*:1.0.0-<stamp>
    stamp = os.path.join(root, 'bin', 'cache', 'engine.stamp')
    if not os.path.isfile(stamp):
        stamp = os.path.join(root, 'bin', 'internal', 'engine.version')
    engine = open(stamp).read().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', engine):
        fail('engine stamp is not a commit hash: %r' % engine)
    src_root = os.path.join(root, 'engine', 'src', 'flutter', 'shell', 'platform', 'android')
    if not os.path.isdir(os.path.join(src_root, 'io', 'flutter')):
        fail('embedding sources not found under ' + src_root)
    if not os.path.isfile(a.android_jar):
        fail('android.jar not found: ' + a.android_jar)
    a.out = os.path.abspath(a.out)
    work = os.path.abspath(a.work or (a.out + '-work'))
    os.makedirs(work, exist_ok=True)
    version = '1.0.0-' + engine
    modes = [m.strip() for m in a.modes.split(',') if m.strip()]
    if not modes or any(m not in ('release', 'profile', 'debug') for m in modes):
        fail('--modes must list release/profile/debug')
    os.makedirs(a.out, exist_ok=True)
    built = []
    for mode in modes:
        stampfile = os.path.join(a.out, 'STAMP-' + mode)
        want = '%s %s' % (engine, digest())
        if os.path.isfile(stampfile) and open(stampfile).read().strip() == want:
            log('  %s: up to date' % mode)
            continue
        if os.path.isfile(stampfile):
            os.remove(stampfile)
        for d in (os.path.join(a.out, 'io', 'flutter'),):
            if os.path.isdir(d):
                for art in os.listdir(d):
                    if art.endswith('_' + mode):
                        shutil.rmtree(os.path.join(d, art))
        log('engine %s [%s]: io.flutter:*_%s:%s -> %s%s' % (engine, mode, mode, version, version, SUFFIX))
        built += build_embedding(a, work, src_root, engine, version, [mode])
        built += build_engine(a, work, engine, version, [mode])
        open(stampfile, 'w').write(want + '\n')
    if 'release' in modes and not os.path.isdir(os.path.join(a.out, 'io', 'flutter', 'flutter_embedding_release')):
        fail('release embedding missing')
    log('ANDROID21-REPO-OK engine=%s modes=%s built=%s repo=%s' % (engine, ','.join(modes), ','.join(built) or '-', a.out))


if __name__ == '__main__':
    main()
