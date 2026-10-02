# language: Python, file: test_recaptcha_demo.py, target: Windows 11
import asyncio
import random
import httpx
from pathlib import Path
from playwright.async_api import async_playwright
from utils.stealth import apply_stealth
from solvers.audio_solver import AudioSolver

audio_solver = AudioSolver()

async def run_stealth_test():
    async with async_playwright() as p:
        print("[1] Khởi chạy trình duyệt Chromium với Stealth...")
        browser = await p.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-infobars",
                "--start-maximized"
            ]
        )
        
        context = await browser.new_context(
            viewport={"width": 1280, "height": 720},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        )
        
        await apply_stealth(context)
        page = await context.new_page()

        print("[2] Truy cập reCAPTCHA Demo page...")
        await page.goto("https://www.google.com/recaptcha/api2/demo")
        await page.wait_for_timeout(random.randint(1500, 2500))

        # Tim frame anchor (checkbox)
        recaptcha_frame = None
        for frame in page.frames:
            if "api2/anchor" in frame.url:
                recaptcha_frame = frame
                break

        if recaptcha_frame:
            print("[3] Click Checkbox reCAPTCHA...")
            checkbox = await recaptcha_frame.wait_for_selector("#recaptcha-anchor")
            box = await checkbox.bounding_box()
            if box:
                await page.mouse.move(box["x"] + 12, box["y"] + 12, steps=15)
                await page.wait_for_timeout(random.randint(200, 400))
                await page.mouse.click(box["x"] + 12, box["y"] + 12)
            
            await page.wait_for_timeout(random.randint(2000, 3000))

        # Tìm frame challenge popup
        bframe = None
        for frame in page.frames:
            if "api2/bframe" in frame.url:
                bframe = frame
                break

        if bframe:
            audio_btn = await bframe.query_selector("#recaptcha-audio-button")
            if audio_btn:
                print("[4] Chuyển sang Audio Challenge...")
                await audio_btn.click()
                await page.wait_for_timeout(random.randint(2000, 3000))

                audio_source = await bframe.query_selector(".rc-audiochallenge-tdownload-link")
                if audio_source:
                    audio_url = await audio_source.get_attribute("href")
                    print(f"-> Audio Download Link: {audio_url}")

                    temp_mp3 = Path("temp_challenge.mp3")
                    async with httpx.AsyncClient() as client:
                        resp = await client.get(audio_url)
                        temp_mp3.write_bytes(resp.content)

                    print("[5] Giải mã âm thanh bằng Whisper AI...")
                    result = await audio_solver.solve(audio_path=str(temp_mp3))
                    print(f"-> Kết quả AI giải ra: '{result.answer}'")

                    if result.answer:
                        # Gõ phím tự nhiên
                        input_field = await bframe.query_selector("#audio-response")
                        await input_field.focus()
                        for char in result.answer:
                            await page.keyboard.type(char, delay=random.randint(80, 160))
                        
                        await page.wait_for_timeout(random.randint(400, 800))
                        print("[6] Click VERIFY trong captcha popup...")
                        await bframe.click("#recaptcha-verify-button")
                        await page.wait_for_timeout(3000)

                        print("[7] Click nút GỬI (Submit form)...")
                        await page.click("#recaptcha-demo-submit", force=True)
                        await page.wait_for_timeout(3000)

                        # Kiểm tra nội dung trang xem có dòng chữ thành công hay không
                        body_text = await page.inner_text("body")
                        if "Xác minh thành công" in body_text or "Verification Success" in body_text:
                            print("\n============================================")
                            print("[SUCCESS 100%] ĐÃ CHUYỂN TRANG: 'Xác minh thành công... Thật tuyệt!'")
                            print("============================================\n")
                        else:
                            print(f"\n[INFO] Nội dung trang sau khi submit:\n{body_text}\n")
                    else:
                        print("[!] AI không đọc được âm thanh (bị tiếng nhiễu chống bot của Google).")

                    if temp_mp3.exists():
                        temp_mp3.unlink()

        print("[8] Giữ trình duyệt 15 giây để dj quan sát màn hình...")
        await page.wait_for_timeout(15000)
        await browser.close()

if __name__ == "__main__":
    asyncio.run(run_stealth_test())
