# SP1 — Hardening sau lần chạy thật (2026-09-26)

Bổ sung cho `2026-09-23-sp1-clone-engine-design.md` (spec gốc) và `2026-09-24-sp1-ui-stitch-parity-design.md`.
Nguồn: điều tra lần chạy thật với provider `apmix` (9router, rồi vyceai), 2026-09-26. Những gì dưới đây **ghi đè** spec gốc khi mâu thuẫn.

## 0. Bằng chứng (tóm tắt)

| # | Hiện tượng | Nguyên nhân gốc |
|---|---|---|
| E1 | `AI_BAD_CONFIG: provider "apmix" returned status 402` rồi project `failed` | `gateway.ts` gộp mọi 4xx lạ vào `AI_BAD_CONFIG`; `jobs.ts runFixes` fail cả project khi fixAll ném lỗi `AI_*` đầu tiên |
| E2 | Pha fix không có commit DB trong 12 phút và 101 phút; Tạm dừng vô hiệu; Xoá trả 409; hàng đợi kẹt | `page.evaluate(document.fonts.ready)` không có timeout (evaluate không theo `setDefaultTimeout`); clone vẫn tải font từ site gốc; pause chỉ xét giữa các pha |
| E3 | Editor 409 `BAD_STATE: cannot edit a failed project`; sitemap khoá hết mà không giải thích | `EDITABLE_STATUSES=["completed"]`; không có đường khôi phục |
| E4 | Trang Tiến độ ghi "xong · 0 lỗi" cạnh `failed`; không có log | UI không đọc `error_msg`; lý do status không lưu DB; fix/retry/timeout không log; console im lặng; `events.jsonl` bị xoá cùng project |
| E5 | Không xem được trình duyệt khi chạy | chỉ cửa sổ đăng nhập mở headed |
| E6 | Request AI 5.1 MB, một section 295 node, section rác, ngưỡng 100% | `splitSections` không đi vào wrapper chứa `<main>`; không lọc node ẩn; ảnh fix không giới hạn cỡ; form không cảnh báo ngưỡng |

## 1. Lỗi AI (ghi đè spec gốc §9, §11)

- Mã mới `AI_QUOTA`: HTTP **402**, không retry. Mapping: 429 → `AI_RATE_LIMIT`; 401/403 → `AI_AUTH`; 402 → `AI_QUOTA`; 4xx khác → `AI_BAD_CONFIG`; 5xx/mạng → `AI_BAD_RESPONSE` (retry).
- Thông báo lỗi gateway gồm: tên provider, **model id**, HTTP status, và ≤300 ký tự đầu của body phản hồi. Body được lọc: xoá chuỗi API key nếu có mặt, gộp khoảng trắng. Không bao giờ có key, header hay prompt.
- **Lỗi AI kéo dài** (`AI_AUTH`, `AI_QUOTA`, `AI_BAD_CONFIG`) được xử lý như `BUDGET_EXCEEDED`: dừng mọi lời gọi AI còn lại trong lượt chạy, **project không `failed`**.
  - Naming: giữ tên mặc định cho trang hiện tại và các trang còn lại.
  - Fix: section đang sửa và mọi section chưa xong được đánh dấu đỏ, giữ điểm tốt nhất đã có, không vòng nào nữa.
  - Task đó `done` với `error_code`=mã, `error_msg`=thông báo; project `completed`, `status_reason`=mã; log `warn` "AI dừng: <mã> — <thông báo>".
- **Circuit breaker** (5 lỗi AI tạm thời liên tiếp: `AI_BAD_RESPONSE`, `AI_RATE_LIMIT` hết retry) giữ nguyên: `failed` + `AI_CIRCUIT_OPEN`, Tiếp tục sau khi sửa config.
- Gateway phát sự kiện retry (status/lỗi mạng, lần thử, delay) qua callback tuỳ chọn `onRetry`; job ghi thành log `warn`.

## 2. Không treo, dừng được ngay (ghi đè spec gốc §4 "Tạm dừng")

