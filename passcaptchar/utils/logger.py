import logging
from rich.logging import RichHandler
from config import get_settings

def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        settings = get_settings()
        logger.setLevel(getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO))
        handler = RichHandler(rich_tracebacks=True, markup=True)
        formatter = logging.Formatter("%(message)s", datefmt="[%X]")
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        logger.propagate = False
    return logger
