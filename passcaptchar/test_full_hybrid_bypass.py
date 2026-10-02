# language: Python, file: test_full_hybrid_bypass.py, target: Windows 11
"""
PassCaptcha Hybrid Bypass Script:
- CDP Mode: Connects to real local Chrome (high Trust Score).
- Audio Solver: Primary attempt using Whisper AI.
- Grid Solver Fallback: Automatic visual fallback via YOLOv8 if audio is rate-limited.
"""

import asyncio
import random
import base64
import cv2
import numpy as np
from pathlib import Path
from playwright.async_api import async_playwright
from solvers.audio_solver import AudioSolver
from solvers.grid_solver import GridSolver

audio_solver = AudioSolver()
grid_solver = GridSolver()

async def run_hybrid_test():
    async with async_playwright() as p:
        print("[1] Connecting to Real Chrome via CDP (localhost:9222)...")
        try:
            browser = await p.chromium.connect_over_cdp("http://localhost:9222")
        except Exception as e:
            print("[!] Cannot connect to Chrome CDP port 9222.")
            print("[!] Please run this command in CMD/PowerShell first:")
            print(r'    & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome_dev_profile"')
            return

        context = browser.contexts[0]
        page = await context.new_page()

        print("[2] Navigating to Google reCAPTCHA Demo...")
        await page.goto("https://www.google.com/recaptcha/api2/demo")
        await page.wait_for_timeout(2000)

        # 1. Locate Checkbox Frame
        recaptcha_frame = None
        for frame in page.frames:
            if "api2/anchor" in frame.url:
                recaptcha_frame = frame
                break

        if recaptcha_frame:
            print("[3] Clicking Checkbox naturally...")
            checkbox = await recaptcha_frame.wait_for_selector("#recaptcha-anchor")
            box = await checkbox.bounding_box()
            if box:
                await page.mouse.move(box["x"] + random.randint(8, 16), box["y"] + random.randint(8, 16), steps=18)
                await page.wait_for_timeout(random.randint(300, 600))
                await page.mouse.click(box["x"] + 12, box["y"] + 12)

            await page.wait_for_timeout(3000)

        # Check for 1-Click Pass
        body_html = await page.content()
        if 'aria-checked="true"' in body_html or "recaptcha-checkbox-checked" in body_html:
            print("\n=======================================================")
            print("[SUCCESS] 1-CLICK PASS! Real Chrome profile trusted by Google.")
            print("=======================================================\n")
            await page.click("#recaptcha-demo-submit", force=True)
            await page.wait_for_timeout(10000)
            return

        # 2. Challenge Popup handling
        bframe = None
        for frame in page.frames:
            if "api2/bframe" in frame.url:
                bframe = frame
                break

        if not bframe:
            print("[!] No challenge frame found.")
            return

        # Attempt Primary: Audio Solver
        audio_success = False
        audio_btn = await bframe.query_selector("#recaptcha-audio-button")
        if audio_btn:
            print("\n[--- PRIMARY SOLVER: AUDIO (Whisper AI) ---]")
            await audio_btn.click()
            await page.wait_for_timeout(2500)

            # Check if blocked by automated queries message
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
                    print(f"-> Whisper AI Output: '{result.answer}'")

                    if result.answer:
                        await bframe.fill("#audio-response", result.answer)
                        await page.wait_for_timeout(500)
                        await bframe.click("#recaptcha-verify-button")
                        await page.wait_for_timeout(3000)
                        
                        # Verify if passed
                        body_html_after = await page.content()
                        if 'aria-checked="true"' in body_html_after:
                            audio_success = True
                            print("\n[SUCCESS] Audio Solver passed reCAPTCHA!")

        # Attempt Secondary Fallback: Visual Grid Solver (YOLOv8)
        if not audio_success:
            print("\n[--- FALLBACK SOLVER: VISUAL GRID (YOLOv8) ---]")
            # Switch back to image challenge if in audio mode
            image_btn = await bframe.query_selector("#recaptcha-image-button")
            if image_btn:
                await image_btn.click()
                await page.wait_for_timeout(2000)

            # Read target instructions (e.g., "select all images with a bus")
            target_el = await bframe.query_selector(".rc-imageselect-instructions")
            target_text = await target_el.inner_text() if target_el else ""
            print(f"-> Target Instruction: {target_text.replace(chr(10), ' ')}")

            # Capture grid image screenshot
            grid_table = await bframe.query_selector(".rc-imageselect-target")
            if grid_table:
                grid_bytes = await grid_table.screenshot()
                nparr = np.frombuffer(grid_bytes, np.uint8)
                grid_img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                # Solve grid tiles
                result = await grid_solver.solve(image=grid_img, options={"target": target_text, "rows": 3, "cols": 3})
                print(f"-> YOLOv8 Selected Tile Indices: {result.answer}")

                # Click matching tiles
                tiles = await bframe.query_selector_all(".rc-imageselect-tile")
                for idx in result.answer:
                    if idx < len(tiles):
                        await tiles[idx].click()
                        await page.wait_for_timeout(random.randint(300, 600))

                await page.wait_for_timeout(1000)
                await bframe.click("#recaptcha-verify-button")
                await page.wait_for_timeout(3000)

        # Submit Main Form
        print("\n[+] Submitting Main Form...")
        await page.click("#recaptcha-demo-submit", force=True)
        await page.wait_for_timeout(3000)

        body_text = await page.inner_text("body")
        if "Xác minh thành công" in body_text or "Verification Success" in body_text:
            print("\n=======================================================")
            print("[SUCCESS 100%] CHUYỂN TRANG THÀNH CÔNG: 'Xác minh thành công...'")
            print("=======================================================\n")
        else:
            print(f"[!] Current Page Content: {body_text[:200]}...")

        print("[+] Keeping browser open for 15s to observe...")
        await page.wait_for_timeout(15000)

if __name__ == "__main__":
    asyncio.run(run_hybrid_test())
