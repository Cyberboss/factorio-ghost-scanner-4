#!/usr/bin/env python3
"""Write a Factorio mod-settings.dat holding runtime-global overrides.

    mod-settings.py <out.dat> name=value [name=value ...]

Values are parsed as true/false, then number, then string. Used by test/run.sh so a
headless run can flip a mod setting without hand editing the prototype defaults.
"""
import struct
import sys

NONE, BOOL, NUMBER, STRING, LIST, DICT = range(6)


def u8(v):
    return struct.pack("<B", v)


def opt_uint(v):
    # space optimized: one byte, or 255 followed by a full uint32
    return u8(v) if v < 255 else u8(255) + struct.pack("<I", v)


def pstring(s):
    b = s.encode("utf8")
    if not b:
        return u8(1)  # empty flag
    return u8(0) + opt_uint(len(b)) + b


def tree(value):
    if isinstance(value, bool):
        return u8(BOOL) + u8(0) + u8(1 if value else 0)
    if isinstance(value, (int, float)):
        return u8(NUMBER) + u8(0) + struct.pack("<d", float(value))
    if isinstance(value, str):
        return u8(STRING) + u8(0) + pstring(value)
    if isinstance(value, dict):
        out = u8(DICT) + u8(0) + struct.pack("<I", len(value))
        for k, v in value.items():
            out += pstring(k) + tree(v)
        return out
    raise TypeError(value)


def parse(raw):
    if raw in ("true", "false"):
        return raw == "true"
    try:
        return float(raw) if "." in raw else int(raw)
    except ValueError:
        return raw


def main():
    out, pairs = sys.argv[1], sys.argv[2:]
    runtime = {}
    for pair in pairs:
        name, _, raw = pair.partition("=")
        runtime[name] = {"value": parse(raw)}

    blob = struct.pack("<HHHH", 2, 1, 14, 0) + u8(0)
    blob += tree({"startup": {}, "runtime-global": runtime, "runtime-per-user": {}})
    with open(out, "wb") as fh:
        fh.write(blob)
    print(f"wrote {out}: {', '.join(runtime) or 'no overrides'}")


if __name__ == "__main__":
    main()
