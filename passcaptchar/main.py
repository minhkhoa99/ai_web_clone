"""
PassCaptcha — AI-Powered Local CAPTCHA Solver
FastAPI server + CLI entrypoint.

Usage:
    CLI:    python main.py solve --type text --image captcha.png
    Server: python main.py server --port 8000
"""

import time
import asyncio
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

import typer
import uvicorn
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from rich.console import Console

from config import get_settings
from core.schemas import SolveRequest, SolveResponse, HealthResponse
from core.registry import SolverRegistry, solver_registry
from core.classifier import classify_captcha
from utils.logger import get_logger

logger = get_logger(__name__)
console = Console()

# ─── Register all solvers ───
def _register_solvers():
    from solvers.text_solver import TextSolver
    from solvers.grid_solver import GridSolver
    from solvers.slider_solver import SliderSolver
    from solvers.audio_solver import AudioSolver
    from solvers.browser_solver import BrowserSolver

    solver_registry.register("text", TextSolver())
    solver_registry.register("grid", GridSolver())
    solver_registry.register("slider", SliderSolver())
    solver_registry.register("audio", AudioSolver())
    solver_registry.register("browser", BrowserSolver())


# ─── FastAPI app ───
@asynccontextmanager
async def lifespan(app: FastAPI):
    _register_solvers()
    logger.info(f"PassCaptcha started. Registered solvers: {solver_registry.list_all()}")
    yield
    # cleanup browser solver if loaded
    browser = solver_registry._solvers.get("browser")
    if browser and hasattr(browser, "cleanup"):
        await browser.cleanup()
    logger.info("PassCaptcha stopped")


