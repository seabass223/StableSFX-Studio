"""Render the app icon (orange waveform on a dark rounded tile) to build/icon.png, build/icon.ico
and build/drag.png. Pure numpy + zlib; run with the engine venv: engine/.venv/Scripts/python scripts/make-icons.py"""

import struct
import sys
import zlib
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "build"
BARS = [0.10, 0.22, 0.38, 0.62, 0.86, 0.56, 0.30, 0.70, 0.95, 0.66, 0.36, 0.50, 0.24, 0.12]


def render(size: int, tile: bool = True) -> np.ndarray:
    ss = 4
    n = size * ss
    y, x = np.mgrid[0:n, 0:n].astype(np.float32) / n
    rgba = np.zeros((n, n, 4), np.float32)
    if tile:
        r = 0.2
        dx = np.maximum(np.abs(x - 0.5) - (0.5 - r), 0)
        dy = np.maximum(np.abs(y - 0.5) - (0.5 - r), 0)
        inside = (dx**2 + dy**2) <= r**2
        top = np.array([0.13, 0.095, 0.07])
        bottom = np.array([0.055, 0.04, 0.03])
        col = top[None, None] * (1 - y[..., None]) + bottom[None, None] * y[..., None]
        rgba[inside, :3] = col[inside]
        rgba[inside, 3] = 1.0
        rim = inside & ((dx**2 + dy**2) > (r - 0.012) ** 2)
        rgba[rim, :3] = [0.35, 0.18, 0.08]
    count = len(BARS)
    margin = 0.17
    width = (1 - 2 * margin) / count
    glow = np.zeros((n, n), np.float32)
    for i, h in enumerate(BARS):
        cx = margin + (i + 0.5) * width
        half_w = width * 0.28
        half_h = 0.34 * h
        bar = (np.abs(x - cx) <= half_w) & (np.abs(y - 0.5) <= half_h)
        t = np.clip((y - (0.5 - half_h)) / max(2 * half_h, 1e-6), 0, 1)
        color = np.stack([np.ones_like(t), 0.72 - 0.38 * t, 0.40 - 0.33 * t], -1)
        rgba[bar, :3] = color[bar]
        rgba[bar, 3] = 1.0
        glow += np.exp(-(((x - cx) / (half_w * 3)) ** 2 + ((y - 0.5) / (half_h + 0.05)) ** 2)) * 0.25
    glow_mask = (rgba[..., 3] > 0) & ~np.isclose(rgba[..., 0], 1.0)
    rgba[glow_mask, :3] += np.clip(glow[glow_mask], 0, 0.6)[:, None] * np.array([1.0, 0.45, 0.1])
    rgba = np.clip(rgba, 0, 1)
    rgba = rgba.reshape(size, ss, size, ss, 4).mean(axis=(1, 3))
    return (rgba * 255).round().astype(np.uint8)


def png(img: np.ndarray) -> bytes:
    h, w, _ = img.shape
    raw = b"".join(b"\x00" + img[row].tobytes() for row in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def ico(images: list[bytes], sizes: list[int]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for data, s in zip(images, sizes):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + entries + blobs


def main() -> None:
    OUT.mkdir(exist_ok=True)
    (OUT / "icon.png").write_bytes(png(render(512)))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    (OUT / "icon.ico").write_bytes(ico([png(render(s)) for s in sizes], sizes))
    (OUT / "drag.png").write_bytes(png(render(48)))
    print("wrote", ", ".join(p.name for p in OUT.iterdir()), file=sys.stderr)


if __name__ == "__main__":
    main()
