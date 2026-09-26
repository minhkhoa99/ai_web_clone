# AI Web Clone Tool — SP1

Công cụ chạy **local** để clone giao diện một website thành HTML/CSS tĩnh theo cách **tất định**: HTML được sinh từ DOM và computed style đã chụp, AI chỉ đặt tên section và sửa những section không đạt cổng QA hình ảnh (so pixel theo từng section ở 375/768/1440, ngưỡng 95%, tối đa 3 vòng sửa).

Luồng xử lý: **discover → capture → assets → ir → name → emit → qa → fix → done**.

---

## 1. Yêu cầu

| Thành phần | Phiên bản |
|---|---|
| Node.js | 24 trở lên (đang phát triển trên Node 26) |
| npm | đi kèm Node |
| Chromium cho Playwright | cài bằng lệnh ở bước 2 |
| Hệ điều hành | Windows / macOS / Linux |

Không bắt buộc có AI provider: không có provider thì tool vẫn clone được, chỉ dùng tên section mặc định và bỏ qua vòng AI sửa lỗi.

## 2. Cài đặt

```sh
git clone <repo> ai_web_clone
cd ai_web_clone
npm install
npx playwright install chromium
```

## 3. Chạy ứng dụng

```sh
npm run build   # build production (lần đầu mất ~1–2 phút)
npm start       # chạy tại http://127.0.0.1:3000
```

Chế độ phát triển (tự reload khi sửa code):

```sh
npm run dev     # http://127.0.0.1:3000
```

Mở trình duyệt vào **http://127.0.0.1:3000** (gõ `localhost:3000` cũng được).

> Server chỉ nghe trên 127.0.0.1 và từ chối mọi request có Host khác loopback. Ứng dụng không có đăng nhập, vì vậy **không được mở ra mạng LAN hay internet**.

Muốn đổi cổng: `npx next start -H 127.0.0.1 -p 3100`.

## 4. Dùng lần đầu

### 4.1 Thêm AI provider (tuỳ chọn)

1. Vào sidebar **Cài đặt AI** → **Add Anthropic Compatible** hoặc **Add OpenAI Compatible**.
2. Nhập **Tên**, **Base URL** (ví dụ `https://api.anthropic.com/v1`, `https://api.openai.com/v1`, hoặc gateway local như `http://localhost:20128/v1`) và **API key**.
3. Bấm **Fetch models**, rồi gán model cho từng vai trò:
   - `vision`: đặt tên section;
   - `code`: vòng sửa QA. Model này nhận ảnh chỉ khi nó cũng là model vision của cùng provider;
   - `design`: dành cho SP3, hiện chưa dùng.
4. Bấm **Test kết nối**. Kết quả đúng là "Kết nối OK · … ms · HTTP 200 · … model".
5. Bấm **Lưu provider**. Key được mã hoá khi lưu và không bao giờ hiển thị lại (chỉ hiện dạng `sk-…abcd`).

### 4.2 Thử với site mẫu có sẵn (khuyên làm trước)

Mở một terminal khác và phục vụ site mẫu:

```sh
npx serve tests/fixtures/site3 -l 5050   # 3 trang, header dùng chung
# hoặc
npx serve tests/fixtures/site2 -l 5051   # menu / tab / modal / carousel / hover
# hoặc
npx serve tests/fixtures/site1 -l 5052   # landing page 1 trang
```

Rồi trong app:

1. **Clone mới**: nhập URL (ví dụ `http://localhost:5050`), chọn **Crawl** (site3) hoặc **1 trang** (site1/site2), rồi bấm **Quét trang**.
2. **Sitemap**: kiểm tra danh sách trang, mã HTTP, thời gian load và ước tính token/thời gian. Bấm **Chọn tất cả** → **Bắt đầu clone**.
3. **Tiến độ**: stepper 9 pha và log chạy trực tiếp. Log được lưu lại, bấm F5 không mất. Chờ đến trạng thái `completed`.
   - **Tạm dừng** dừng ngay (huỷ lời gọi AI đang chạy, đóng trình duyệt); **Tiếp tục** chạy lại từ checkpoint.
   - Có lỗi hoặc AI dừng giữa chừng: banner lý do (mã + gợi ý xử lý) và panel **Lỗi & cảnh báo** (pha, trang/section, mã, thông báo, gợi ý).
   - **Tải log**: tải `run.log` đầy đủ của project (gồm stack trace, từng vòng sửa AI, retry gateway).
