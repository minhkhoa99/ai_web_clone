"""
Text/Image CAPTCHA solver using TrOCR (Transformer-based OCR).
Model: anuashok/ocr-captcha-v3 from HuggingFace — fine-tuned for captcha text.
Backup: Graf-J/captcha-crnn-base (CRNN + CTC).
"""

import asyncio
from typing import Optional

import numpy as np
from PIL import Image

from solvers.base import BaseSolver, SolveResult
from config import get_settings
from utils.logger import get_logger

logger = get_logger(__name__)


class TextSolver(BaseSolver):
    """Solves distorted text CAPTCHAs using TrOCR vision-encoder-decoder."""

    _name = "text"
    _processor = None
    _model = None
    _backup_processor = None
    _backup_model = None

    @property
    def name(self) -> str:
        return self._name

    def load_model(self) -> None:
        if self._loaded:
            return

        from transformers import TrOCRProcessor, VisionEncoderDecoderModel

        settings = get_settings()
        model_id = settings.TEXT_MODEL_ID
        cache_dir = str(settings.MODEL_DIR / "trocr")

        logger.info(f"Loading TrOCR model: {model_id}")
        try:
            self._processor = TrOCRProcessor.from_pretrained(
                model_id, cache_dir=cache_dir
            )
            self._model = VisionEncoderDecoderModel.from_pretrained(
                model_id, cache_dir=cache_dir
            )
            self._model.eval()
            logger.info("TrOCR model loaded successfully")
        except Exception as e:
            logger.warning(f"Failed to load primary model: {e}. Trying backup.")
            self._load_backup(cache_dir)

        self._loaded = True

    def _load_backup(self, cache_dir: str) -> None:
        from transformers import AutoTokenizer, AutoModel

        settings = get_settings()
        backup_id = settings.TEXT_BACKUP_MODEL_ID
        logger.info(f"Loading backup model: {backup_id}")
        try:
            self._backup_processor = AutoTokenizer.from_pretrained(
                backup_id, cache_dir=cache_dir
            )
            self._backup_model = AutoModel.from_pretrained(
                backup_id, cache_dir=cache_dir
            )
            self._backup_model.eval()
            logger.info("Backup model loaded")
        except Exception as e:
            logger.error(f"Failed to load backup model: {e}")

    async def solve(
        self,
        image: Optional[np.ndarray] = None,
        audio_path: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> SolveResult:
        if image is None:
            return SolveResult(answer="", confidence=0.0, metadata={"error": "no image"})

        self._ensure_loaded()
        options = options or {}

        try:
            result = await asyncio.to_thread(self._inference, image, options)
            return result
        except Exception as e:
            logger.error(f"Text solver failed: {e}")
            return SolveResult(answer="", confidence=0.0, metadata={"error": str(e)})

    def _inference(self, image: np.ndarray, options: dict) -> SolveResult:
        import torch

        # convert to PIL RGB
        if len(image.shape) == 2:
            pil_image = Image.fromarray(image, mode="L").convert("RGB")
        elif image.shape[2] == 4:
            pil_image = Image.fromarray(image[:, :, :3])
        else:
            pil_image = Image.fromarray(image)

        if pil_image.mode != "RGB":
            pil_image = pil_image.convert("RGB")

        if self._processor is not None and self._model is not None:
            return self._trocr_inference(pil_image)
        elif self._backup_model is not None:
            return SolveResult(
                answer="", confidence=0.0,
                metadata={"error": "backup model inference not implemented for CRNN"}
            )
        else:
            return SolveResult(answer="", confidence=0.0, metadata={"error": "no model loaded"})

    def _trocr_inference(self, pil_image: Image.Image) -> SolveResult:
        import torch

        pixel_values = self._processor(
            images=pil_image, return_tensors="pt"
        ).pixel_values

        with torch.no_grad():
            outputs = self._model.generate(
                pixel_values,
                max_new_tokens=20,
                num_beams=4,
                early_stopping=True,
                return_dict_in_generate=True,
                output_scores=True,
            )

        generated_ids = outputs.sequences
        text = self._processor.batch_decode(generated_ids, skip_special_tokens=True)[0]

        # post-process
        text = text.strip().lower().replace(" ", "")

        # estimate confidence from sequence scores
        confidence = 0.85  # default estimate
        if hasattr(outputs, "sequences_scores") and outputs.sequences_scores is not None:
            score = outputs.sequences_scores[0].item()
            # convert log-prob to rough confidence
            confidence = min(1.0, max(0.0, 1.0 + score / 10.0))

        logger.info(f"Text solved: '{text}' (confidence: {confidence:.2f})")
        return SolveResult(answer=text, confidence=confidence)