- Mọi `document.fonts.ready` trong capture và QA chờ tối đa **10 s** (race ngay trong trang), quá hạn thì chấm tiếp.
- Trang clone trong QA và fix **chặn mọi request không tới server loopback của chính nó** (`route.abort`). QA tất định, không phụ thuộc site gốc.
- Mọi `page.evaluate` trong qa/qa-fix/inspector chạy qua helper có timeout **30 s**; quá hạn → `BROWSER_CRASH` (retry theo §11).
- **Tạm dừng = dừng ngay**: đặt cờ pause, huỷ lời gọi AI đang chạy (AbortSignal của lượt chạy), đóng browser handle. Task đang `running` về `pending` (checkpoint đảm bảo an toàn), project `paused`. Không có task nào bị `failed` vì pause.
- **Xoá project đang chạy**: dừng như trên, chờ lượt chạy kết thúc tối đa **15 s**, rồi xoá. Quá 15 s → 409 `PROJECT_BUSY` kèm thông báo tiếng Việt.

## 3. Khôi phục sau `failed` / `interrupted` / `paused` (ghi đè R69)

- Editor, Lưu, Gộp layout, **Chạy lại QA** chấp nhận project ở `completed`, `failed`, `interrupted`, `paused` **khi task `emit` đã `done`** và project không chạy / không chờ trong hàng đợi. Ngược lại 409 với thông báo tiếng Việt nêu lý do và việc cần làm.
- Sitemap ở trạng thái khác `draft`: vẫn read-only, nhưng hiện dòng giải thích "Đã bắt đầu clone — danh sách trang đã chốt. Dùng Clone lại để quét lại."

## 4. Hiển thị lỗi và log

- DB: cột `projects.status_reason TEXT` (migration idempotent). `setStatus` ghi lý do; chuyển sang status khác thì xoá lý do.
- Task `done` kèm mã không chặn (tên mặc định, AI dừng, budget) lưu cả `error_msg`.
- **`workspace/<id>/run.log`**: văn bản, một dòng mỗi mục, `ISO-time LEVEL [phase] message`.
  - Nội dung: mọi sự kiện (trừ `progress`), cộng chi tiết chỉ server có (stack trace của lỗi, từng vòng fix, retry gateway).
  - Luôn lọc qua `redact`. Xoay vòng ở **5 MB** sang `run.prev.log` (tối đa 2 file).
  - Xoá cùng project.
- API `GET /api/projects/[id]/log`: ghép `run.prev.log` + `run.log`, `text/plain; charset=utf-8`, `Content-Disposition: attachment; filename="run-<id8>.log"`. Chỉ loopback, không cần CSRF (GET).
- Server console: mọi log `warn`/`error`, task `failed` và status `failed` in ra `console.warn`/`console.error` với tiền tố `[job <id8>]`.
- Log vòng fix (level `info`/`warn`): bắt đầu vòng, AI trả sai định dạng, ops bị IR từ chối, ứng viên bị revert (điểm), ứng viên được nhận (điểm), kết quả cuối (pass/đỏ, điểm, số vòng).
- UI trang Tiến độ:
  - Banner lý do khi `failed`/`completed` có `status_reason`: mã, thông báo tiếng Việt, gợi ý xử lý.
  - **Panel "Lỗi & cảnh báo"**: bảng các task có `error_code`, gồm pha, trang/section, mã, thông báo, gợi ý. Rỗng thì ẩn.
  - Trạng thái từng trang đếm cả lỗi của naming và fix.
  - Nút **Tải log** (`/api/projects/[id]/log`).
- Preview fix-card: hiện `error_msg`; project không chạy thì không bao giờ hiện "Đang sửa…".
- `_ui/api.ts`: thông báo tiếng Việt cho các mã thường gặp (bảng gợi ý dùng chung với panel lỗi).

Bảng gợi ý (`src/app/_ui/error-hints.ts`):

