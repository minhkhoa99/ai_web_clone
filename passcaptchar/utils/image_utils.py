import base64
import numpy as np
import cv2
import httpx

def decode_base64_image(b64: str) -> np.ndarray:
    if ',' in b64:
        b64 = b64.split(',')[1]
    img_data = base64.b64decode(b64)
    np_arr = np.frombuffer(img_data, np.uint8)
    return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

def download_image(url: str) -> np.ndarray:
    with httpx.Client() as client:
        response = client.get(url)
        response.raise_for_status()
        np_arr = np.frombuffer(response.content, np.uint8)
        return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

def preprocess_for_ocr(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    denoised = cv2.fastNlMeansDenoising(gray, h=10, searchWindowSize=21, templateWindowSize=7)
    thresh = cv2.adaptiveThreshold(denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)
    return thresh

def split_grid(image: np.ndarray, rows: int = 3, cols: int = 3) -> list[np.ndarray]:
    h, w = image.shape[:2]
    cell_h = h // rows
    cell_w = w // cols
    cells = []
    for i in range(rows):
        for j in range(cols):
            cell = image[i*cell_h:(i+1)*cell_h, j*cell_w:(j+1)*cell_w]
            cells.append(cell)
    return cells

def encode_image_base64(image: np.ndarray) -> str:
    _, buffer = cv2.imencode('.png', image)
    return base64.b64encode(buffer).decode('utf-8')
