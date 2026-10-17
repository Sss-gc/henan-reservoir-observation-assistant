"""Render the app's simple satellite-and-water vector mark to a PNG avatar."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SCALE = 3
SIZE = 512


def scaled(points):
    return tuple(int(value * SCALE) for value in points)


def main():
    image = Image.new("RGB", (SIZE * SCALE, SIZE * SCALE), "#081b26")
    draw = ImageDraw.Draw(image)
    draw.ellipse(scaled((68, 68, 444, 444)), outline="#174653", width=2 * SCALE)
    draw.ellipse(scaled((90, 90, 422, 422)), outline="#103541", width=SCALE)

    satellite = Image.new("RGBA", image.size)
    pen = ImageDraw.Draw(satellite)
    pen.line(scaled((122, 222, 390, 222)), fill="#5eead4", width=8 * SCALE)
    for left in (102, 312):
        pen.rounded_rectangle(scaled((left, 181, left + 98, 263)), radius=8 * SCALE,
                              fill="#123d50", outline="#5bc4dd", width=4 * SCALE)
        for offset in (33, 65):
            pen.line(scaled((left + offset, 184, left + offset, 260)), fill="#2d7186", width=2 * SCALE)
        pen.line(scaled((left + 2, 222, left + 96, 222)), fill="#2d7186", width=2 * SCALE)
    pen.rounded_rectangle(scaled((222, 181, 290, 263)), radius=13 * SCALE, fill="#5eead4")
    pen.rounded_rectangle(scaled((235, 198, 277, 247)), radius=7 * SCALE, fill="#0c3440")
    pen.line(scaled((256, 178, 256, 155)), fill="#5eead4", width=5 * SCALE)
    pen.ellipse(scaled((249, 141, 263, 155)), fill="#5eead4")
    pen.line(scaled((256, 266, 256, 286)), fill="#5eead4", width=5 * SCALE)
    pen.arc(scaled((236, 278, 276, 310)), 190, 350, fill="#5eead4", width=5 * SCALE)
    satellite = satellite.rotate(28, resample=Image.Resampling.BICUBIC)
    image.paste(satellite, (0, 0), satellite)
    draw = ImageDraw.Draw(image)

    # Two smooth water contours beneath the orbiting satellite.
    import math
    for baseline, color in ((357, "#2dd4bf"), (389, "#45a4d0")):
        points = [(int(x * SCALE), int((baseline + 7 * math.sin((x - 112) * math.pi / 96)) * SCALE))
                  for x in range(112, 401)]
        draw.line(points, fill=color, width=6 * SCALE, joint="curve")
    draw.line(scaled((373, 106, 373, 130)), fill="#91e9e1", width=3 * SCALE)
    draw.line(scaled((361, 118, 385, 118)), fill="#91e9e1", width=3 * SCALE)
    output = ROOT / "miniprogram/assets/app-avatar.png"
    output.parent.mkdir(parents=True, exist_ok=True)
    image.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(output, optimize=True)
    print(f"Avatar: {output} ({SIZE} x {SIZE} PNG)")


if __name__ == "__main__":
    main()
