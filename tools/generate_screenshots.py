# /// script
# dependencies = ["Pillow"]
# ///

import csv
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent.parent
BASE_IMAGE = ROOT / "docs" / "img" / "screen_CWS.png"
CSV_PATH = ROOT / "docs" / "lang" / "Хоопонопоно анзвание и фразы - Хоопонопоно_ переводы и поисковые форматы.csv"
OUTPUT_DIR = ROOT / "docs" / "img"

FONT_MAP: dict[str, list[str]] = {
    # CJK
    "zh_CN": ["/System/Library/Fonts/STHeiti Light.ttc"],
    "zh_TW": ["/System/Library/Fonts/STHeiti Light.ttc"],
    "ja":    ["/System/Library/Fonts/Hiragino Sans GB.ttc"],
    "ko":    ["/System/Library/Fonts/AppleSDGothicNeo.ttc"],
    # Arabic script
    "ar":    ["/System/Library/Fonts/GeezaPro.ttc"],
    "fa":    ["/System/Library/Fonts/GeezaPro.ttc"],
    # Hebrew
    "he":    ["/System/Library/Fonts/ArialHB.ttc"],
    # Indic
    "hi":    ["/System/Library/Fonts/Kohinoor.ttc"],
    "bn":    ["/System/Library/Fonts/KohinoorBangla.ttc"],
    "gu":    ["/System/Library/Fonts/KohinoorGujarati.ttc"],
    "te":    ["/System/Library/Fonts/KohinoorTelugu.ttc"],
    "kn":    ["/System/Library/Fonts/NotoSansKannada.ttc"],
    # Southeast Asian
    "th":    ["/System/Library/Fonts/Supplemental/Thonburi.ttc"],
    "my":    ["/System/Library/Fonts/NotoSansMyMyanmar.ttc"],
    # Other
    "am":    ["/System/Library/Fonts/Supplemental/KefaIII.ttf"],
    "hy":    ["/System/Library/Fonts/NotoSansArmenian.ttc"],
}

FONT_FALLBACK = [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",  # macOS universal
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]

HELVETICA_PATHS = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]

FONT_SIZE = 140
SHADOW_OFFSET = 4
SHADOW_COLOR = (0, 0, 0, 180)
TEXT_COLOR = (255, 255, 255, 255)


def load_font(lang_code: str, size: int) -> ImageFont.FreeTypeFont:
    candidates = FONT_MAP.get(lang_code, HELVETICA_PATHS) + FONT_FALLBACK
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    raise RuntimeError(f"No font found for {lang_code}")


def render_screenshot(base_img: Image.Image, text: str, font: ImageFont.FreeTypeFont) -> Image.Image:
    img = base_img.copy().convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (img.width - w) / 2 - bbox[0]
    y = (img.height - h) / 2 - bbox[1]

    # Shadow
    draw.text((x + SHADOW_OFFSET, y + SHADOW_OFFSET), text, font=font, fill=SHADOW_COLOR)
    # Main text
    draw.text((x, y), text, font=font, fill=TEXT_COLOR)

    result = Image.alpha_composite(img, overlay)
    return result.convert("RGB")


def main():
    base_img = Image.open(BASE_IMAGE)

    with open(CSV_PATH, encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        next(reader)  # skip header
        rows = list(reader)

    for row in rows:
        lang_code = row[0].strip()
        phrases_raw = row[3]
        phrases = [p.strip() for p in phrases_raw.replace("،", ",").split(",")][:4]

        if len(phrases) < 4:
            print(f"WARNING: {lang_code} has only {len(phrases)} phrases, skipping")
            continue

        font = load_font(lang_code, FONT_SIZE)
        out_dir = OUTPUT_DIR / lang_code
        out_dir.mkdir(parents=True, exist_ok=True)

        for n, phrase in enumerate(phrases, start=1):
            img = render_screenshot(base_img, phrase, font)
            out_path = out_dir / f"{n}.png"
            img.save(out_path, "PNG")
            print(f"{lang_code} {n}/4")

    print(f"\nDone. Generated {len(rows) * 4} images.")


if __name__ == "__main__":
    main()
