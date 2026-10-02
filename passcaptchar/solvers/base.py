from abc import ABC, abstractmethod
from typing import Optional, Dict, Any, Union, List
from dataclasses import dataclass, field
import numpy as np

@dataclass
class SolveResult:
    answer: Union[str, List[Any]]
    confidence: float
    metadata: Dict[str, Any] = field(default_factory=dict)

class BaseSolver(ABC):
    def __init__(self):
        self._loaded: bool = False

    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @abstractmethod
    def load_model(self) -> None:
        pass

    def _ensure_loaded(self) -> None:
        if not self._loaded:
            self.load_model()

    @abstractmethod
    async def solve(
        self,
        image: Optional[np.ndarray],
        audio_path: Optional[str],
        options: Dict[str, Any]
    ) -> SolveResult:
        pass
