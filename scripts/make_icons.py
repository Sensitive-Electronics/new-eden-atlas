"""Render every application icon from one source, which is the page's own mark.

The icons were the spike's placeholders - 1,434 and 1,456 bytes - and `.ico`
held a single 256x256, which Windows downscales for the taskbar and Alt-Tab
rather than drawing a size meant for them.

The mark is not invented here. `web/index.html` already carries it as the
favicon: a dark rounded square, a gold kite outline, a teal core. Rendering the
*same* mark means the browser tab, the window, the taskbar and the `.deb` all
show one thing, and there is one place to change it.

    python3 scripts/make_icons.py            # write the set
    python3 scripts/make_icons.py --check    # report, change nothing

Needs `rsvg-convert` (librsvg2-bin), which the Tauri build dependencies already
pull in, and Pillow for the multi-size `.ico`.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri" / "icons"

# The favicon in web/index.html, as markup rather than as a percent-encoded URL.
# Keep the two the same: this is the project's mark, in one place.
SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="7" fill="#0a0d10"/>
  <path d="M12 43 32 9l20 34-20 12Z" fill="none" stroke="#d9b95b" stroke-width="5"
        stroke-linejoin="round"/>
  <circle cx="32" cy="33" r="5" fill="#6fe0d2"/>
</svg>
"""

# The Linux bundler installs these by exact name; icon.png is what the manifest
# has always listed. 128x128@2x is 256, which is what the "@2x" means.
PNGS = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 256,
}

# An .ico should carry the sizes the shell actually asks for, so the taskbar,
# Alt-Tab and Explorer each get one drawn for them rather than downscaled.
ICO_SIZES = [16, 32, 48, 256]


def render(svg_path: Path, size: int, out: Path) -> None:
    subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(out), str(svg_path)],
        check=True,
    )


def main() -> int:
    check = "--check" in sys.argv[1:]
    try:
        from PIL import Image
    except ImportError:
        print("Pillow is required for the multi-size .ico: pip install pillow")
        return 1

    ICONS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        svg = Path(tmp) / "mark.svg"
        svg.write_text(SVG, encoding="utf-8")

        if check:
            missing = [n for n in list(PNGS) + ["icon.ico"] if not (ICONS / n).is_file()]
            if missing:
                print("missing: " + ", ".join(missing))
                return 1
            print(f"all {len(PNGS) + 1} icons present")
            return 0

        for name, size in PNGS.items():
            render(svg, size, ICONS / name)
            print(f"  {name:16s} {size}x{size}")

        # One render per size rather than one downscaled: a 16px icon drawn at
        # 16px keeps the stroke, and a 256 squeezed into 16 does not.
        frames = []
        for size in ICO_SIZES:
            out = Path(tmp) / f"{size}.png"
            render(svg, size, out)
            frames.append(Image.open(out).convert("RGBA"))
        frames[-1].save(
            ICONS / "icon.ico",
            format="ICO",
            sizes=[(s, s) for s in ICO_SIZES],
            append_images=frames[:-1],
        )
        print(f"  {'icon.ico':16s} {', '.join(f'{s}x{s}' for s in ICO_SIZES)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
