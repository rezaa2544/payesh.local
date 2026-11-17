#!/usr/bin/env python3
"""Row 168: every native library in the APK must load on Android 5.0 (API 21).

Reads each ELF shared object (no external tools: pure Python ELF parser), lists the
dynamic symbols it imports, and looks them up in bionic's symbol maps
(libc/libm/libdl .map.txt, which record the API level that introduced each symbol,
per architecture). A library that imports a symbol introduced after --api fails to
load there ("cannot locate symbol"), so any such import is an error.

usage: check-so-api.py [--api 21] [--maps DIR] FILE.so|FILE.apk ...
  --maps DIR   directory with libc.map.txt, libm.map.txt, libdl.map.txt (downloaded
               from android.googlesource.com when missing)
An import is also satisfied by a library bundled in the same directory that the importer
lists in DT_NEEDED (row 168: libpayeshw21.so next to the 64-bit libflutter.so).
Prints SO-API-OK on success; exit 1 otherwise.
"""
import argparse
import base64
import io
import os
import re
import struct
import sys
import urllib.request
import zipfile

BIONIC = 'https://android.googlesource.com/platform/bionic/+/refs/heads/main/{}.map.txt?format=TEXT'
MAPS = {'libc': 'libc/libc', 'libm': 'libm/libm', 'libdl': 'libdl/libdl'}
VERSION_API = {'LIBC': 9, 'LIBC_N': 24, 'LIBC_O': 26, 'LIBC_P': 28, 'LIBC_Q': 29, 'LIBC_R': 30,
               'LIBC_S': 31, 'LIBC_T': 33, 'LIBC_U': 34, 'LIBC_V': 35, 'LIBC_W': 36}
MACHINE = {40: 'arm', 183: 'arm64', 3: 'x86', 62: 'x86_64'}
# Symbols every Android linker provides itself, or that only exist in the toolchain runtime.
LINKER = {'__cxa_finalize', '__cxa_atexit', 'dl_iterate_phdr', 'dladdr', 'dlclose', 'dlerror',
          'dlopen', 'dlsym', '__aeabi_unwind_cpp_pr0', '__aeabi_unwind_cpp_pr1', '__gnu_Unwind_Find_exidx'}


def load_maps(d):
    os.makedirs(d, exist_ok=True)
    table = {}
    for lib, path in MAPS.items():
        f = os.path.join(d, lib + '.map.txt')
        if not os.path.isfile(f):
            with urllib.request.urlopen(BIONIC.format(path), timeout=60) as r:
                open(f, 'wb').write(base64.b64decode(r.read()))
        version_api = None
        for line in open(f, encoding='utf-8'):
            m = re.match(r'^(\w+)\s*\{(.*)', line)
            if m:
                intro = re.search(r'introduced=(\d+)', m.group(2))
                version_api = VERSION_API.get(m.group(1), int(intro.group(1)) if intro else 9)
                continue
            m = re.match(r'^\s+([A-Za-z_]\w*);\s*(#.*)?$', line)
            if m and version_api is not None:
                comment = m.group(2) or ''
                api = version_api
                g = re.search(r'introduced=(\d+)', comment)
                if g:
                    api = max(api, int(g.group(1)))
                per = {k: int(v) for k, v in re.findall(r'introduced-(arm|arm64|x86|x86_64)=(\d+)', comment)}
                arches = re.findall(r'\b(arm|arm64|x86|x86_64)\b', comment.split('introduced')[0]) if comment else []
                table.setdefault(m.group(1), []).append((api, per, set(arches)))
    return table


def elf_imports(data):
    arch, imports, needed, _ = elf_symbols(data)
    return arch, imports, needed