4. **Preview**:
   - so ảnh gốc với clone theo 375/768/1440;
   - 3 chế độ so sánh: Cạnh nhau / Chồng mờ / Trượt so sánh;
   - heatmap, điểm khớp của từng section;
   - tab **Checklist độ phủ** liệt kê các tương tác đã chụp.
5. **Code**: xem cây file đã xuất. Có nút Xuống dòng và Sao chép, xuất **ZIP** hoặc **ra thư mục** (tuỳ chọn bỏ `data-ir-id`).
6. **Editor**:
   - sửa bằng GrapesJS: nháy đúp vào chữ để sửa, đổi style ở panel;
   - **Lưu** sẽ sinh lại HTML;
   - sau khi sửa, vào Preview bấm **Chạy lại QA** để chấm điểm lại;
   - Editor và Chạy lại QA dùng được cả khi project `failed` / `interrupted` / `paused`, miễn pha `emit` đã xong và project không chạy. Sửa tay sẽ bỏ các vòng sửa AI còn dở của project.
7. **Lịch sử** (`/`): lọc Chưa hoàn thành / Đã hoàn thành, tìm theo URL, Tạm dừng / Tiếp tục / Clone lại / tải ZIP / Xoá.

Kết quả mong đợi với site mẫu: mọi section đạt từ 95% trở lên, thường là 99–100%.

### 4.3 Clone website thật

- Nên bắt đầu bằng chế độ **1 trang** với một trang tĩnh, đơn giản. Sau đó mới dùng **Crawl** (mặc định 20 trang, tối đa 100, độ sâu 0–5).
- **Trang cần đăng nhập hoặc có CAPTCHA**: project chuyển sang `needs_auth`, bấm **Mở cửa sổ**, tự đăng nhập hoặc giải CAPTCHA trong Chrome, rồi bấm **Tiếp tục**. Cũng có thể **Import cookie JSON** (storageState) hoặc **Xóa phiên**. Tool **không** tự giải CAPTCHA, không giả fingerprint và không vượt anti-bot.
- **Đăng nhập tự động**: chọn chế độ auth "tự động" ở Clone mới và nhập tài khoản. Nếu sai mật khẩu, tool dừng ngay và hỏi lại, không thử lại.
- Section dưới ngưỡng được AI sửa tối đa 3 vòng (nếu đã có provider). Phần còn đỏ thì sửa tay trong Editor.
- Ngưỡng QA nên để 95%. Trên 98% form hiện cảnh báo: section gần đúng cũng phải qua vòng sửa AI (tốn token).
- Muốn xem trình duyệt đang làm gì: ở Clone mới bật **Hiện trình duyệt khi chạy** (mặc định chạy nền). Cửa sổ chỉ để xem, không đổi fingerprint hay vượt anti-bot. `CDP_URL` vẫn được ưu tiên nếu có.
- Provider hết quota (`AI_QUOTA`, HTTP 402), sai key (`AI_AUTH`) hoặc sai base URL/model (`AI_BAD_CONFIG`): tool dừng mọi lời gọi AI còn lại nhưng project vẫn `completed` (tên section mặc định, section chưa đạt để đỏ); banner Tiến độ nêu lý do.

## 5. Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `WORKSPACE_ROOT` | `./workspace` | Thư mục làm việc từng project (ảnh chụp, asset, `out/`, profile trình duyệt, log) |
| `DB_PATH` | `./sp1.db` | Database SQLite (project, task, provider, graph) |
| `KEY_PATH` | `./secret.key` | Khoá AES-256-GCM để mã hoá API key và thông tin đăng nhập đã ghi nhớ (tự tạo lần đầu) |
| `TOKEN_BUDGET` | `2000000` | Ngân sách token AI mặc định mỗi project; giá trị không hợp lệ sẽ về mặc định |
| `CDP_URL` | — | Dùng Chrome đang chạy sẵn (ví dụ `http://127.0.0.1:9222`) thay vì mở Chromium mới |

Ví dụ (PowerShell): `$env:WORKSPACE_ROOT="D:\clones"; npm start`. Với bash: `WORKSPACE_ROOT=/data/clones npm start`.

## 6. Dữ liệu và dọn dẹp

