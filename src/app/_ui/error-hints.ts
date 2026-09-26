// What to do about an error code (hardening spec §4 table): shared by api() errors, the progress page's reason
// banner and its "Lỗi & cảnh báo" panel. Dependency-free, client-safe.
const LOGIN = "Cần đăng nhập. Mở cửa sổ, tự xử lý, rồi Tiếp tục.";
const SKIPPED = "Đã bỏ qua theo giới hạn an toàn.";

export const ERROR_HINTS: Record<string, string> = {
  AI_QUOTA: "Provider hết credit/quota. Nạp thêm hoặc đổi provider ở Cài đặt AI, rồi Chạy lại QA / Tiếp tục.",
  AI_AUTH: "API key sai hoặc không có quyền. Sửa ở Cài đặt AI.",
  AI_BAD_CONFIG: "Base URL / model không hợp lệ hoặc request bị từ chối. Kiểm tra Cài đặt AI (Test kết nối).",
  AI_RATE_LIMIT: "Provider giới hạn tốc độ. Chờ rồi Tiếp tục.",
  AI_BAD_RESPONSE: "AI trả lời sai định dạng hoặc lỗi mạng/5xx. Thử lại hoặc đổi model.",
  AI_CIRCUIT_OPEN: "AI lỗi 5 lần liên tiếp. Sửa cấu hình AI rồi Tiếp tục.",
  BUDGET_EXCEEDED: "Hết ngân sách token. Tăng ngân sách ở Clone lại, hoặc sửa tay trong Editor.",
  NAV_TIMEOUT: "Trang tải quá lâu. Tiếp tục để thử lại.",
  BROWSER_CRASH: "Trình duyệt lỗi hoặc bị đóng. Tiếp tục để thử lại.",
  AUTH_REQUIRED: LOGIN,
  CAPTCHA_REQUIRED: LOGIN,
  LOGIN_FAILED: "Sai tài khoản. Nhập lại rồi Tiếp tục.",
  ROBOTS_DISALLOWED: SKIPPED,
  ASSET_TOO_LARGE: SKIPPED,
  NODE_LIMIT: SKIPPED,
  PROJECT_SIZE_LIMIT: SKIPPED,
  PROJECT_BUSY: "Project đang chạy. Tạm dừng trước rồi thử lại.",
  QUEUE_FULL: "Hàng đợi đầy (1 chạy + 5 chờ). Chờ bớt rồi thử lại.",
  BAD_STATE: "Thao tác chưa hợp lệ ở trạng thái này (xem thông báo).",
};

export const hintFor = (code: string | null | undefined): string | undefined => (code && Object.hasOwn(ERROR_HINTS, code) ? ERROR_HINTS[code] : undefined);
