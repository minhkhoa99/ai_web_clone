from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    MODEL_DIR: Path = Path("models")
    DEVICE: str = "cpu"
    TEXT_MODEL_ID: str = "anuashok/ocr-captcha-v3"
    TEXT_BACKUP_MODEL_ID: str = "Graf-J/captcha-crnn-base"
    YOLO_MODEL: str = "yolov8n.pt"
    WHISPER_MODEL: str = "base"
    CONFIDENCE_THRESHOLD: float = 0.5
    SERVER_HOST: str = "0.0.0.0"
    SERVER_PORT: int = 8000
    LOG_LEVEL: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

_settings: Settings | None = None

def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
        _settings.MODEL_DIR.mkdir(parents=True, exist_ok=True)
    return _settings