| Đường dẫn | Nội dung |
|---|---|
| `workspace/<projectId>/pages/` | `capture.json` và ảnh chụp theo breakpoint |
| `workspace/<projectId>/assets/` | asset đã tải, tên theo hash |
| `workspace/<projectId>/out/` | HTML/CSS/JS đã xuất, mở trực tiếp bằng `file://` hoặc `npx serve` |
| `workspace/<projectId>/qa/` | ảnh orig/clone/heatmap của QA |
| `workspace/<projectId>/run.log` | log văn bản của project, mỗi dòng `ISO-time LEVEL [phase] message`, đã lọc secret; quá 5 MB xoay sang `run.prev.log`. Tải bằng nút **Tải log** hoặc `GET /api/projects/<id>/log`. Xoá cùng project |
| `sp1.db`, `secret.key` | database và khoá mã hoá |

Muốn làm lại từ đầu: tắt server rồi xoá `workspace/` và `sp1.db`. Chỉ xoá `secret.key` khi chấp nhận mất các API key đã lưu.

## 7. Chạy test

```sh
npm run typecheck   # kiểm tra kiểu TypeScript
npm test            # unit test (Vitest)
npm run test:e2e    # e2e: Chromium thật; các test UI tự build Next một lần (~2 phút)
npm run build       # build production, phải 0 warning
```

## 8. Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| `Executable doesn't exist` / thiếu Chromium | `npx playwright install chromium` |
| Cổng 3000 đã bị chiếm | `npx next start -H 127.0.0.1 -p 3100` |
| Trang trả 403 "loopback" | Mở bằng `127.0.0.1` hoặc `localhost`, không dùng IP LAN hay tên máy |
| Nút bị báo `PROJECT_BUSY` (409) | Project đang crawl/chạy hoặc đang mở cửa sổ đăng nhập; chờ xong hoặc bấm Tiếp tục |
| `QUEUE_FULL` (429) | Đã có 1 job chạy và 5 job chờ; chờ bớt rồi thử lại |
| Test provider báo `AI_AUTH` / `AI_BAD_CONFIG` | Sai key hoặc base URL; sửa ở Cài đặt AI rồi Test lại. Thông báo lỗi kèm provider, model id, HTTP status và đoạn đầu phản hồi (không có key) |
| Project dừng ở `needs_auth` | Bấm **Mở cửa sổ**, tự đăng nhập, rồi **Tiếp tục** |
| Server tắt giữa chừng | Mở lại app: project hiện trạng thái `interrupted`, bấm **Tiếp tục** để chạy từ checkpoint (không tự chạy lại) |
| `AI_QUOTA` (HTTP 402) | Provider hết credit/quota: nạp thêm hoặc đổi provider ở Cài đặt AI, rồi **Chạy lại QA** / **Tiếp tục**. Project vẫn `completed`, chỉ phần AI bị dừng |
| Project có vẻ treo (log đứng yên lâu) | Bấm **Tạm dừng**: dừng ngay, task đang chạy về chờ; rồi **Tiếp tục**. Mở **Tải log** để xem bước cuối cùng. Xoá project đang chạy cũng được (tool dừng trước, chờ tối đa 15 s) |
| Project `failed` nhưng muốn sửa kết quả | Nếu pha `emit` đã xong: mở **Editor** sửa tay rồi **Chạy lại QA**. Lý do lỗi xem ở banner và panel **Lỗi & cảnh báo** trang Tiến độ |
| Điểm QA thấp trên site thật | Thêm AI provider để chạy vòng sửa, hoặc sửa tay trong Editor rồi **Chạy lại QA** |

## 9. Bảo mật

- Chỉ chạy local: server bind 127.0.0.1 và kiểm tra Host (chống DNS rebinding). Các request thay đổi dữ liệu phải có body JSON và Origin cùng host (chống CSRF).
- Trang clone được phục vụ với CSP chỉ cho phép `js/runtime.js` của chính bản clone. Asset tải về chỉ giữ đuôi media an toàn và được phục vụ trong sandbox.
- API key và thông tin đăng nhập được mã hoá AES-256-GCM, không ghi log và không gửi cho AI.
- Không giải CAPTCHA, không stealth/giả fingerprint, không vượt anti-bot.

## 10. Tài liệu

- Spec engine SP1: `docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md`
- Spec UI ↔ Stitch: `docs/superpowers/specs/2026-09-24-sp1-ui-stitch-parity-design.md`
- Spec hardening sau lần chạy thật (lỗi AI, không treo, khôi phục, log, hiện trình duyệt): `docs/superpowers/specs/2026-09-26-sp1-realrun-hardening-design.md`
- Bảng map giao diện (màn → `ui_*` → tính năng → API) và danh sách drift cấm làm: `docs/superpowers/design/stitch-screens.md`
- Graph truy vết: `graphify-out/graph.json` (xem bằng `graphify-out/graph.html`)
