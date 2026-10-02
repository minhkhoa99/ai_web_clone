"""
Image grid CAPTCHA solver (reCAPTCHA v2 style) using YOLOv8.
Model: yolov8n.pt (nano, COCO pre-trained, auto-downloads).
Splits grid into tiles, runs detection per tile, returns matching indices.
"""

import asyncio
from typing import Optional

import numpy as np

from solvers.base import BaseSolver, SolveResult
from config import get_settings
from utils.logger import get_logger

logger = get_logger(__name__)

# reCAPTCHA label -> COCO class IDs
# COCO classes: https://docs.ultralytics.com/datasets/detect/coco/
RECAPTCHA_LABELS: dict[str, list[int]] = {
    "traffic light": [9],
    "traffic lights": [9],
    "fire hydrant": [10],
    "fire hydrants": [10],
    "stop sign": [11],
    "stop signs": [11],
    "parking meter": [12],
    "parking meters": [12],
    "bus": [5],
    "buses": [5],
    "bicycle": [1, 3],
    "bicycles": [1, 3],
    "car": [2],
    "cars": [2],
    "motorcycle": [3, 1],
    "motorcycles": [3, 1],
    "boat": [8],
    "boats": [8],
    "airplane": [4],
    "airplanes": [4],
    "truck": [7],
    "trucks": [7],
    "train": [6],
    "trains": [6],
    # not directly in COCO — handled by proxy detection
    "crosswalk": [],
    "crosswalks": [],
    "stairs": [],
    "chimney": [],
    "bridge": [],
    "palm tree": [],
    "mountain": [],
    "taxi": [2],  # cars with yellow color, fallback to car class
    "taxis": [2],
}


class GridSolver(BaseSolver):
    """Solves image grid CAPTCHAs by detecting objects in each tile."""

    _name = "grid"
    _model = None

    @property
    def name(self) -> str:
        return self._name

    def load_model(self) -> None:
        if self._loaded:
            return

        from ultralytics import YOLO

        settings = get_settings()
        model_path = settings.YOLO_MODEL

        logger.info(f"Loading YOLO model: {model_path}")
        self._model = YOLO(model_path)
        self._model.to("cpu")
        logger.info("YOLO model loaded")
        self._loaded = True

    async def solve(
        self,
        image: Optional[np.ndarray] = None,
        audio_path: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> SolveResult:
        if image is None:
            return SolveResult(answer=[], confidence=0.0, metadata={"error": "no image"})

        self._ensure_loaded()
        options = options or {}

        try:
            result = await asyncio.to_thread(self._inference, image, options)
            return result
        except Exception as e:
            logger.error(f"Grid solver failed: {e}")
            return SolveResult(answer=[], confidence=0.0, metadata={"error": str(e)})

    def _inference(self, image: np.ndarray, options: dict) -> SolveResult:
        from utils.image_utils import split_grid

        raw_target = options.get("target", "").lower().strip()
        rows = options.get("rows", 3)
        cols = options.get("cols", 3)

        if not raw_target:
            return SolveResult(
                answer=[], confidence=0.0,
                metadata={"error": "no target label specified in options['target']"}
            )

        # resolve COCO class IDs for target
        target_classes = self._resolve_target(raw_target)

        # split grid into tiles
        tiles = split_grid(image, rows=rows, cols=cols)
        logger.info(f"Split grid into {len(tiles)} tiles, target: '{raw_target}' -> classes {target_classes}")

        matching_indices = []
        confidences = []

        # Tile detection threshold (lower threshold for cropped small tiles)
        confidence_thresh = options.get("confidence_threshold", 0.25)

        # Method 1: Detect on full image and map box centers to tile indices
        full_results = self._model(image, verbose=False, conf=options.get("confidence_threshold", 0.15))
        h, w = image.shape[:2]
        cell_h, cell_w = h / rows, w / cols

        for r in full_results:
            if r.boxes is not None:
                for box in r.boxes:
                    cls_id = int(box.cls[0].item())
                    conf = float(box.conf[0].item())
                    if cls_id in target_classes:
                        # Find center of bounding box
                        xyxy = box.xyxy[0].cpu().numpy()
                        cx = (xyxy[0] + xyxy[2]) / 2.0
                        cy = (xyxy[1] + xyxy[3]) / 2.0
                        
                        col_idx = int(min(cols - 1, max(0, cx // cell_w)))
                        row_idx = int(min(rows - 1, max(0, cy // cell_h)))
                        tile_idx = row_idx * cols + col_idx
                        
                        if tile_idx not in matching_indices:
                            matching_indices.append(tile_idx)
                            confidences.append(conf)

        # Method 2: Detect per individual tile slice (for fine-grained objects)
        for idx, tile in enumerate(tiles):
            if idx in matching_indices:
                continue
            results = self._model(tile, verbose=False, conf=options.get("confidence_threshold", 0.15))
            for r in results:
                if r.boxes is None or len(r.boxes) == 0:
                    continue
                for box in r.boxes:
                    cls_id = int(box.cls[0].item())
                    conf = float(box.conf[0].item())
                    if cls_id in target_classes:
                        matching_indices.append(idx)
                        confidences.append(conf)
                        break

        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

        logger.info(f"Grid result: tiles {matching_indices} match '{raw_target}' (avg conf: {avg_confidence:.2f})")
        return SolveResult(
            answer=matching_indices,
            confidence=avg_confidence,
            metadata={
                "target": raw_target,
                "grid_size": f"{rows}x{cols}",
                "total_tiles": rows * cols,
            },
        )

    def _resolve_target(self, label: str) -> list[int]:
        """Map a reCAPTCHA text label to COCO class IDs."""
        label_clean = label.replace("\n", " ").lower()
        
        # Direct & Fuzzy lookup against RECAPTCHA_LABELS
        for key, classes in RECAPTCHA_LABELS.items():
            if key in label_clean:
                if classes:
                    return classes

        logger.warning(f"Unknown target label: '{label}', falling back to vehicle/common classes")
        # Default fallback to common reCAPTCHA objects: bicycle, car, motorcycle, bus, truck
        return [1, 2, 3, 5, 7, 9, 10, 11]
