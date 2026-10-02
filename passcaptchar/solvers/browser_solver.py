"""
Browser-based CAPTCHA solver for hCaptcha, Turnstile, reCAPTCHA v3.
Uses Playwright headless Chromium with stealth settings.
Delegates image challenges to GridSolver when encountered.
"""

import asyncio
import random
from typing import Optional

import numpy as np

from solvers.base import BaseSolver, SolveResult
from config import get_settings
from utils.logger import get_logger

logger = get_logger(__name__)

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
]


class BrowserSolver(BaseSolver):
    """Solves token-based CAPTCHAs (hCaptcha, Turnstile, reCAPTCHA v3) using headless browser."""

    _name = "browser"
    _playwright = None
    _browser = None

    @property
    def name(self) -> str:
        return self._name

    def load_model(self) -> None:
        if self._loaded:
            return
        logger.info("Browser solver ready (Playwright)")
        self._loaded = True

    async def _ensure_browser(self):
        """Launch browser if not running."""
        if self._browser is not None and self._browser.is_connected():
            return

        from playwright.async_api import async_playwright

        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-infobars",
                "--window-size=1920,1080",
            ],
        )
        logger.info("Playwright browser launched")

    async def _create_stealth_context(self):
        """Create a browser context with anti-detection settings."""
        await self._ensure_browser()

        user_agent = random.choice(USER_AGENTS)
        context = await self._browser.new_context(
            user_agent=user_agent,
            viewport={"width": 1920, "height": 1080},
            locale="en-US",
            timezone_id="America/New_York",
            permissions=["geolocation"],
            geolocation={"latitude": 40.7128, "longitude": -74.0060},
        )

        # inject stealth scripts
        await context.add_init_script("""
            // override navigator.webdriver
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

            // override chrome runtime
            window.chrome = { runtime: {} };

            // override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : originalQuery(parameters);

            // override plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });

            // override languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
        """)

        return context

    async def solve(
        self,
        image: Optional[np.ndarray] = None,
        audio_path: Optional[str] = None,
        options: Optional[dict] = None,
    ) -> SolveResult:
        self._ensure_loaded()
        options = options or {}

        url = options.get("url", "")
        sitekey = options.get("sitekey", "")
        provider = options.get("captcha_provider", "").lower()

        if not url:
            return SolveResult(
                answer="", confidence=0.0,
                metadata={"error": "options['url'] is required"}
            )

        try:
            if provider == "turnstile":
                return await self._solve_turnstile(url, sitekey, options)
            elif provider in ("hcaptcha", "recaptcha_v2"):
                return await self._solve_interactive(url, sitekey, provider, options)
            elif provider == "recaptcha_v3":
                return await self._solve_recaptcha_v3(url, sitekey, options)
            else:
                # auto-detect
                return await self._solve_auto(url, sitekey, options)
        except Exception as e:
            logger.error(f"Browser solver failed: {e}")
            return SolveResult(answer="", confidence=0.0, metadata={"error": str(e)})

    async def _solve_turnstile(self, url: str, sitekey: str, options: dict) -> SolveResult:
        """Solve Cloudflare Turnstile — mostly behavioral, click checkbox."""
        context = await self._create_stealth_context()
        page = await context.new_page()

        try:
            await page.goto(url, wait_until="networkidle", timeout=30000)
            await self._human_delay()

            # look for Turnstile iframe
            turnstile_frame = None
            for frame in page.frames:
                if "challenges.cloudflare.com" in frame.url:
                    turnstile_frame = frame
                    break

            if turnstile_frame:
                # click the checkbox
                checkbox = await turnstile_frame.query_selector("input[type='checkbox']")
                if checkbox:
                    await self._human_click(page, checkbox)
                    await page.wait_for_timeout(3000)

            # extract token
            token = await self._extract_token(page, "cf-turnstile-response")
            if token:
                return SolveResult(answer=token, confidence=0.9, metadata={"provider": "turnstile"})

            return SolveResult(answer="", confidence=0.0, metadata={"error": "turnstile token not found"})

        finally:
            await page.close()
            await context.close()

    async def _solve_interactive(
        self, url: str, sitekey: str, provider: str, options: dict
    ) -> SolveResult:
        """Solve hCaptcha or reCAPTCHA v2 — may need image grid solving."""
        context = await self._create_stealth_context()
        page = await context.new_page()

        try:
            await page.goto(url, wait_until="networkidle", timeout=30000)
            await self._human_delay()

            # find captcha iframe and click checkbox
            if provider == "hcaptcha":
                token_field = "h-captcha-response"
                iframe_url_part = "hcaptcha.com"
            else:
                token_field = "g-recaptcha-response"
                iframe_url_part = "google.com/recaptcha"

            captcha_frame = None
            for frame in page.frames:
                if iframe_url_part in frame.url:
                    captcha_frame = frame
                    break

            if captcha_frame:
                checkbox = await captcha_frame.query_selector("#checkbox, .recaptcha-checkbox-border")
                if checkbox:
                    await self._human_click(page, checkbox)
                    await page.wait_for_timeout(3000)

            # check if challenge appeared (image grid)
            challenge_frame = None
            for frame in page.frames:
                if "api2/bframe" in frame.url or "hcaptcha.com/challenge" in frame.url:
                    challenge_frame = frame
                    break

            if challenge_frame:
                # image challenge — delegate to grid solver
                result = await self._solve_image_challenge(page, challenge_frame, options)
                if result.confidence > 0:
                    return result

            # try to extract token directly (maybe checkbox was enough)
            token = await self._extract_token(page, token_field)
            if token:
                return SolveResult(answer=token, confidence=0.8, metadata={"provider": provider})

            return SolveResult(
                answer="", confidence=0.0,
                metadata={"error": f"{provider} solving incomplete", "provider": provider}
            )

        finally:
            await page.close()
            await context.close()

    async def _solve_recaptcha_v3(self, url: str, sitekey: str, options: dict) -> SolveResult:
        """Solve reCAPTCHA v3 — purely behavioral, no visual challenge."""
        context = await self._create_stealth_context()
        page = await context.new_page()

        try:
            await page.goto(url, wait_until="networkidle", timeout=30000)

            # simulate human behavior
            await self._simulate_browsing(page)

            # extract token
            token = await self._extract_token(page, "g-recaptcha-response")
            if token:
                return SolveResult(answer=token, confidence=0.7, metadata={"provider": "recaptcha_v3"})

            return SolveResult(
                answer="", confidence=0.0,
                metadata={"error": "recaptcha v3 token not found"}
            )

        finally:
            await page.close()
            await context.close()

    async def _solve_auto(self, url: str, sitekey: str, options: dict) -> SolveResult:
        """Auto-detect captcha provider and solve."""
        context = await self._create_stealth_context()
        page = await context.new_page()

        try:
            await page.goto(url, wait_until="networkidle", timeout=30000)
            await self._human_delay()

            # detect provider
            page_content = await page.content()

            if "challenges.cloudflare.com" in page_content or "cf-turnstile" in page_content:
                await page.close()
                await context.close()
                return await self._solve_turnstile(url, sitekey, options)
            elif "hcaptcha.com" in page_content:
                await page.close()
                await context.close()
                return await self._solve_interactive(url, sitekey, "hcaptcha", options)
            elif "google.com/recaptcha" in page_content:
                # check v2 vs v3
                if "render" in page_content:
                    await page.close()
                    await context.close()
                    return await self._solve_recaptcha_v3(url, sitekey, options)
                else:
                    await page.close()
                    await context.close()
                    return await self._solve_interactive(url, sitekey, "recaptcha_v2", options)

            return SolveResult(
                answer="", confidence=0.0,
                metadata={"error": "could not detect captcha provider"}
            )

        finally:
            if not page.is_closed():
                await page.close()
            await context.close()

    async def _solve_image_challenge(self, page, challenge_frame, options: dict) -> SolveResult:
        """Delegate image grid challenge to GridSolver."""
        from core.registry import solver_registry

        grid_solver = solver_registry.get("grid")
        if grid_solver is None:
            return SolveResult(answer="", confidence=0.0, metadata={"error": "grid solver not available"})

        # screenshot the challenge grid
        try:
            grid_element = await challenge_frame.query_selector(
                ".task-image-container, .rc-imageselect-table-33, .rc-imageselect-table-44"
            )
            if grid_element:
                screenshot_bytes = await grid_element.screenshot()
                import cv2
                grid_image = cv2.imdecode(
                    np.frombuffer(screenshot_bytes, np.uint8),
                    cv2.IMREAD_COLOR,
                )

                # get target label from challenge
                label_el = await challenge_frame.query_selector(
                    ".prompt-text, .rc-imageselect-desc-no-canonical"
                )
                target = ""
                if label_el:
                    target = await label_el.text_content()
                    target = target.strip().lower() if target else ""

                result = await grid_solver.solve(
                    image=grid_image,
                    options={"target": target, **options},
                )
                return result
        except Exception as e:
            logger.error(f"Image challenge delegation failed: {e}")

        return SolveResult(answer="", confidence=0.0, metadata={"error": "image challenge failed"})

    async def _extract_token(self, page, field_name: str) -> Optional[str]:
        """Extract captcha token from page."""
        # try textarea
        token = await page.evaluate(f"""
            () => {{
                const el = document.querySelector('textarea[name="{field_name}"]');
                if (el && el.value) return el.value;
                const input = document.querySelector('input[name="{field_name}"]');
                if (input && input.value) return input.value;
                return null;
            }}
        """)
        return token

    async def _human_delay(self):
        """Random human-like delay."""
        delay = random.uniform(0.5, 2.0)
        await asyncio.sleep(delay)

    async def _human_click(self, page, element):
        """Click with human-like mouse movement."""
        box = await element.bounding_box()
        if box:
            x = box["x"] + box["width"] * random.uniform(0.3, 0.7)
            y = box["y"] + box["height"] * random.uniform(0.3, 0.7)
            await page.mouse.move(x, y, steps=random.randint(5, 15))
            await asyncio.sleep(random.uniform(0.1, 0.3))
            await page.mouse.click(x, y)
        else:
            await element.click()

    async def _simulate_browsing(self, page):
        """Simulate human browsing behavior for behavioral captchas."""
        # random mouse movements
        for _ in range(random.randint(3, 7)):
            x = random.randint(100, 1800)
            y = random.randint(100, 900)
            await page.mouse.move(x, y, steps=random.randint(5, 20))
            await asyncio.sleep(random.uniform(0.2, 0.8))

        # random scroll
        await page.evaluate("window.scrollBy(0, %d)" % random.randint(50, 300))
        await asyncio.sleep(random.uniform(0.5, 1.5))
        await page.evaluate("window.scrollBy(0, %d)" % random.randint(-100, 100))
        await asyncio.sleep(random.uniform(0.3, 1.0))

    async def cleanup(self):
        """Close browser and playwright."""
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