def elf_symbols(data):
    """(arch, [(undefined name, weak)], needed, {defined dynamic symbol names})."""
    if data[:4] != b'\x7fELF':
        raise ValueError('not an ELF file')
    is64 = data[4] == 2
    end = '<' if data[5] == 1 else '>'
    if is64:
        e_machine = struct.unpack_from(end + 'H', data, 18)[0]
        e_shoff, = struct.unpack_from(end + 'Q', data, 40)
        e_shentsize, e_shnum = struct.unpack_from(end + 'HH', data, 58)
    else:
        e_machine = struct.unpack_from(end + 'H', data, 18)[0]
        e_shoff, = struct.unpack_from(end + 'I', data, 32)
        e_shentsize, e_shnum = struct.unpack_from(end + 'HH', data, 46)
    secs = []
    for i in range(e_shnum):
        o = e_shoff + i * e_shentsize
        if is64:
            name, typ, flags, addr, off, size, link, info, align, entsize = struct.unpack_from(end + 'IIQQQQIIQQ', data, o)
        else:
            name, typ, flags, addr, off, size, link, info, align, entsize = struct.unpack_from(end + 'IIIIIIIIII', data, o)
        secs.append((typ, off, size, link, entsize))
    imports, needed, defined = [], [], set()
    for typ, off, size, link, entsize in secs:
        if typ == 11:  # SHT_DYNSYM
            stro = secs[link][1]
            for j in range(1, size // entsize):
                o = off + j * entsize
                if is64:
                    st_name, st_info, st_other, st_shndx = struct.unpack_from(end + 'IBBH', data, o)
                else:
                    st_name, = struct.unpack_from(end + 'I', data, o)
                    st_info, st_other, st_shndx = struct.unpack_from(end + 'BBH', data, o + 12)
                bind = st_info >> 4
                n = data[stro + st_name: data.index(b'\0', stro + st_name)].decode()
                if st_shndx == 0 and bind in (1, 2):  # undefined GLOBAL/WEAK
                    imports.append((n, bind == 2))
                elif st_shndx != 0 and bind in (1, 2) and n:
                    defined.add(n)
        if typ == 6:  # SHT_DYNAMIC
            stro = secs[link][1]
            step = 16 if is64 else 8
            for o in range(off, off + size, step):
                tag, val = struct.unpack_from(end + ('qQ' if is64 else 'iI'), data, o)
                if tag == 0:
                    break
                if tag == 1:
                    needed.append(data[stro + val: data.index(b'\0', stro + val)].decode())
    return MACHINE.get(e_machine, str(e_machine)), imports, needed, defined


def min_api(entries, arch):
    best = None
    for api, per, arches in entries:
        if arches and arch not in arches:
            continue
        a = max(api, per.get(arch, 0))
        best = a if best is None else min(best, a)
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--api', type=int, default=21)
    ap.add_argument('--maps', default=os.path.join(os.environ.get('RUNNER_TEMP', '/tmp'), 'bionic-maps'))
    ap.add_argument('files', nargs='+')
    a = ap.parse_args()
    table = load_maps(a.maps)
    libs = []
    for f in a.files:
        if f.endswith(('.apk', '.aab', '.zip', '.jar')):
            with zipfile.ZipFile(f) as z:
                for n in z.namelist():
                    if n.endswith('.so'):
                        libs.append(('%s!%s' % (os.path.basename(f), n), z.read(n)))
        else:
            libs.append((f, open(f, 'rb').read()))
    if not libs:
        sys.exit('SO-API-FAIL no native libraries found')
    bad = 0
    # symbols defined by libraries bundled in the same directory (e.g. libpayeshw21.so next to
    # libflutter.so): they satisfy an import when the importer lists them in DT_NEEDED.
    parsed = [(name, elf_symbols(data)) for name, data in libs]
    provided = {}
    for name, (_, _, _, defined) in parsed:
        d, b = os.path.split(name.split('!')[-1])
        provided[(name.split('!')[0], d, b)] = defined
    for name, (arch, imports, needed, _) in parsed:
        own = {os.path.basename(n.split('!')[-1]) for n, _ in libs}
        src, d = name.split('!')[0], os.path.dirname(name.split('!')[-1])
        bundled = set()
        for n in needed:
            bundled |= provided.get((src, d, n), set())
        foreign = [n for n in needed if n not in ('libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so',
                                                  'libEGL.so', 'libGLESv2.so', 'libGLESv3.so', 'libvulkan.so',
                                                  'libjnigraphics.so', 'libz.so', 'libOpenSLES.so', 'libmediandk.so',
                                                  'libnativewindow.so') and n not in own]
        problems = []
        for sym, weak in imports:
            if sym in LINKER or sym in bundled:
                continue
            e = table.get(sym)
            if e is None:
                continue  # defined by another bundled library or an NDK system library outside libc/libm/libdl
            api = min_api(e, arch)
            if api is not None and api > a.api and not weak:
                problems.append('%s(API %d)' % (sym, api))
        status = 'OK' if not problems else 'BAD'
        print('%-3s %s [%s] imports=%d needed=%s%s' % (status, name, arch, len(imports), ','.join(needed),
                                                         ('  > API %d: %s' % (a.api, ' '.join(sorted(problems)))) if problems else ''))
        if foreign:
            print('    note: NEEDED outside the NDK stable set: %s' % ','.join(foreign))
        bad += len(problems)
    if bad:
        print('SO-API-FAIL %d imports newer than API %d' % (bad, a.api))
        sys.exit(1)
    print('SO-API-OK %d libraries load on API %d' % (len(libs), a.api))


if __name__ == '__main__':
    main()
