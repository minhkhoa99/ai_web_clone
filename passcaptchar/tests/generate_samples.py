"""
Generate sample captcha images for testing PassCaptcha solvers.
Creates synthetic test data for: text, slider, grid.
"""

import cv2
import numpy as np
import random
import string
import os
from pathlib import Path

OUTPUT_DIR = Path("tests/sample_captchas")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def generate_text_captcha(text: str = None, width: int = 200, height: int = 80) -> tuple[np.ndarray, str]:
    """Generate a distorted text captcha image."""
    if text is None:
        text = "".join(random.choices(string.ascii_lowercase + string.digits, k=5))

    img = np.ones((height, width, 3), dtype=np.uint8) * 255

    # random background noise
    for _ in range(500):
        x = random.randint(0, width - 1)
        y = random.randint(0, height - 1)
        color = tuple(random.randint(150, 230) for _ in range(3))
        cv2.circle(img, (x, y), random.randint(1, 3), color, -1)

    # random lines
    for _ in range(5):
        x1, y1 = random.randint(0, width), random.randint(0, height)
        x2, y2 = random.randint(0, width), random.randint(0, height)
        color = tuple(random.randint(100, 200) for _ in range(3))
        cv2.line(img, (x1, y1), (x2, y2), color, 1)

    # draw text characters with slight rotation
    char_width = width // (len(text) + 2)
    for i, char in enumerate(text):
        x = 20 + i * char_width
        y = random.randint(40, 60)
        font_scale = random.uniform(1.0, 1.5)
        thickness = random.randint(2, 3)
        color = tuple(random.randint(0, 100) for _ in range(3))
        cv2.putText(img, char, (x, y), cv2.FONT_HERSHEY_SIMPLEX, font_scale, color, thickness)

    # warp distortion
    rows, cols = img.shape[:2]
    src_pts = np.float32([[0, 0], [cols, 0], [0, rows], [cols, rows]])
    dst_pts = src_pts + np.float32([
        [random.randint(-5, 5), random.randint(-5, 5)],
        [random.randint(-5, 5), random.randint(-5, 5)],
        [random.randint(-5, 5), random.randint(-5, 5)],
        [random.randint(-5, 5), random.randint(-5, 5)],
    ])
    matrix = cv2.getPerspectiveTransform(src_pts, dst_pts)
    img = cv2.warpPerspective(img, matrix, (cols, rows), borderValue=(255, 255, 255))

    return img, text


def generate_slider_captcha(width: int = 400, height: int = 200) -> tuple[np.ndarray, np.ndarray, int]:
    """Generate a slider captcha: background with gap + puzzle piece."""
    # create colorful background
    bg = np.zeros((height, width, 3), dtype=np.uint8)
    for y in range(height):
        for x in range(width):
            bg[y, x] = [
                int(100 + 50 * np.sin(x / 30)),
                int(150 + 50 * np.sin(y / 20)),
                int(100 + 50 * np.cos((x + y) / 40)),
            ]

    # add some shapes for texture
    for _ in range(10):
        cx, cy = random.randint(20, width - 20), random.randint(20, height - 20)
        r = random.randint(10, 30)
        color = tuple(random.randint(50, 200) for _ in range(3))
        cv2.circle(bg, (cx, cy), r, color, -1)

    # cut a puzzle piece (square gap)
    piece_size = 50
    gap_x = random.randint(width // 3, width - piece_size - 20)
    gap_y = random.randint(20, height - piece_size - 20)

    # extract puzzle piece
    piece = bg[gap_y:gap_y + piece_size, gap_x:gap_x + piece_size].copy()

    # create gap in background (darken area)
    bg_with_gap = bg.copy()
    bg_with_gap[gap_y:gap_y + piece_size, gap_x:gap_x + piece_size] = (
        bg_with_gap[gap_y:gap_y + piece_size, gap_x:gap_x + piece_size] * 0.3
    ).astype(np.uint8)

    # draw gap border
    cv2.rectangle(bg_with_gap, (gap_x, gap_y), (gap_x + piece_size, gap_y + piece_size), (50, 50, 50), 2)

    return bg_with_gap, piece, gap_x


def generate_grid_captcha(rows: int = 3, cols: int = 3, cell_size: int = 100) -> tuple[np.ndarray, str]:
    """Generate a fake grid captcha image (colored squares)."""
    width = cols * cell_size
    height = rows * cell_size
    img = np.zeros((height, width, 3), dtype=np.uint8)

    for r in range(rows):
        for c in range(cols):
            color = tuple(random.randint(30, 220) for _ in range(3))
            y1, y2 = r * cell_size, (r + 1) * cell_size
            x1, x2 = c * cell_size, (c + 1) * cell_size
            img[y1:y2, x1:x2] = color
            # grid lines
            cv2.rectangle(img, (x1, y1), (x2, y2), (200, 200, 200), 2)

    return img, f"{rows}x{cols} grid"


if __name__ == "__main__":
    print("Generating test captcha images...")

    # text captchas
    for i in range(3):
        img, text = generate_text_captcha()
        path = OUTPUT_DIR / f"text_{i}_{text}.png"
        cv2.imwrite(str(path), img)
        print(f"  Text captcha: {path} (answer: {text})")

    # slider captcha
    bg, piece, x_offset = generate_slider_captcha()
    cv2.imwrite(str(OUTPUT_DIR / "slider_bg.png"), bg)
    cv2.imwrite(str(OUTPUT_DIR / "slider_piece.png"), piece)
    print(f"  Slider captcha: slider_bg.png + slider_piece.png (answer: x={x_offset})")

    # grid captcha
    grid, desc = generate_grid_captcha()
    cv2.imwrite(str(OUTPUT_DIR / "grid_3x3.png"), grid)
    print(f"  Grid captcha: grid_3x3.png ({desc})")

    print("\nDone! Files saved to tests/sample_captchas/")
