"""Gzip web/ into firmware/data/www/ for the LittleFS image.

Usage: python tools/build_web.py   (then: pio run -t uploadfs  in firmware/)
ESPAsyncWebServer serves foo.js.gz transparently when foo.js is requested.
"""
import gzip
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "web"
DST = ROOT / "firmware" / "data" / "www"


def main() -> None:
    if DST.exists():
        shutil.rmtree(DST)
    total_raw = total_gz = 0
    for f in sorted(SRC.rglob("*")):
        if f.is_dir():
            continue
        rel = f.relative_to(SRC)
        out = DST / (str(rel) + ".gz")
        out.parent.mkdir(parents=True, exist_ok=True)
        raw = f.read_bytes()
        gz = gzip.compress(raw, compresslevel=9, mtime=0)
        out.write_bytes(gz)
        total_raw += len(raw)
        total_gz += len(gz)
        print(f"  {rel.as_posix():24} {len(raw):7} -> {len(gz):6} bytes")
    print(f"Total {total_raw} -> {total_gz} bytes ({total_gz / 1024:.1f} KB) in {DST}")
    if total_gz > 150 * 1024:
        raise SystemExit("Web UI too large for the 190 KB LittleFS partition")


if __name__ == "__main__":
    main()
