"""生成扩展图标：蓝色圆角方块 + 白色音符（大尺寸再加下载箭头）。"""
from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]
SS = 8  # 超采样倍数
OUT = r"E:\OTHER\浏览器音频抓取扩展\extension\icons"

TOP = (74, 130, 242)     # #4a82f2
BOTTOM = (24, 72, 190)   # #1848be


def gradient(size):
    img = Image.new("RGB", (1, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(int(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t)) for i in range(3))
        d.point((0, y), fill=c)
    return img.resize((size, size), Image.BILINEAR)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_note(d, S, with_arrow):
    """在超采样画布上画白色音符；with_arrow 时右侧加一个下载箭头。"""
    note_w = 0.62 if with_arrow else 0.86
    x0 = 0.10 * S
    W = note_w * S

    head_rx, head_ry = 0.150 * W, 0.118 * W
    head_cx, head_cy = x0 + 0.30 * W, 0.685 * S
    d.ellipse([head_cx - head_rx, head_cy - head_ry, head_cx + head_rx, head_cy + head_ry], fill="white")

    stem_x = head_cx + head_rx * 0.76
    stem_w = 0.088 * W
    d.rectangle([stem_x, 0.245 * S, stem_x + stem_w, head_cy], fill="white")

    # 旗（音符的小尾巴）
    d.polygon(
        [
            (stem_x + stem_w, 0.245 * S),
            (stem_x + stem_w + 0.30 * W, 0.315 * S),
            (stem_x + stem_w + 0.30 * W, 0.430 * S),
            (stem_x + stem_w, 0.395 * S),
        ],
        fill="white",
    )

    if with_arrow:
        ax = 0.795 * S
        aw = 0.075 * S
        top, bot = 0.30 * S, 0.635 * S
        d.rectangle([ax - aw / 2, top, ax + aw / 2, bot], fill="white")
        d.polygon(
            [(ax - 0.165 * S, bot - 0.01 * S), (ax + 0.165 * S, bot - 0.01 * S), (ax, 0.80 * S)],
            fill="white",
        )


def build(size):
    S = size * SS
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = gradient(S).convert("RGBA")
    base.paste(grad, (0, 0), rounded_mask(S, int(S * 0.225)))

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw_note(ImageDraw.Draw(layer), S, with_arrow=(size >= 48))
    base = Image.alpha_composite(base, layer)
    return base.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import os
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        build(s).save(os.path.join(OUT, "icon%d.png" % s))
        print("written", os.path.join(OUT, "icon%d.png" % s))