app = FastAPI(
    title="PassCaptcha",
    description="AI-Powered Local CAPTCHA Solver",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _resolve_image(request: SolveRequest):
    """Resolve image from base64 or URL."""
    from utils.image_utils import decode_base64_image, download_image

    if request.image:
        return decode_base64_image(request.image)
    elif request.image_url:
        return await asyncio.to_thread(download_image, request.image_url)
    return None


@app.post("/solve", response_model=SolveResponse)
async def solve_captcha(request: SolveRequest):
    """Solve a CAPTCHA. Auto-detects type if not specified."""
    start = time.perf_counter()

    image = await _resolve_image(request)
    has_audio = request.audio is not None

    # determine captcha type
    if request.captcha_type == "auto":
        captcha_type = classify_captcha(
            image=image, has_audio=has_audio, options=request.options
        )
        logger.info(f"Auto-detected captcha type: {captcha_type}")
    else:
        captcha_type = request.captcha_type

    # get solver
    try:
        solver = solver_registry.get(captcha_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Unknown captcha type: {captcha_type}")

    # solve
    audio_path = None
    if has_audio:
        request.options["audio"] = request.audio

    result = await solver.solve(image=image, audio_path=audio_path, options=request.options)

    elapsed_ms = int((time.perf_counter() - start) * 1000)

    return SolveResponse(
        success=result.confidence > 0,
        answer=result.answer,
        captcha_type=captcha_type,
        confidence=round(result.confidence, 4),
        solve_time_ms=elapsed_ms,
    )


@app.post("/solve/{captcha_type}", response_model=SolveResponse)
async def solve_captcha_typed(captcha_type: str, request: SolveRequest):
    """Solve a CAPTCHA with explicit type."""
    request.captcha_type = captcha_type
    return await solve_captcha(request)


@app.post("/solve/upload", response_model=SolveResponse)
async def solve_captcha_upload(
    file: UploadFile = File(...),
    captcha_type: str = "auto",
    target: Optional[str] = None,
):
    """Solve a CAPTCHA from uploaded file."""
    import cv2
    import numpy as np

    content = await file.read()
    nparr = np.frombuffer(content, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Could not decode uploaded image")

    options = {}
    if target:
        options["target"] = target

    request = SolveRequest(
        image=None,  # we already have the decoded image
        captcha_type=captcha_type,
        options=options,
    )

    start = time.perf_counter()

    if captcha_type == "auto":
        detected = classify_captcha(image=image, options=options)
    else:
        detected = captcha_type

    try:
        solver = solver_registry.get(detected)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Unknown captcha type: {detected}")

    result = await solver.solve(image=image, options=options)
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    return SolveResponse(
        success=result.confidence > 0,
        answer=result.answer,
        captcha_type=detected,
        confidence=round(result.confidence, 4),
        solve_time_ms=elapsed_ms,
    )


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok",
        loaded_models=solver_registry.list_loaded(),
        supported_types=solver_registry.list_all(),
    )


@app.get("/supported")
async def supported():
    return {"types": solver_registry.list_all()}


# ─── CLI ───
cli = typer.Typer(name="passcaptcha", help="AI-Powered Local CAPTCHA Solver")


@cli.command()
def server(
    host: str = typer.Option("0.0.0.0", help="Server host"),
    port: int = typer.Option(8000, help="Server port"),
    reload: bool = typer.Option(False, help="Auto-reload on changes"),
):
    """Start the PassCaptcha API server."""
    console.print("[bold green]>>> Starting PassCaptcha Server[/bold green]")
    console.print(f"   Host: {host}")
    console.print(f"   Port: {port}")
    console.print(f"   Docs: http://{host}:{port}/docs")
    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info",
    )


@cli.command()
def solve(
    image: Optional[str] = typer.Option(None, "--image", "-i", help="Path to captcha image"),
    image_url: Optional[str] = typer.Option(None, "--url", "-u", help="URL of captcha image"),
    audio: Optional[str] = typer.Option(None, "--audio", "-a", help="Path to audio captcha"),
    captcha_type: str = typer.Option("auto", "--type", "-t", help="Captcha type: text, grid, slider, audio, browser, auto"),
    target: Optional[str] = typer.Option(None, "--target", help="Target label for grid captcha (e.g. 'traffic light')"),
    puzzle_piece: Optional[str] = typer.Option(None, "--puzzle-piece", "-p", help="Path to puzzle piece image (slider)"),
):
    """Solve a CAPTCHA from command line."""
    import cv2
    import base64

    _register_solvers()

    img = None
    options = {}

    if image:
        img = cv2.imread(image, cv2.IMREAD_COLOR)
        if img is None:
            console.print(f"[red]Error: Could not read image: {image}[/red]")
            raise typer.Exit(1)

    if image_url:
        from utils.image_utils import download_image
        img = download_image(image_url)

    if target:
        options["target"] = target

    if puzzle_piece:
        piece_img = open(puzzle_piece, "rb").read()
        options["puzzle_piece"] = base64.b64encode(piece_img).decode()

    has_audio = audio is not None
    audio_path = audio

    # detect type
    if captcha_type == "auto":
        captcha_type = classify_captcha(image=img, has_audio=has_audio, options=options)
        console.print(f"[cyan]Auto-detected type:[/cyan] {captcha_type}")

    console.print(f"[cyan]Solving as:[/cyan] {captcha_type}")

    start = time.perf_counter()
    solver = solver_registry.get(captcha_type)
    result = asyncio.run(solver.solve(image=img, audio_path=audio_path, options=options))
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    if result.confidence > 0:
        console.print(f"[bold green][OK] Answer:[/bold green] {result.answer}")
        console.print(f"  Confidence: {result.confidence:.2%}")
        console.print(f"  Time: {elapsed_ms}ms")
        if result.metadata:
            for k, v in result.metadata.items():
                console.print(f"  {k}: {v}")
    else:
        console.print(f"[bold red][FAIL] Failed to solve[/bold red]")
        if result.metadata.get("error"):
            console.print(f"  Error: {result.metadata['error']}")
        raise typer.Exit(1)


@cli.command(name="download-models")
def download_models():
    """Pre-download all models."""
    _register_solvers()
    console.print("[bold cyan]Downloading models...[/bold cyan]")

    for name in solver_registry.list_all():
        console.print(f"  Loading {name}...", end=" ")
        try:
            solver_registry.get(name)
            console.print("[green][OK][/green]")
        except Exception as e:
            console.print(f"[red][FAIL] {e}[/red]")

    console.print("[bold green]Done![/bold green]")


@cli.command()
def info():
    """Show PassCaptcha info and supported types."""
    console.print("[bold cyan]PassCaptcha - AI-Powered Local CAPTCHA Solver[/bold cyan]")
    console.print()
    console.print("[bold]Supported CAPTCHA Types:[/bold]")
    console.print("  text     - Distorted text/image CAPTCHAs (TrOCR)")
    console.print("  grid     - Image grid CAPTCHAs like reCAPTCHA v2 (YOLOv8)")
    console.print("  slider   - Slider/puzzle CAPTCHAs (OpenCV)")
    console.print("  audio    - Audio CAPTCHAs (Whisper)")
    console.print("  browser  - Token-based: hCaptcha, Turnstile, reCAPTCHA v3 (Playwright)")
    console.print()
    console.print("[bold]Usage:[/bold]")
    console.print("  python main.py solve --image captcha.png --type text")
    console.print("  python main.py solve --image grid.png --type grid --target 'traffic light'")
    console.print("  python main.py solve --image slider_bg.png --type slider --puzzle-piece piece.png")
    console.print("  python main.py solve --audio captcha.wav --type audio")
    console.print("  python main.py server --port 8000")


if __name__ == "__main__":
    cli()
