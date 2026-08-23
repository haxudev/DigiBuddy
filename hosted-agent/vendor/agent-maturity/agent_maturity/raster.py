#!/usr/bin/env python3
"""Rasterize the radar SVG to PNG using a headless Chromium-family browser.

Standard library only - no matplotlib, no cairosvg, no pip install. The SVG is
the single source of truth, so the PNG can never disagree with the chart in the
HTML report.

    python <skill-root>/scripts/rasterize.py <session-dir>/radar.svg --out <session-dir>/radar.png

Falls back through Edge, Chrome and Chromium. If none is present the script
exits non-zero and names the manual alternative rather than producing a silently
missing file.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


class RasterizeError(Exception):
    """No usable browser, or the screenshot failed. Callers degrade gracefully."""


def find_browser(explicit=None):
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise RasterizeError(f"browser not found at {explicit}")
    for path in CANDIDATES:
        if os.path.exists(path):
            return path
    for name in ("msedge", "chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    raise RasterizeError(
        "No Chromium-family browser found. Install Edge or Chrome, or pass --browser.\n"
        "Manual alternative: open the .svg in any browser and save it as a PNG."
    )


def svg_size(svg_text, default=(800, 570)):
    m = re.search(r'viewBox\s*=\s*"[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)"', svg_text)
    if m:
        return int(float(m.group(1))), int(float(m.group(2)))
    return default


def rasterize(svg_path, png_path, browser=None, scale=2, timeout=60):
    svg_path = os.path.abspath(svg_path)
    png_path = os.path.abspath(png_path)
    exe = find_browser(browser)

    with open(svg_path, encoding="utf-8") as fh:
        svg_text = fh.read()
    width, height = svg_size(svg_text)

    # Wrap the SVG in a zero-margin page so the screenshot has no chrome or
    # scrollbars and the PNG is exactly the chart.
    holder = (
        '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        "<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}"
        "svg{display:block}</style></head><body>" + svg_text + "</body></html>"
    )
    tmp = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8")
    profile = tempfile.mkdtemp(prefix="amr-raster-")
    try:
        tmp.write(holder)
        tmp.close()
        os.makedirs(os.path.dirname(png_path), exist_ok=True)
        if os.path.exists(png_path):
            os.remove(png_path)

        url = pathlib.Path(tmp.name).as_uri()
        cmd = [
            exe, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            # A private profile per run: sharing the default user-data-dir makes
            # concurrent or back-to-back headless runs block on a singleton lock.
            f"--user-data-dir={profile}",
            "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            f"--force-device-scale-factor={scale}",
            f"--screenshot={png_path}",
            f"--window-size={width},{height}",
            url,
        ]
        try:
            subprocess.run(cmd, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            pass  # the screenshot is often already written; the existence check below decides

        # The headless screenshot is written asynchronously on some builds.
        deadline = time.time() + 10
        while time.time() < deadline:
            if os.path.exists(png_path) and os.path.getsize(png_path) > 0:
                break
            time.sleep(0.4)
    finally:
        for cleanup in (lambda: os.unlink(tmp.name), lambda: shutil.rmtree(profile, ignore_errors=True)):
            try:
                cleanup()
            except OSError:
                pass

    if not os.path.exists(png_path) or os.path.getsize(png_path) == 0:
        raise RasterizeError(
            f"rasterization produced no output at {png_path}.\n"
            "Manual alternative: open the .svg in any browser and save it as a PNG."
        )
    return png_path, os.path.getsize(png_path), (width * scale, height * scale)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("svg")
    ap.add_argument("--out", required=True)
    ap.add_argument("--browser", default=None)
    ap.add_argument("--scale", type=int, default=2, help="device scale factor; 2 gives a crisp PNG for decks")
    args = ap.parse_args(argv)

    path, size, (w, h) = rasterize(args.svg, args.out, browser=args.browser, scale=args.scale)
    print(f"wrote {path} ({size} bytes, {w}x{h} px)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
