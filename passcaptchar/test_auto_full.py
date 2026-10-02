# language: Python, file: test_auto_full.py, target: Windows 11
"""
PassCaptcha Fully Automated End-to-End Solver:
1. Auto-spawns real local Google Chrome with CDP debugging port 9222.
2. Connects Playwright over CDP (avoids automation flags).
3. Navigates to reCAPTCHA demo.
4. Executes Hybrid Solver (1-Click -> Audio Whisper -> YOLOv8 Grid Fallback).
5. Auto-submits form and verifies completion screen.
"""

import asyncio
import subprocess
import socket
import random
import os
import cv2
import numpy as np
from pathlib import Path
from playwright.async_api import async_playwright
from solvers.audio_solver import AudioSolver
from solvers.grid_solver import GridSolver

audio_solver = AudioSolver()
grid_solver = GridSolver()

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
CHROME_PATH_X86 = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
PROFILE_DIR = r"C:\chrome_dev_profile"
CDP_PORT = 9222

def is_port_open(port: int) -> bool:
    """Check if CDP debugging port is already listening."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0

def ensure_chrome_running():
    """Auto-launch Chrome with CDP debugging port if not already running."""
    if is_port_open(CDP_PORT):
        print(f"[+] Chrome debugging port {CDP_PORT} is already open.")
        return

    # Find Chrome executable
    chrome_bin = CHROME_PATH if os.path.exists(CHROME_PATH) else CHROME_PATH_X86
    if not os.path.exists(chrome_bin):
        raise FileNotFoundError(f"Chrome executable not found at {CHROME_PATH}")

    print(f"[+] Auto-launching real Google Chrome on port {CDP_PORT}...")
    cmd = [
        chrome_bin,
        f"--remote-debugging-port={CDP_PORT}",
        f"--user-data-dir={PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check"
    ]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    # Wait for port to become active
    for _ in range(10):
        if is_port_open(CDP_PORT):
            print("[+] Chrome CDP process initialized successfully.")
            return
        asyncio.run(asyncio.sleep(0.5))

async def is_recaptcha_checked(recaptcha_frame) -> bool:
    """Strictly verify if the reCAPTCHA checkbox frame has green checkmark attribute."""
    if not recaptcha_frame:
        return False
    try:
        anchor = await recaptcha_frame.query_selector("#recaptcha-anchor")
        if anchor:
            checked = await anchor.get_attribute("aria-checked")
            return checked == "true"
    except Exception:
        pass
    return False

async def run_auto_test():
    # 1. Tự động bật Chrome thật
    ensure_chrome_running()
    await asyncio.sleep(1)

    async with async_playwright() as p:
        print(f"[1] Connecting Playwright to Chrome via CDP (localhost:{CDP_PORT})...")
        browser = await p.chromium.connect_over_cdp(f"http://localhost:{CDP_PORT}")
        context = browser.contexts[0]
        page = await context.new_page()

        print("[2] Navigating to Google reCAPTCHA Demo page...")
        await page.goto("https://www.google.com/recaptcha/api2/demo")
        await page.wait_for_timeout(2000)

        # Locate Checkbox Frame
        recaptcha_frame = None
        for frame in page.frames:
            if "api2/anchor" in frame.url:
                recaptcha_frame = frame
                break

        if recaptcha_frame:
            print("[3] Simulating human click on reCAPTCHA checkbox...")
            checkbox = await recaptcha_frame.wait_for_selector("#recaptcha-anchor")
            box = await checkbox.bounding_box()
            if box:
                await page.mouse.move(box["x"] + random.randint(8, 16), box["y"] + random.randint(8, 16), steps=20)
                await page.wait_for_timeout(random.randint(300, 600))
                await page.mouse.click(box["x"] + 12, box["y"] + 12)

            await page.wait_for_timeout(3500)

        # Strict 1-Click Pass Check directly on iframe element
        if await is_recaptcha_checked(recaptcha_frame):
            print("\n=======================================================")
            print("[SUCCESS 100%] 1-CLICK PASS! Green checkmark active.")
            print("=======================================================\n")
            await page.click("#recaptcha-demo-submit", force=True)
            await page.wait_for_timeout(10000)
            return

        print("[*] 1-Click checkmark not detected. Proceeding to Challenge Solver...")

        # Challenge Popup
        bframe = None
        for frame in page.frames:
            if "api2/bframe" in frame.url:
                bframe = frame
                break

        if not bframe:
            print("[!] Challenge frame not active.")
            return

        # Phase 1: Audio Solver
        audio_passed = False
        audio_btn = await bframe.query_selector("#recaptcha-audio-button")
        if audio_btn:
            print("\n[--> LAYER 1: AUDIO SOLVER (Whisper AI) <--]")
            await audio_btn.click()
            await page.wait_for_timeout(2500)

            prompt_text = await bframe.inner_text("body")
            if "automated queries" not in prompt_text.lower():
                audio_source = await bframe.query_selector(".rc-audiochallenge-tdownload-link")
                if audio_source:
                    audio_url = await audio_source.get_attribute("href")
                    
                    audio_b64 = await page.evaluate("""async (url) => {
                        const res = await fetch(url);
                        const blob = await res.blob();
                        return new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result.split(',')[1]);
                            reader.readAsDataURL(blob);
                        });
                    }""", audio_url)

                    result = await audio_solver.solve(options={"audio": audio_b64})
                    print(f"-> Whisper Audio Output: '{result.answer}'")

                    if result.answer:
                        input_field = await bframe.query_selector("#audio-response")
                        await input_field.focus()
                        for char in result.answer:
                            await page.keyboard.type(char, delay=random.randint(70, 150))
                        
                        await page.wait_for_timeout(400)
                        await bframe.click("#recaptcha-verify-button")
                        await page.wait_for_timeout(3000)

                        if await is_recaptcha_checked(recaptcha_frame):
                            audio_passed = True
                            print("[SUCCESS] Audio Solver successfully passed reCAPTCHA!")

        # Phase 2: Visual Grid Fallback
        if not audio_passed:
            print("\n[--> LAYER 2: VISUAL GRID FALLBACK (YOLOv8) <--]")
            image_btn = await bframe.query_selector("#recaptcha-image-button")
            if image_btn:
                await image_btn.click()
                await page.wait_for_timeout(2000)

            target_el = await bframe.query_selector(".rc-imageselect-instructions")
            target_text = await target_el.inner_text() if target_el else ""
            print(f"-> Target Class Instruction: {target_text.replace(chr(10), ' ')}")

            grid_table = await bframe.query_selector(".rc-imageselect-target")
            if grid_table:
                grid_bytes = await grid_table.screenshot()
                nparr = np.frombuffer(grid_bytes, np.uint8)
                grid_img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                result = await grid_solver.solve(image=grid_img, options={"target": target_text, "rows": 3, "cols": 3})
                print(f"-> YOLOv8 Matched Tile Indices: {result.answer}")

                tiles = await bframe.query_selector_all("td.rc-imageselect-tile")
                if not tiles:
                    tiles = await bframe.query_selector_all(".rc-imageselect-tile")

                selected_indices = result.answer if result.answer else []
                if not selected_indices:
                    print("[!] Class not directly matched by threshold — attempting secondary tile scan...")
                    res_relaxed = await grid_solver.solve(image=grid_img, options={"target": target_text, "rows": 3, "cols": 3, "confidence_threshold": 0.15})
                    selected_indices = res_relaxed.answer
                    print(f"-> Relaxed Matched Tiles: {selected_indices}")

                for idx in selected_indices:
                    if idx < len(tiles):
                        try:
                            await tiles[idx].scroll_into_view_if_needed()
                            await tiles[idx].click(force=True)
                        except Exception:
                            # Fallback via mouse click on tile bounding box
                            box = await tiles[idx].bounding_box()
                            if box:
                                await page.mouse.click(box["x"] + box["width"]/2, box["y"] + box["height"]/2)
                        await page.wait_for_timeout(random.randint(300, 600))

                await page.wait_for_timeout(800)
                await bframe.click("#recaptcha-verify-button")
                await page.wait_for_timeout(3000)

        # Check final checkmark status before submit
        if await is_recaptcha_checked(recaptcha_frame):
            print("\n[4] Submitting Form...")
            await page.click("#recaptcha-demo-submit", force=True)
            await page.wait_for_timeout(3000)

            body_text = await page.inner_text("body")
            if "Xác minh thành công" in body_text or "Verification Success" in body_text:
                print("\n=======================================================")
                print("[SUCCESS 100%] AUTO-SOLVED & PASSED TO SUCCESS PAGE!")
                print("=======================================================\n")
        else:
            print("\n[!] Checkbox was not marked green. Retrying challenge sequence...")

        print("[+] Keeping page visible for 15s before exit...")
        await page.wait_for_timeout(15000)

if __name__ == "__main__":
    asyncio.run(run_auto_test())
