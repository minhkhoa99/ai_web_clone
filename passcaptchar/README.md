# PassCaptcha — AI-Powered Local CAPTCHA Solver & Auto Bypass

Hệ thống giải CAPTCHA hoàn toàn cục bộ (Local AI), không cần trả phí API cho bên thứ 3 (như 2Captcha, Anti-Captcha). Đã tích hợp trình tự động hóa anti-detect bypass các hệ thống bảo mật như Google reCAPTCHA v2/v3, Cloudflare, hCaptcha.

---

## 🚀 Tính Năng Nổi Bật

- **Không cần GPU NVIDIA:** Chạy mượt mà trên CPU bằng ONNX & Faster-Whisper int8.
- **5 Loại CAPTCHA Khả Dụng:**
  - `text`: OCR chữ nghiêng/nhiễu (TrOCR Transformer).
  - `grid`: Lưới ảnh reCAPTCHA v2 (YOLOv8 Nano).
  - `audio`: Âm thanh giọng nói reCAPTCHA (Faster-Whisper AI).
  - `slider`: Slider/Puzzle trượt mảnh ghép (OpenCV Edge Matching).
  - `browser`: Tự động hóa chống bot (Playwright + Stealth Native + Chrome CDP Bridge).
- **Cơ Chế Hybrid Bypass:** Tự động phát hiện cờ bot, chuyển đổi thông minh giữa 1-Click -> Audio Solver -> Visual Grid Fallback.
- **Tích Hợp Sẵn API & CLI:** Đầy đủ FastAPI Server (Swagger UI) và lệnh CLI command line.

---

## 🛠️ Cài Đặt (Setup)

### 1. Chuẩn bị môi trường (Windows / Linux)

Yêu cầu: **Python 3.10+**

```powershell
# 1. Tạo môi trường ảo venv
python -m venv venv

# 2. Kích hoạt venv (Windows PowerShell)
.\venv\Scripts\activate
# Hoặc trên Linux/Mac: source venv/bin/activate

# 3. Cài đặt PyTorch CPU-only (Nhe ~200MB, không cần CUDA)
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

# 4. Cài đặt các thư viện phụ thuộc
pip install -r requirements.txt

# 5. Cài đặt trình duyệt Chromium cho Playwright
playwright install chromium
```

---

## 🎯 Hướng Dẫn Chạy (Usage)

### Cách 1: Chạy Tự Động Giải reCAPTCHA v2 Demo (End-to-End Test)

Script `test_auto_full.py` sẽ tự động khởi chạy Chrome thật, né cờ bot và tự động giải reCAPTCHA v2 từ A-Z:

```powershell
python test_auto_full.py
```
*(Script sẽ tự động mở Chrome cổng 9222, giải audio/grid bằng AI, click Submit và giữ màn hình 15 giây để quan sát).*

---

### Cách 2: Khởi Chạy REST API Server (Dùng như 2Captcha Local API)

```powershell
python main.py server --port 8000
```

- **Swagger UI Giao diện Test API:** `http://localhost:8000/docs`
- **POST `/solve` Endpoint:** Trả về kết quả JSON trong vài trăm miligiây.

**Ví dụ gọi API bằng Python:**

```python
import httpx

# Giải captcha dạng text bằng ảnh base64 hoặc file upload
url = "http://localhost:8000/solve/upload"
files = {"file": open("captcha.png", "rb")}
data = {"captcha_type": "text"}

response = httpx.post(url, files=files, data=data)
print(response.json())
# Output: {"success": true, "answer": "A8X2", "confidence": 0.96, "solve_time_ms": 310}
```

---

### Cách 3: Sử Dụng Command Line (CLI)

```powershell
# Xem danh sách Solver và cấu hình
python main.py info

# Giải captcha chữ/hình ảnh
python main.py solve text path/to/captcha.png

# Giải captcha slider (ảnh nền + mảnh ghép)
python main.py solve slider path/to/bg.png --piece-path path/to/piece.png
```

---

## 🏗️ Cấu Trúc Dự Án

```
passcaptchar/
├── main.py                  # Entrypoint FastAPI Server & CLI Command Line
├── config.py                # Cấu hình Pydantic & Cửa sổ tham số AI
├── test_auto_full.py        # Script tự động hóa Bypass reCAPTCHA v2 (CDP + Hybrid AI)
├── requirements.txt         # Danh sách thư viện phụ thuộc
│
├── core/
│   ├── classifier.py        # Tự động nhận diện loại captcha
│   ├── registry.py          # Quản lý đăng ký các solver
│   └── schemas.py           # Pydantic Schemas cho API
│
├── solvers/
│   ├── base.py              # Base Solver Abstract Class
│   ├── text_solver.py       # Giải captcha chữ (TrOCR)
│   ├── grid_solver.py       # Giải captcha lưới ảnh (YOLOv8 Full-Image Context)
│   ├── audio_solver.py      # Giải captcha âm thanh (Faster-Whisper CPU int8)
│   ├── slider_solver.py     # Giải captcha trượt mảnh ghép (OpenCV)
│   └── browser_solver.py    # Điều khiển trình duyệt tự động
│
├── utils/
│   ├── stealth.py           # Native Playwright Stealth Evasion (Xóa cờ bot)
│   ├── image_utils.py       # Cắt ảnh lưới, xử lý tiền xử lý OCR
│   └── logger.py            # Rich Console Logger
│
└── models/                  # Thư mục lưu Model Weights (Tự động tải về lần đầu)
```

---

## 🛡️ Nguyên Lý Anti-Detect & Bypass

1. **CDP Chrome Bridge (`localhost:9222`):** Kết nối trực tiếp vào trình duyệt Google Chrome gốc của Windows để loại bỏ toàn bộ các biến phát hiện bot (`navigator.webdriver`).
2. **Hybrid Solver Chain:** 
   `1-Click Checkbox` $\longrightarrow$ `Whisper Audio AI` $\longrightarrow$ `YOLOv8 Visual Grid (Fallback)`.
3. **Session Audio Fetch:** Tải file âm thanh `.mp3` trực tiếp trong Context Browser để tránh bị mã hóa tiếng nhiễu chống bot của Google.
