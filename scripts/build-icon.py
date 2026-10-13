"""Build the macOS app icon from a full-bleed square logo.

    python3 scripts/build-icon.py resources/icon-source.png

Fits the artwork into Apple's icon grid (an 824 px rounded square with continuous
corners, centered on a 1024 px canvas, with a soft shadow in the margin) and writes
resources/icon.png plus build/icon.icns with every size macOS uses.
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

CANVAS = 1024
SHAPE = 824  # Apple's macOS icon grid: 100 px margin on each side
SUPERSAMPLE = 4
ROOT = Path(__file__).resolve().parent.parent


def squircle_mask(size: int) -> Image.Image:
    """Apple-style rounded square: straight edges, continuous-curvature corners.

    Each corner is a superellipse quadrant spanning ~1.5x the nominal 22.5% radius,
    which matches the smoothed corners of Apple's icon template.
    """
    n = size * SUPERSAMPLE
    reach = 0.225 * 1.528 * n  # how far along each edge the corner curve extends
    exponent = 3.6
    coords = np.arange(n) + 0.5
    x, y = np.meshgrid(coords, coords)
    a = np.maximum(np.maximum(reach - x, x - (n - reach)), 0) / reach
    b = np.maximum(np.maximum(reach - y, y - (n - reach)), 0) / reach
    inside = a**exponent + b**exponent <= 1
    mask = Image.fromarray((inside * 255).astype(np.uint8))
    return mask.resize((size, size), Image.LANCZOS)


def build(source: Path) -> None:
    art = Image.open(source).convert('RGBA')
    # Fill the corners the artwork leaves transparent with its own edge colors, so the
    # (rounder) squircle mask never shows a gap.
    w, h = art.size
    base = art.resize((8, 8), Image.BILINEAR).resize((w, h), Image.BILINEAR)
    base.alpha_composite(art)
    art = base.resize((SHAPE, SHAPE), Image.LANCZOS)

    shape = Image.new('RGBA', (SHAPE, SHAPE))
    shape.paste(art, (0, 0), squircle_mask(SHAPE))

    offset = (CANVAS - SHAPE) // 2
    icon = Image.new('RGBA', (CANVAS, CANVAS))
    shadow_alpha = Image.new('L', (CANVAS, CANVAS))
    shadow_alpha.paste(shape.getchannel('A'), (offset, offset + 12))
    shadow = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow.putalpha(shadow_alpha.filter(ImageFilter.GaussianBlur(14)).point(lambda a: a * 0.3))
    icon.alpha_composite(shadow)
    icon.alpha_composite(shape, (offset, offset))

    resources = ROOT / 'resources'
    resources.mkdir(exist_ok=True)
    icon.save(resources / 'icon.png')

    sizes = [16, 32, 128, 256, 512]
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / 'icon.iconset'
        iconset.mkdir()
        for s in sizes:
            icon.resize((s, s), Image.LANCZOS).save(iconset / f'icon_{s}x{s}.png')
            icon.resize((s * 2, s * 2), Image.LANCZOS).save(iconset / f'icon_{s}x{s}@2x.png')
        (ROOT / 'build').mkdir(exist_ok=True)
        subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(ROOT / 'build' / 'icon.icns')], check=True)

    print('wrote resources/icon.png and build/icon.icns')


if __name__ == '__main__':
    src = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'resources' / 'icon-source.png')
    if src.resolve() != (ROOT / 'resources' / 'icon-source.png').resolve():
        (ROOT / 'resources').mkdir(exist_ok=True)
        Image.open(src).save(ROOT / 'resources' / 'icon-source.png')
    build(ROOT / 'resources' / 'icon-source.png')
    shutil.rmtree(ROOT / 'resources' / '__pycache__', ignore_errors=True)