| Mã | Gợi ý |
|---|---|
| `AI_QUOTA` | Provider hết credit/quota. Nạp thêm hoặc đổi provider ở Cài đặt AI, rồi Chạy lại QA / Tiếp tục. |
| `AI_AUTH` | API key sai hoặc không có quyền. Sửa ở Cài đặt AI. |
| `AI_BAD_CONFIG` | Base URL / model không hợp lệ hoặc request bị từ chối. Kiểm tra Cài đặt AI (Test kết nối). |
| `AI_RATE_LIMIT` | Provider giới hạn tốc độ. Chờ rồi Tiếp tục. |
| `AI_BAD_RESPONSE` | AI trả lời sai định dạng hoặc lỗi mạng/5xx. Thử lại hoặc đổi model. |
| `AI_CIRCUIT_OPEN` | AI lỗi 5 lần liên tiếp. Sửa cấu hình AI rồi Tiếp tục. |
| `BUDGET_EXCEEDED` | Hết ngân sách token. Tăng ngân sách ở Clone lại, hoặc sửa tay trong Editor. |
| `NAV_TIMEOUT` | Trang tải quá lâu. Tiếp tục để thử lại. |
| `BROWSER_CRASH` | Trình duyệt lỗi hoặc bị đóng. Tiếp tục để thử lại. |
| `AUTH_REQUIRED` / `CAPTCHA_REQUIRED` | Cần đăng nhập. Mở cửa sổ, tự xử lý, rồi Tiếp tục. |
| `LOGIN_FAILED` | Sai tài khoản. Nhập lại rồi Tiếp tục. |
| `ROBOTS_DISALLOWED`, `ASSET_TOO_LARGE`, `NODE_LIMIT`, `PROJECT_SIZE_LIMIT` | Đã bỏ qua theo giới hạn an toàn. |
| `PROJECT_BUSY` | Project đang chạy. Tạm dừng trước rồi thử lại. |
| `QUEUE_FULL` | Hàng đợi đầy (1 chạy + 5 chờ). Chờ bớt rồi thử lại. |
| `BAD_STATE` | Thao tác chưa hợp lệ ở trạng thái này (xem thông báo). |

## 5. Hiện trình duyệt khi chạy

- `projectConfigSchema.headed: boolean`, mặc định `false`.
- `/new`: checkbox **"Hiện trình duyệt khi chạy"** kèm dòng phụ "Mở cửa sổ Chromium để xem trực tiếp; mặc định chạy nền". Checkbox nằm cạnh các tuỳ chọn chạy.
- Mọi `openBrowser` của project (discover, crawl route, runProject) truyền `headed: cfg.headed`.
- `CDP_URL` (env) vẫn được ưu tiên như cũ.
- Không liên quan tới anti-bot: cửa sổ hiện chỉ để xem, không đổi fingerprint.

## 6. Độ trung thực của clone và kích thước request AI

- Asset: URL `url(...)` tuyệt đối (http/https) trong `@font-face` của CSSOM đã chụp được tải như asset. URL tương đối resolve theo URL trang (best-effort). Vẫn áp giới hạn §1 spec gốc.
- `splitSections`:
  - Wrapper một-con **hoặc** wrapper không phải landmark mà có hậu duệ `main` trong độ sâu `MAX_UNWRAP`: đi vào tới `main`, nên các anh em của `main` (header/footer) cũng thành section.
  - Bỏ khỏi danh sách section (vẫn nằm trong shell): phần tử có bbox 1440 rộng hoặc cao = 0, `display:none`, `visibility:hidden`; tag `script`, `style`, `noscript`, `template`, `next-route-announcer`.
- Ảnh gửi AI (fix và naming): mỗi ảnh thu nhỏ để **rộng ≤ 1024 px**, tổng base64 mỗi request **≤ 1.5 MB**. Quá mức thì bỏ ảnh heatmap, rồi ảnh clone, rồi giảm tiếp.
- Prompt đặt tên: phần mô tả section cắt ở **24 000 ký tự**.
- `/new`: ngưỡng QA > 98% hiện cảnh báo "Ngưỡng rất cao: section gần đúng cũng phải qua vòng sửa AI (tốn token). Khuyên dùng 95%."

## 7. Không làm

- Không tự giải CAPTCHA / stealth (`rule_no_captcha_bypass`), không làm drift_*.
- Không giữ log sau khi xoá project (người dùng không chọn).
- Không thêm tính năng SP2/SP3.
