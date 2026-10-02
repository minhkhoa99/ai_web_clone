"""
Slider/Puzzle CAPTCHA solver using OpenCV template matching.
No ML model needed — pure computer vision.
Finds the x-offset where the puzzle piece fits into the background gap.
"""

import asyncio
from typing import Optional

import cv2
import numpy as np

from solvers.base import BaseSolver, SolveResult
from utils.logger import get_logger

logger = get_logger(__name__)


class SliderSolver(BaseSolver):
    """Solves slider/puzzle CAPTCHAs by finding the gap position via template matching."""

    _name = "slider"

    @property
    def name(self) -> str:
        return self._name

    def load_model(self) -> None:
        if self._loaded:
            return
        # no model to load — OpenCV is always available
        logger.info("Slider solver ready (OpenCV template matching)")
        self._loaded = True

    async def solve(
        self,
        image: Optional[np.ndarray] = None,
        audio_path: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> SolveResult:
        if image is None:
            return SolveResult(answer="", confidence=0.0, metadata={"error": "no background image"})

        self._ensure_loaded()
        options = options or {}

        try:
            result = await asyncio.to_thread(self._inference, image, options)
            return result
        except Exception as e:
            logger.error(f"Slider solver failed: {e}")
            return SolveResult(answer="", confidence=0.0, metadata={"error": str(e)})

    def _inference(self, background: np.ndarray, options: dict) -> SolveResult:
        from utils.image_utils import decode_base64_image

        # puzzle piece from options
        piece_b64 = options.get("puzzle_piece", "")
        if not piece_b64:
            return SolveResult(
                answer="", confidence=0.0,
                metadata={"error": "options['puzzle_piece'] (base64) is required"}
            )

        piece = decode_base64_image(piece_b64)

        # try multiple strategies, pick best confidence
        strategies = [
            ("canny_edge", self._match_canny),
            ("sobel_edge", self._match_sobel),
            ("direct", self._match_direct),
        ]

        best_result: Optional[SolveResult] = None

        for strategy_name, strategy_fn in strategies:
            try:
                result = strategy_fn(background, piece)
                logger.debug(f"Strategy '{strategy_name}': offset={result.answer}, conf={result.confidence:.3f}")
                if best_result is None or result.confidence > best_result.confidence:
                    best_result = result
                    best_result.metadata["strategy"] = strategy_name
            except Exception as e:
                logger.debug(f"Strategy '{strategy_name}' failed: {e}")

        if best_result is None or best_result.confidence < 0.3:
            return SolveResult(answer="", confidence=0.0, metadata={"error": "no match found"})

        logger.info(
            f"Slider solved: x_offset={best_result.answer} "
            f"(conf: {best_result.confidence:.2f}, strategy: {best_result.metadata.get('strategy')})"
        )
        return best_result

    def _match_canny(self, bg: np.ndarray, piece: np.ndarray) -> SolveResult:
        bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY) if len(bg.shape) == 3 else bg
        piece_gray = cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY) if len(piece.shape) == 3 else piece

        bg_edges = cv2.Canny(bg_gray, 100, 200)
        piece_edges = cv2.Canny(piece_gray, 100, 200)

        return self._template_match(bg_edges, piece_edges)

    def _match_sobel(self, bg: np.ndarray, piece: np.ndarray) -> SolveResult:
        bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY) if len(bg.shape) == 3 else bg
        piece_gray = cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY) if len(piece.shape) == 3 else piece

        bg_sobel = cv2.Sobel(bg_gray, cv2.CV_64F, 1, 0, ksize=3)
        piece_sobel = cv2.Sobel(piece_gray, cv2.CV_64F, 1, 0, ksize=3)

        bg_sobel = np.uint8(np.absolute(bg_sobel))
        piece_sobel = np.uint8(np.absolute(piece_sobel))

        return self._template_match(bg_sobel, piece_sobel)

    def _match_direct(self, bg: np.ndarray, piece: np.ndarray) -> SolveResult:
        bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY) if len(bg.shape) == 3 else bg
        piece_gray = cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY) if len(piece.shape) == 3 else piece

        return self._template_match(bg_gray, piece_gray)

    def _template_match(self, source: np.ndarray, template: np.ndarray) -> SolveResult:
        # ensure template fits inside source
        if template.shape[0] > source.shape[0] or template.shape[1] > source.shape[1]:
            # resize template to fit
            scale = min(
                source.shape[0] / template.shape[0],
                source.shape[1] / template.shape[1],
            ) * 0.9
            template = cv2.resize(
                template,
                (int(template.shape[1] * scale), int(template.shape[0] * scale)),
            )

        result = cv2.matchTemplate(source, template, cv2.TM_CCOEFF_NORMED)
        min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(result)

        x_offset = max_loc[0]
        confidence = float(max_val)

        return SolveResult(
            answer=str(x_offset),
            confidence=confidence,
            metadata={"x": x_offset, "y": max_loc[1]},
        )
