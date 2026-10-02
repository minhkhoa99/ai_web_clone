"""
Auto-detect CAPTCHA type from input data.
Analyzes image properties, aspect ratio, grid patterns to classify.
"""

import numpy as np
import cv2

from utils.logger import get_logger

logger = get_logger(__name__)


def classify_captcha(
    image: np.ndarray | None = None,
    has_audio: bool = False,
    options: dict | None = None,
) -> str:
    """Classify captcha type from input data.

    Returns one of: 'text', 'grid', 'slider', 'audio', 'browser'
    """
    options = options or {}

    # explicit type in options
    if options.get("captcha_provider"):
        return "browser"

    # audio input → audio solver
    if has_audio:
        return "audio"

    if image is None:
        # no image, check if URL-based (browser solver)
        if options.get("url") and options.get("sitekey"):
            return "browser"
        return "text"  # fallback

    h, w = image.shape[:2]
    aspect = w / h if h > 0 else 1.0

    # check for grid pattern (reCAPTCHA v2 style)
    if _is_grid_image(image):
        return "grid"

    # check for slider/puzzle pattern
    if options.get("puzzle_piece"):
        return "slider"

    if _is_slider_image(image, aspect):
        return "slider"

    # default: text captcha (most common simple captchas)
    return "text"


def _is_grid_image(image: np.ndarray) -> bool:
    """Detect if image is a grid of tiles (3x3 or 4x4)."""
    h, w = image.shape[:2]

    # grid images are usually square-ish
    aspect = w / h
    if aspect < 0.8 or aspect > 1.3:
        return False

    # look for grid lines using edge detection
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image

    # detect horizontal and vertical lines
    edges = cv2.Canny(gray, 50, 150)

    # check for strong horizontal lines at 1/3 and 2/3 positions
    h_third = h // 3
    h_lines_found = 0
    for y_pos in [h_third, 2 * h_third]:
        row_region = edges[max(0, y_pos - 3):min(h, y_pos + 3), :]
        if np.mean(row_region) > 30:
            h_lines_found += 1

    # check for strong vertical lines at 1/3 and 2/3 positions
    w_third = w // 3
    v_lines_found = 0
    for x_pos in [w_third, 2 * w_third]:
        col_region = edges[:, max(0, x_pos - 3):min(w, x_pos + 3)]
        if np.mean(col_region) > 30:
            v_lines_found += 1

    if h_lines_found >= 1 and v_lines_found >= 1:
        return True

    # also check if image is large enough to be a grid (typically 300x300+)
    if w >= 280 and h >= 280 and 0.9 <= aspect <= 1.1:
        # likely a grid even without clear lines
        return True

    return False


def _is_slider_image(image: np.ndarray, aspect: float) -> bool:
    """Detect if image is a slider/puzzle captcha background."""
    h, w = image.shape[:2]

    # slider backgrounds are typically wide (aspect > 1.5)
    if aspect < 1.3:
        return False

    # look for a gap/hole in the image — region with distinct edges
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
    edges = cv2.Canny(gray, 100, 200)

    # find contours — a puzzle gap creates a distinct contour
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    for contour in contours:
        area = cv2.contourArea(contour)
        x, y, cw, ch = cv2.boundingRect(contour)

        # gap is typically 40-80px square, somewhere in the right half
        if 30 <= cw <= 100 and 30 <= ch <= 100:
            gap_aspect = cw / ch if ch > 0 else 0
            if 0.7 <= gap_aspect <= 1.4 and x > w * 0.2:
                return True

    return False
