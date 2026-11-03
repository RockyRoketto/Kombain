#!/usr/bin/env python3
"""Прописывает версию программы (appVersion из update.go) в ресурсы exe — rsrc_windows_amd64.syso.

Меняет на месте, не сдвигая байты: VS_FIXEDFILEINFO (числа), строки FileVersion/ProductVersion
и version="…" в манифесте. Поэтому длина строки версии должна совпадать со старой
(1.4.0 → 1.5.0 можно, 1.9.0 → 1.10.0 — нет: тогда нужно пересобрать syso через go-winres).

Запуск из папки с исходниками:  python3 tools/setversion.py
"""
import re, struct, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
syso = root / 'rsrc_windows_amd64.syso'
ver = re.search(r'appVersion\s*=\s*"(\d+)\.(\d+)\.(\d+)"', (root / 'update.go').read_text(encoding='utf-8'))
if not ver:
    sys.exit('appVersion не найден в update.go')
a, b, c = map(int, ver.groups())
new3, new4 = f'{a}.{b}.{c}', f'{a}.{b}.{c}.0'

data = bytearray(syso.read_bytes())

# 1) VS_FIXEDFILEINFO: сигнатура 0xFEEF04BD, дальше StrucVersion, FileVersionMS/LS, ProductVersionMS/LS
sig = data.find(struct.pack('<I', 0xFEEF04BD))
if sig < 0:
    sys.exit('в syso нет VS_FIXEDFILEINFO')
ms, ls = (a << 16) | b, (c << 16)
old_ms, old_ls = struct.unpack_from('<2I', data, sig + 8)
old3 = f'{old_ms >> 16}.{old_ms & 0xFFFF}.{old_ls >> 16}'
struct.pack_into('<4I', data, sig + 8, ms, ls, ms, ls)

if len(old3) != len(new3):
    sys.exit(f'длина версии изменилась ({old3} → {new3}); пересобери syso через go-winres')

# 2) строки FileVersion / ProductVersion (UTF-16)
n = 0
for key in ('FileVersion', 'ProductVersion'):
    k = data.find(key.encode('utf-16le') + b'\0\0')
    if k < 0:
        sys.exit(f'нет строки {key}')
    v = data.find(old3.encode('utf-16le'), k, k + 80)
    if v < 0:
        sys.exit(f'в {key} не найдено {old3}')
    data[v:v + len(old3) * 2] = new3.encode('utf-16le')
    n += 1

# 3) манифест: version="x.y.z.0"
old_m, new_m = f'version="{old3}.0"'.encode(), f'version="{new4}"'.encode()
m = data.find(old_m)
if m >= 0:
    data[m:m + len(old_m)] = new_m
    n += 1

orig = syso.stat().st_size
if len(data) != orig:  # на всякий случай: размер обязан остаться прежним
    sys.exit(f'размер изменился ({orig} → {len(data)}), файл не записан')
syso.write_bytes(bytes(data))
print(f'{syso.name}: {old3} → {new3} (исправлено мест: {n + 1})')
