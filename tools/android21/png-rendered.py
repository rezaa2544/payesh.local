#!/usr/bin/env python3
"""Row 168: did the app draw a real frame? Decodes a screencap PNG (pure Python: zlib + filters)
and requires enough distinct colours in the app area — a blank/white launch window or a black
screen has a handful; a rendered Flutter page (text, icons, anti-aliasing) has many.
usage: png-rendered.py shot.png [--min-colours 40]   exit 0 = rendered"""
import struct
import sys
import zlib


def decode(path):
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('not a PNG')
    pos, idat, w = 8, b'', None
    while pos < len(data):
        n, typ = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if typ == b'IHDR':
            w, h, depth, ctype = struct.unpack('>IIBB', body[:10])
            if depth != 8 or ctype not in (2, 6):
                raise ValueError('unsupported PNG type %d/%d' % (depth, ctype))
            bpp = 3 if ctype == 2 else 4
        elif typ == b'IDAT':
            idat += body
        pos += 12 + n
    raw = zlib.decompress(idat)
    stride = w * bpp
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(bytes(line))
        prev = line
    return w, h, bpp, rows


def main():
    path = sys.argv[1]
    need = int(sys.argv[sys.argv.index('--min-colours') + 1]) if '--min-colours' in sys.argv else 40
    try:
        w, h, bpp, rows = decode(path)
    except Exception as e:  # noqa: BLE001
        print('PNG-RENDERED-FAIL %s: %s' % (path, e))
        return 1
    colours = set()
    for y in range(int(h * 0.08), int(h * 0.95), 3):  # skip the status bar / nav bar
        r = rows[y]
        for x in range(0, w, 3):
            colours.add(r[x * bpp:x * bpp + 3])
    ok = len(colours) >= need
    print('PNG-RENDERED-%s %s %dx%d distinct_colours=%d (need %d)' % ('OK' if ok else 'FAIL', path, w, h, len(colours), need))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
