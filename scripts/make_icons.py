"""Genera los iconos PNG de la PWA (solo necesita Pillow). Uso: python scripts/make_icons.py"""
import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "icons")
BG = (11, 15, 20, 255)
CARD = (240, 162, 58, 255)
INK = (11, 15, 20, 255)
ART = (26, 35, 48, 255)
ACCENT = (58, 208, 160, 255)


def render(size: int, maskable: bool = False) -> Image.Image:
    s = 4  # supersampling para bordes suaves
    w = size * s
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, w, w], fill=BG)
    else:
        d.rounded_rectangle([0, 0, w - 1, w - 1], radius=w * 0.22, fill=BG)

    m = 0.16 if maskable else 0.11  # margen (zona segura más amplia en el maskable)
    inner = w * (1 - 2 * m)
    cw = inner * 0.52
    ch = cw * 88 / 63
    x0 = w / 2 - cw / 2
    y0 = w / 2 - ch / 2
    r = cw * 0.02
    d.rounded_rectangle([x0, y0, x0 + cw, y0 + ch], radius=cw * 0.08, fill=CARD)
    d.rounded_rectangle([x0 + cw * 0.1, y0 + ch * 0.08, x0 + cw * 0.9, y0 + ch * 0.17], radius=r, fill=INK)
    d.rounded_rectangle([x0 + cw * 0.1, y0 + ch * 0.22, x0 + cw * 0.9, y0 + ch * 0.62], radius=r, fill=ART)
    d.rounded_rectangle([x0 + cw * 0.1, y0 + ch * 0.68, x0 + cw * 0.9, y0 + ch * 0.75], radius=r, fill=INK)
    d.rounded_rectangle([x0 + cw * 0.1, y0 + ch * 0.80, x0 + cw * 0.7, y0 + ch * 0.86], radius=r, fill=INK)

    # esquinas de "escaneo"
    bw = int(w * 0.045)
    seg = inner * 0.16
    ox = w * m
    ex = w - ox
    for px, py, dx, dy in [(ox, ox, 1, 1), (ex, ox, -1, 1), (ox, ex, 1, -1), (ex, ex, -1, -1)]:
        d.line([(px, py + dy * seg), (px, py), (px + dx * seg, py)], fill=ACCENT, width=bw, joint="curve")

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    render(192).save(os.path.join(OUT, "icon-192.png"))
    render(512).save(os.path.join(OUT, "icon-512.png"))
    render(512, maskable=True).save(os.path.join(OUT, "maskable-512.png"))
    render(180, maskable=True).convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"))
    print("iconos generados en", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
