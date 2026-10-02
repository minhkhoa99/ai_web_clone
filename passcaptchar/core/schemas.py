from pydantic import BaseModel, Field, model_validator
from typing import Optional, Literal, Dict, Any, List

class SolveRequest(BaseModel):
    image: Optional[str] = Field(default=None, description="Base64 encoded image")
    image_url: Optional[str] = Field(default=None, description="URL of the image")
    audio: Optional[str] = Field(default=None, description="Base64 encoded audio")
    captcha_type: Literal["text", "grid", "slider", "audio", "browser", "auto"] = "auto"
    options: Dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def check_inputs(self) -> 'SolveRequest':
        if not self.image and not self.image_url and not self.audio:
            raise ValueError("At least one of image, image_url, or audio must be provided.")
        return self

class SolveResponse(BaseModel):
    success: bool
    answer: str | List[Any]
    captcha_type: str
    confidence: float
    solve_time_ms: int

class HealthResponse(BaseModel):
    status: str
    loaded_models: List[str]
    supported_types: List[str]
