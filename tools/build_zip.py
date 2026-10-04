#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 extension/ 打包成可分发的 zip。

- manifest.json 位于压缩包根目录（符合 Chrome/Edge 应用商店与「加载解压缩」的约定）
- 路径统一使用正斜杠（Windows 的 zip 工具常写成反斜杠，部分解压器会出错）

用法：python tools/build_zip.py
"""

import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'extension')


def main():
    manifest_path = os.path.join(SRC, 'manifest.json')
    if not os.path.isfile(manifest_path):
        print('找不到 %s' % manifest_path, file=sys.stderr)
        return 1

    with open(manifest_path, encoding='utf-8') as f:
        manifest = json.load(f)

    name = manifest.get('name', 'extension')
    version = manifest.get('version', '0.0.0')
    out = os.path.join(ROOT, '%s-v%s.zip' % (name, version))

    if os.path.exists(out):
        os.remove(out)

    count = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for dirpath, dirnames, filenames in os.walk(SRC):
            dirnames.sort()
            filenames.sort()
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                arc = os.path.relpath(full, SRC).replace(os.sep, '/')
                z.write(full, arc)
                count += 1

    with zipfile.ZipFile(out) as z:
        broken = z.testzip()
        if broken:
            print('压缩包损坏：%s' % broken, file=sys.stderr)
            return 1

    print('已生成：%s' % os.path.basename(out))
    print('  条目 %d 个，共 %d 字节' % (count, os.path.getsize(out)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
