"""
Audio CAPTCHA solver using faster-whisper (CTranslate2 backend).
Model: whisper-base (~150MB, auto-downloads).
Transcribes audio captcha, extracts digits/words.
"""

import asyncio
import tempfile
import os
import re
import base64
from typing import Optional

import numpy as np

from solvers.base import BaseSolver, SolveResult
from config import get_settings
from utils.logger import get_logger

logger = get_logger(__name__)

# spoken digit -> text digit mapping
WORD_TO_DIGIT: dict[str, str] = {
    "zero": "0", "one": "1", "two": "2", "three": "3",
    "four": "4", "five": "5", "six": "6", "seven": "7",
    "eight": "8", "nine": "9",
    "oh": "0", "o": "0",
}


class AudioSolver(BaseSolver):
    """Solves audio CAPTCHAs by transcribing speech to text."""

    _name = "audio"
    _model = None

    @property
    def name(self) -> str:
        return self._name

    def load_model(self) -> None:
        if self._loaded:
            return

        from faster_whisper import WhisperModel

        settings = get_settings()
        model_size = settings.WHISPER_MODEL
        cache_dir = str(settings.MODEL_DIR / "whisper")

        logger.info(f"Loading Whisper model: {model_size} (CPU, int8)")
        self._model = WhisperModel(
            model_size,
            device="cpu",
            compute_type="int8",
            download_root=cache_dir,
        )
        logger.info("Whisper model loaded")
        self._loaded = True

    async def solve(
        self,
        image: Optional[np.ndarray] = None,
        audio_path: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> SolveResult:
        self._ensure_loaded()
        options = options or {}

        # get audio data — either from path or base64 in options
        audio_file = audio_path
        temp_file = None

        try:
            if not audio_file:
                audio_b64 = options.get("audio", "")
                if not audio_b64:
                    return SolveResult(
                        answer="", confidence=0.0,
                        metadata={"error": "no audio provided (audio_path or options['audio'] base64)"}
                    )
                # decode base64 to temp file
                temp_file = self._decode_audio_to_file(audio_b64)
                audio_file = temp_file

            result = await asyncio.to_thread(self._inference, audio_file, options)
            return result

        except Exception as e:
            logger.error(f"Audio solver failed: {e}")
            return SolveResult(answer="", confidence=0.0, metadata={"error": str(e)})
        finally:
            if temp_file and os.path.exists(temp_file):
                os.unlink(temp_file)

    def _decode_audio_to_file(self, audio_b64: str) -> str:
        """Decode base64 audio to a temporary WAV file."""
        audio_bytes = base64.b64decode(audio_b64)
        suffix = ".wav"

        # detect format from magic bytes
        if audio_bytes[:3] == b"ID3" or audio_bytes[:2] == b"\xff\xfb":
            suffix = ".mp3"
        elif audio_bytes[:4] == b"OggS":
            suffix = ".ogg"

        fd, path = tempfile.mkstemp(suffix=suffix)
        os.write(fd, audio_bytes)
        os.close(fd)

        # convert to WAV if not already
        if suffix != ".wav":
            path = self._convert_to_wav(path)

        return path

    def _convert_to_wav(self, source_path: str) -> str:
        """Convert audio file to WAV using pydub."""
        from pydub import AudioSegment

        audio = AudioSegment.from_file(source_path)
        wav_path = source_path.rsplit(".", 1)[0] + ".wav"
        audio.export(wav_path, format="wav")

        # clean up original
        if os.path.exists(source_path) and source_path != wav_path:
            os.unlink(source_path)

        return wav_path

    def _inference(self, audio_path: str, options: dict) -> SolveResult:
        language = options.get("language", "en")

        segments, info = self._model.transcribe(
            audio_path,
            language=language,
            beam_size=5,
            word_timestamps=False,
        )

        # collect all text from segments
        raw_texts = []
        for segment in segments:
            raw_texts.append(segment.text.strip())

        raw_transcript = " ".join(raw_texts).strip()
        logger.debug(f"Raw transcript: '{raw_transcript}'")

        # post-process
        cleaned = self._post_process(raw_transcript, options)
        confidence = min(1.0, info.language_probability) if info.language_probability else 0.7

        logger.info(f"Audio solved: '{cleaned}' (raw: '{raw_transcript}', conf: {confidence:.2f})")
        return SolveResult(
            answer=cleaned,
            confidence=confidence,
            metadata={
                "raw_transcript": raw_transcript,
                "language": info.language,
                "duration": info.duration,
            },
        )

    def _post_process(self, transcript: str, options: dict) -> str:
        """Extract answer from transcript based on captcha type."""
        mode = options.get("mode", "digits")

        if mode == "digits":
            return self._extract_digits(transcript)
        elif mode == "words":
            return self._extract_words(transcript)
        else:
            return transcript.strip().lower()

    def _extract_digits(self, transcript: str) -> str:
        """Extract numeric digits from transcript, converting spoken words to digits."""
        text = transcript.lower()

        # replace spoken digits with numeric
        for word, digit in WORD_TO_DIGIT.items():
            text = re.sub(rf"\b{word}\b", digit, text)

        # extract only digits
        digits = re.findall(r"\d", text)
        return "".join(digits)

    def _extract_words(self, transcript: str) -> str:
        """Clean up transcript for word-based captchas."""
        text = transcript.lower().strip()
        # remove common filler
        filler = ["um", "uh", "like", "please", "type", "enter", "the"]
        words = text.split()
        words = [w for w in words if w not in filler]
        return " ".join(words)
