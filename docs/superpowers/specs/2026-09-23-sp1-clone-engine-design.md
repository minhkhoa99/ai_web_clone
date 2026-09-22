# SP1 — Clone Engine + UI — Design Spec

- Ngày: 2026-09-23
- Trạng thái: Chờ review
- Quy tắc code: tuân thủ `rules.md` (lean, predictable, bounded)

## 0. Bối cảnh và phạm vi

Tool local giúp **clone UI website** và (giai đoạn sau) **design website/mobile** bằng AI cấu hình động. Dự án chia 3 sub-project, mỗi cái có spec → plan → implement riêng:

| SP | Nội dung | Trạng thái |
|---|---|---|
| **SP1** | AI Gateway, Auth, Crawl, Capture, IR + Graph, xuất HTML, QA gate + fix loop, Lịch sử/Resume, Preview, Editor, Code view | **Spec này** |
| SP2 | Emitter framework (React/Next/Vue/WordPress/...; lớp template cho .NET/Python/PHP), chọn kiến trúc frontend, luật kiến trúc trong graph + lint, graphify + SETUP.md | Spec riêng sau SP1 |
| SP3 | Design web/mobile với ui-ux-pro-max, đề xuất/nhập tính năng, cổng luật | Spec riêng sau SP2 (phác thảo mục 12) |

Nền tảng tham khảo: `JCodesMore/ai-website-cloner-template` (MIT) — pipeline Recon → Foundation → Specs → Build → QA. SP1 thay agent tự do bằng **orchestrator tất định**.

### Nguyên tắc cốt lõi

1. **Clone tất định, AI không vẽ lại.** HTML sinh từ DOM + computed style đã chụp. AI chỉ: đặt tên section, sửa section fail diff.
2. **Đo thay vì tin.** Pixel diff theo section × breakpoint là cổng bắt buộc; checklist độ phủ tương tác hiển thị rõ cái đã/chưa clone.
3. **Mọi workload bounded.** Mỗi bước có giới hạn cứng; vượt giới hạn → cảnh báo trong graph, không treo.
4. **Không mất tiến độ.** Checkpoint theo task nhỏ, ghi an toàn khi mất điện, resume được.

### Ngoài phạm vi (không làm)

- Clone logic backend (chỉ clone UI).
- Mirror JS gốc của site.
- Giải CAPTCHA tự động, giả mạo fingerprint, plugin stealth, vượt Cloudflare/anti-bot. CAPTCHA luôn do người dùng giải tay.
- Multi-user / SaaS / auth của chính tool.

## 1. Kiến trúc tổng thể

Một process **Next.js (App Router)** chạy local: UI + API routes + pipeline. Lưu trữ: **SQLite** qua `node:sqlite` built-in (Node 24+, synchronous API, không cần native dependency) + thư mục `workspace/<projectId>/`. Tiến độ đẩy về UI qua **SSE**.

```
src/
  app/                     # Next.js: UI pages + API routes (mỏng, chỉ gọi core)
  core/
    gateway.ts             # AI provider: Anthropic/OpenAI compatible
    auth.ts                # phát hiện login/CAPTCHA, login tự động, phiên
    browser.ts             # connectOverCDP Chrome thật / launch fallback; page pool
    crawl.ts               # BFS cùng origin, sitemap
    capture.ts             # chụp 1 trang: DOM, style, asset, screenshot, tương tác
    inspector.ts           # lệnh rà soát cho vòng fix
    graph.ts               # SQLite nodes/edges + truy vấn ngữ cảnh
    ir.ts                  # kiểu IR + dựng IR từ capture + áp patch
    emit-html.ts           # IR → HTML/CSS/runtime JS
    qa.ts                  # pixel diff theo section + fix loop
    jobs.ts                # queue bounded + task checkpoint + SSE events
workspace/<projectId>/
  profile/                 # Chrome profile riêng (giữ phiên đăng nhập)
  pages/<pageId>/capture.json, shots/<bp>.png
  assets/<sha256>.<ext>
  out/                     # HTML xuất ra
  qa/<pageId>/<sectionId>/<bp>-{orig,clone,heat}.png
```

Hướng phụ thuộc: `app → core`; trong core: `jobs → (crawl|capture|qa|emit) → (browser|graph|ir|gateway)`. `ir.ts` và `emit-html.ts` thuần (không I/O ngoài đọc/ghi file do caller truyền), test được độc lập.

### Luồng dữ liệu

```
URL → [auth check] → crawl (sitemap) → người dùng tick trang
    → capture (pool 3 trang) → tải asset (6 song song)
    → dựng IR + graph (tất định) → AI đặt tên section (1 call/trang)
    → emit HTML → render clone → QA diff
    → fix loop (≤3 vòng, inspector bắt buộc)
    → preview / editor → xuất ZIP hoặc thư mục
```

### Giới hạn mặc định (chỉnh trên UI khi có ghi chú)

| Giới hạn | Mặc định | Chỉnh UI |
|---|---|---|
| Job clone chạy đồng thời | 1 | không |
| Queue job chờ | 5 (vượt → 429) | không |
| Trang capture song song | 3 | có (1–5) |
| Số trang crawl | 20 (trần 100) | có |
| Độ sâu crawl | 2 | có (0–5) |
| Delay giữa request cùng origin | 500ms | có |
| Timeout điều hướng | 30s | không |
| Node DOM / trang | 20.000 | không |
| Cuộn lazy-load | 50 bước / 30.000px | không |
| Tương tác / trang | 300; 5s mỗi cái; tổng 5 phút | không |
| Asset song song / file / dự án | 6 / 25MB / 500MB | không |
| Ngưỡng QA | 95% | có |
| Vòng fix / section | 3 | không |
| Section fix song song | 2 | không |
| Inspector call AI tự gọi / vòng | 5 | không |
| Ngân sách token / dự án | 2.000.000 | có |
| AI call timeout / retry | 120s / 2 lần + exponential backoff | không |
| Chờ người dùng xử lý auth | 10 phút | không |

## 2. AI Gateway (`core/gateway.ts`)

Không gán cứng provider. Người dùng thêm nhiều provider trên UI.

- **Add Anthropic Compatible**: `POST {baseURL}/messages`, header `x-api-key`, `anthropic-version`.
- **Add OpenAI Compatible**: `POST {baseURL}/chat/completions`, header `Authorization: Bearer`.
- Form: `name`, `baseURL` (vd `http://localhost:20128/v1`), `apiKey`. Nút **Fetch models** (`GET {baseURL}/models`), chọn model, nút **Test** (1 request ngắn).
- **Gán model theo vai trò**: `vision` (đặt tên section, fix có ảnh), `code` (patch IR), `design` (SP3).
- API: `generate({ role, messages, images?, tools?, jsonSchema? })` — chuẩn hóa về 1 dạng response; hỗ trợ tool-call cả 2 chuẩn.
- Đếm token vào `projects.tokens_used`; vượt ngân sách → `BUDGET_EXCEEDED`.
- **Bảo mật key**: lưu trong SQLite, mã hóa AES-256-GCM, khóa ở file local ngoài `workspace/`. API trả UI chỉ dạng che `sk-…abcd`. Không log key, không đưa vào project/graph/output.

## 3. Auth (`core/auth.ts`)

**Phát hiện** (tất định, chạy khi crawl và mỗi trang capture): có `input[type=password]`; redirect tới URL khớp `login|signin|auth`; HTTP 401/403; iframe/script reCAPTCHA, hCaptcha, Turnstile. Phát hiện → task trạng thái `needs_auth` (mã `AUTH_REQUIRED` / `CAPTCHA_REQUIRED`), UI nhận SSE.

**Option 1 — Thủ công**: UI hiện banner "Trang X cần đăng nhập" + nút **Mở cửa sổ** (Chrome thật, headed, đúng trang). Người dùng đăng nhập/giải CAPTCHA → bấm **Tiếp tục**. Chờ tối đa 10 phút, quá hạn → `failed` kèm lý do.

**Option 2 — Tự động**: người dùng nhập username/password (tùy chọn selector user/pass/submit). Tool điền form theo heuristic, submit. Gặp CAPTCHA → chuyển Option 1. Sai mật khẩu → dừng ngay, không retry (tránh khóa tài khoản).

**Chung**:
- Phiên lưu trong `workspace/<id>/profile/`; lần sau dùng lại. Nút **Xóa phiên**.
- Tùy chọn import cookie / `storageState` JSON.
- Mật khẩu mặc định chỉ trong RAM trong job. Tick "Ghi nhớ" → mã hóa như API key. Không log, không gửi AI, không vào graph/output.

**Browser** (`core/browser.ts`): ưu tiên `connectOverCDP` vào Chrome đã cài, headed, profile riêng của project; fallback `chromium.launch` nếu không có Chrome. Pool tối đa N page; mỗi task mở/đóng page trong `try/finally`. Tôn trọng `robots.txt` mặc định.

## 4. Lịch sử dự án + Resume (`core/jobs.ts`)

### Schema

```sql
projects(id, url, mode, config_json, status, progress, tokens_used, created_at, updated_at)
tasks(id, project_id, phase, key, status, attempts, output_path, error_code, error_msg, updated_at,
      UNIQUE(project_id, phase, key))
INDEX tasks(project_id, status)
```

- Task = đơn vị nhỏ: `(phase, page, breakpoint/section)`, vd `capture:/pricing`, `qa:/pricing:hero:1440`, `fix:/pricing:hero:r2`.
- `config_json` đóng băng lúc tạo dự án (depth, số trang, breakpoint, ngưỡng, provider id — không có key).
- Phase: `discover → capture → assets → ir → name → emit → qa → fix → done`.

### Ghi bền

- SQLite `journal_mode=WAL`, `synchronous=FULL`.
- File output ghi ra `*.tmp` → `rename` nguyên tử → mới đánh dấu task `done` trong transaction. Không có trạng thái "done nhưng file hỏng".

### Khởi động lại

- Mọi task `running` → `pending`; project đang chạy → `interrupted`.
- Không tự chạy lại; người dùng bấm **Tiếp tục**.
- Resume = chạy task `pending` + `failed` (attempts < 3), bỏ qua `done`. `UNIQUE` chống tạo trùng task.
- Phiên hết hạn → auth phát hiện lại → `needs_auth`. Option 2 hỏi lại mật khẩu nếu không "Ghi nhớ".
- UI hiện ngày capture từng trang (resume sau nhiều ngày thì trang còn lại chụp theo site mới).

### Trạng thái

| Nhóm UI | Trạng thái |
|---|---|
| Chưa hoàn thành | `draft`, `running`, `paused`, `interrupted`, `needs_auth`, `failed` |
| Đã hoàn thành | `completed` (section fail QA vẫn tính, đánh dấu đỏ) |

**Tạm dừng**: không nhận task mới, chờ task đang chạy xong, rồi `paused`.

## 5. Crawl (`core/crawl.ts`)

- 2 chế độ: **1 trang full** (chỉ URL nhập) hoặc **crawl** (BFS cùng origin, depth, số trang tối đa).
- Nguồn link: `sitemap.xml` (nếu có) + `a[href]` trên trang đã load.
- Chuẩn hóa URL: bỏ hash, bỏ tracking params (`utm_*`, `fbclid`, `gclid`), sắp xếp query, bỏ `/` cuối; bỏ file không phải HTML theo extension.
- Kết quả → màn **Sitemap** (cây theo path, checkbox, icon cần đăng nhập).

## 6. Capture (`core/capture.ts`)

Mỗi trang 1 task, tuần tự:

1. **Load**: `goto` `networkidle`, timeout 30s; chờ `document.fonts.ready`; route intercept chặn điều hướng ra ngoài trong suốt quá trình.
2. **Lazy-load**: cuộn theo chiều cao viewport tới đáy (≤50 bước / 30.000px), chờ ảnh `decode()`, về đầu. Infinite scroll dừng ở trần + cảnh báo.
3. **DOM**: 1 lần `evaluate` duyệt toàn cây. Mỗi node: tag, attr cần thiết, text, bbox, computed style **trừ mặc định của tag** (mặc định tính 1 lần/tag trong iframe sạch, cache trong lần evaluate). Gồm `::before/::after`, shadow DOM open, iframe cùng origin; iframe khác origin giữ nguyên thẻ. Phần tử ẩn chụp + đánh dấu `hidden`. Trần 20.000 node.
4. **Responsive**: lặp bước 3 ở 375/768/1440, full-page screenshot mỗi breakpoint. Style 375/768 diff so với 1440 → chỉ phần khác sinh media query.
5. **CSSOM**: đọc mọi `document.styleSheets` (khác origin → fetch text). Giữ `@keyframes`, `@font-face`, `@media`, `transition`, `--var`; lấy selector `:hover/:focus` cho bước 6.
6. **Quét tương tác ẩn**:

| Loại | Phát hiện | Hành động |
|---|---|---|
| Hover/focus | selector `:hover/:focus` trong CSSOM, `cursor:pointer` | hover/focus → diff style phần tử + con |
| Dropdown/menu | `aria-expanded`, `aria-haspopup`, `[data-toggle]`, hamburger ở 375 | click → MutationObserver bắt subtree mới hiện |
| Tab | `role=tablist` | click từng tab, chụp panel |
| Accordion | `details/summary`, `aria-controls` | mở từng mục |
| Modal | `aria-haspopup=dialog`, `[data-modal]` | mở → chụp → Esc/nút đóng |
| Carousel | class swiper/slick/splide, `overflow-x` + `scroll-snap` | next tối đa 10 slide |
| Sticky/scroll | `position: sticky/fixed` | style ở scroll 0 và 600px |
| Form | input/select | focus / invalid / placeholder |

   Sau mỗi thao tác khôi phục trạng thái (Esc / click lại / reload nếu không được). Giới hạn 300 tương tác, 5s/cái, 5 phút/trang. Mỗi tương tác → node `Interaction` (trigger, loại, style delta, subtree mới, trạng thái `captured|failed|skipped`).

7. **Asset**: nguồn `page.on('response')` + DOM (`img`, `srcset`, `picture`, `video/poster`, `background-image`, font, SVG sprite, favicon, OG). Tải qua request context của trình duyệt (giữ cookie). Dedupe sha256 nội dung. 6 song song, 25MB/file, 500MB/dự án, timeout 30s, retry 2. SVG inline giữ inline.
8. **Động**: canvas/WebGL → ảnh + `dynamic`; Lottie → tải JSON; video → tải hoặc giữ embed.

**Bộ nhớ**: mỗi trang ghi `capture.json` ngay khi xong rồi giải phóng. Graph chỉ giữ metadata + path.

## 7. IR + Graph (`core/ir.ts`, `core/graph.ts`)

### IR

```ts
type IRNode = {
  id: string; tag: string; attrs: Record<string, string>; text?: string;
  cls: string[];                 // id style đã dedupe
  hidden?: boolean;
  states?: { hover?: string; focus?: string; active?: string };
  behavior?: string;             // id Interaction → runtime JS; 'unresolved' nếu chưa tái tạo được
  children: IRNode[];
};
type Section = { id: string; pageId: string; name: string; role: string; hash: string; origin: 'capture' | 'ai'; root: IRNode };
type Page    = { id: string; path: string; title: string; meta: Record<string, string>; sectionIds: string[] };
```

`origin` chừa sẵn cho SP3 (IR do AI sinh).

- **Tách section** (tất định): landmark `header/nav/footer`, con trực tiếp của `main`, block full-width cao >100px dưới `body`.
- **Đặt tên** (AI, 1 call/trang, role `vision`): gửi outline (cây tag sâu 3, 200 ký tự text đầu, thumbnail nhỏ) → `{sectionId: {name, role}}` validate zod. AI lỗi → tên mặc định `section-N`, không chặn pipeline.
- **Dedupe style**: mỗi tập khai báo duy nhất → `.s-<hash6>`; override breakpoint gắn cùng class.
- **Layout dùng chung**: hash cấu trúc section (cây tag + class, bỏ text) xuất hiện ≥2 trang → `Layout`, lưu 1 lần.
- **Component lặp**: ≥3 anh em cùng hash cấu trúc → `Component`, khác biệt text/ảnh = props (nền cho SP2).
- **Token**: đếm tần suất màu/font/cỡ chữ/spacing/radius/shadow → `--token`; giữ nguyên giá trị gốc, không làm tròn.
- **Áp patch** (dùng cho fix loop + editor): `applyPatch(ir, ops)` thuần, trả IR mới; op không hợp lệ → lỗi có context.

### Graph

```sql
nodes(id, project_id, type, key, data_json)
  -- type: Page|Section|Layout|Component|Token|Asset|Interaction|Feature(SP3)
edges(project_id, src, dst, type)
  -- HAS_SECTION|USES_LAYOUT|INSTANCE_OF|USES_TOKEN|USES_ASSET|TRIGGERS
INDEX nodes(project_id, type); INDEX edges(src, type); INDEX edges(dst, type)
```

Truy vấn viết sẵn, bounded (AI không tự viết SQL):
- `contextForFix(sectionId, budgetChars)`: subtree, token, interaction, path asset, 3 ảnh; cắt theo ngân sách, ưu tiên node trong vùng diff đỏ.
- `coverage(projectId)`: đếm Interaction theo trạng thái, nhóm theo trang.
- `sharedLayouts(projectId)`.

## 8. Xuất HTML (`core/emit-html.ts`)

```
out/
  index.html, pricing.html, ...   # layout chung chèn lúc build
  css/styles.css                  # token + @font-face + @keyframes + class dedupe + media query
  js/runtime.js                   # ~3KB vanilla, theo data-attr:
                                  #   data-toggle | data-tabs | data-carousel | data-modal | data-sticky
  assets/                         # tên theo hash, đường dẫn tương đối
```

- Mở bằng `file://` hoặc `npx serve out`.
- URL tuyệt đối về domain gốc → viết lại đường dẫn local. Link tới trang đã clone → file local; trang chưa clone → giữ URL gốc.
- `data-ir-id` trên mỗi phần tử (để QA map bbox); có tùy chọn bỏ khi xuất cuối.
- Hành vi runtime không tái tạo được → `behavior=unresolved` → vào fix loop / checklist đỏ.

## 9. QA gate + Fix loop (`core/qa.ts`, `core/inspector.ts`)

### Chấm điểm

- Serve `out/` qua route local, chụp cùng trình duyệt, cùng viewport 375/768/1440.
- Cả gốc và clone: chèn CSS tắt animation/transition/caret, chờ font.
- Mỗi section: crop theo bbox (gốc: từ capture; clone: qua `data-ir-id`). `pixelmatch` threshold 0.1, bỏ anti-alias. **Điểm = 1 − diffPixels / total**. Chênh chiều cao tính là diff. Vùng `dynamic` bị mask.
- Bbox lệch >2px ghi làm gợi ý cho AI, không tính điểm.
- Lưu `orig/clone/heat.png` mỗi section × breakpoint.

### Fix loop (mỗi section fail; ≤3 vòng; ≤2 section song song)

1. **Bắt buộc (orchestrator chạy, AI không bỏ được)**: inspector trên gốc + clone — a11y snapshot, computed style của 20 node diff lớn nhất, ảnh crop.
2. `contextForFix(sectionId)`.
3. AI (role `code`, kèm ảnh nếu model vision) trả **JSON patch IR**: `setStyle | setAttr | setText | replaceSubtree | setBehavior`; validate zod; sai định dạng vẫn tính 1 vòng. AI được tool-call inspector tối đa 5 lần/vòng: `snapshotA11y`, `screenshotSection`, `hover`, `click`, `readStyle`.
4. Áp patch → emit lại section → diff lại. **Không tụt điểm**: điểm giảm → revert, giữ bản tốt nhất.
5. Hết 3 vòng vẫn < ngưỡng → đánh dấu đỏ, sửa tay trong editor.

Hết ngân sách token → dừng fix, đánh dấu section còn lại; job không `failed`.

## 10. UI

| Route | Nội dung |
|---|---|
| `/settings/ai` | Danh sách provider; **Add Anthropic Compatible** / **Add OpenAI Compatible** → form name/baseURL/apiKey → **Fetch models** → chọn → **Test**; gán model theo vai trò |
| `/` | Lịch sử dự án: lọc Chưa hoàn thành/Đã hoàn thành, tìm URL, phân trang 20. Mỗi dòng: URL, thumbnail, % tiến độ, pha, cập nhật cuối. Nút Tiếp tục / Tạm dừng / Mở / Clone lại / Xóa (xác nhận, xóa cả workspace) |
| `/new` | URL; chế độ 1 trang full / crawl (số trang, depth, concurrency); auth: không / thủ công / tự động + tài khoản; ngưỡng QA; ngân sách token; output: HTML (khác hiện "SP2") |
| `/p/[id]/sitemap` | Cây URL + checkbox, icon cần đăng nhập, ngày capture, Chọn tất cả → **Bắt đầu clone** |
| `/p/[id]` | Tiến độ theo pha, log SSE, task đang chạy, Tạm dừng/Tiếp tục, banner `needs_auth` (**Mở cửa sổ** / **Tiếp tục**) |
| `/p/[id]/preview` | Gốc vs clone cạnh nhau; breakpoint 375/768/1440; overlay slider; heatmap; danh sách section + điểm (bấm để cuộn); tab **Checklist độ phủ** |
| `/p/[id]/editor` | GrapesJS: canvas, layer, style manager, block (section của dự án), chuyển thiết bị; layout chung = symbol (sửa 1 lần áp mọi trang); chọn nhiều section → **Gộp thành layout**; panel hiệu ứng (keyframes đã capture + preset fade/slide); Save → adapter → patch IR; undo/redo có sẵn |
| `/p/[id]/code` | Cây file + viewer chỉ đọc (shiki); **Xuất ZIP** (stream) / **Xuất ra thư mục** |

Adapter editor: `irToGrapes(ir)` và `grapesToPatch(before, grapesJson)` — sinh patch IR, dùng chung `applyPatch`.

## 11. Xử lý lỗi

Mỗi lỗi có mã, ghi `tasks.error_code/error_msg` kèm context (URL, pha, key); giữ stack trong log.

| Mã | Xử lý |
|---|---|
| `NAV_TIMEOUT`, `BROWSER_CRASH` | tạo lại page/pool, retry task ≤3 |
| `AUTH_REQUIRED`, `CAPTCHA_REQUIRED` | `needs_auth`, chờ người dùng |
| `LOGIN_FAILED` | dừng, không retry |
| `ROBOTS_DISALLOWED`, `ASSET_TOO_LARGE`, `NODE_LIMIT`, `PROJECT_SIZE_LIMIT` | skip + cảnh báo, không retry |
| `AI_RATE_LIMIT` | backoff theo `retry-after`, ≤3 |
| `AI_AUTH`, `AI_BAD_CONFIG` | không retry, báo ngay |
| `AI_BAD_RESPONSE` | tính 1 vòng fix |
| `BUDGET_EXCEEDED` | dừng pha AI, đánh dấu |

**Circuit breaker AI**: 5 lỗi liên tiếp → tạm dừng pha dùng AI, project `failed` kèm lý do; resume sau khi sửa config.

Resource: page/context đóng trong `finally`; listener `page.on` gỡ khi task xong; SSE stream đóng khi client ngắt; `child_process` có timeout + kill.

## 12. Phác thảo SP3 — Design (spec riêng sau SP2)

Dùng lại gateway, IR (`origin: 'ai'`), graph (node `Feature`), editor, preview, fix loop, emitter SP2. Cổng kiểm tra là **luật** thay cho pixel.

1. **Brief**: mô tả, ngành, nền tảng (web responsive / mobile), tham chiếu tùy chọn (dự án clone, ảnh, URL).
2. **Design system**: gọi `ui-ux-pro-max` (`search.py --design-system`, timeout 30s) → style, màu, font, luật UX → người dùng chỉnh → khóa `DESIGN.md` + token.
3. **Tính năng**: AI đề xuất hoặc người dùng nhập; mỗi tính năng có tiêu chí nghiệm thu; duyệt → node `Feature`.
4. **Sinh IR** theo trang, chỉ dùng token/component của design system.
5. **Cổng luật**: chỉ token (không hex/px lẻ); cấu trúc lặp phải là component; contrast AA, mobile vùng chạm ≥44px, chữ ≥16px; luật UX tự động hóa được; mọi tiêu chí nghiệm thu map vào node; component dữ liệu có empty/loading/error. Fail → fix ≤3 vòng → đỏ trong checklist tính năng.
6. **Review + editor**, 7. **Xuất** qua SP2.

Còn mở: mobile = web responsive hay native (React Native/Flutter).

## 13. Testing

Vitest + Playwright.

- **Fixture** (`tests/fixtures`, serve local): (1) landing đơn giản; (2) menu/tab/modal/carousel/hover; (3) nhiều trang, header dùng chung.
- **E2E**: clone từng fixture → mọi section ≥95% ở 3 breakpoint; checklist 100% `captured`; header chỉ 1 lần trong IR.
- **Unit**: chuẩn hóa URL, dedupe style, hash section, `applyPatch`, adapter gateway (mock server cả 2 chuẩn), phát hiện login.
- **Mock AI provider** trả patch tất định → test fix loop không cần AI thật.
- **Resume**: kill process giữa chừng → khởi động lại → Tiếp tục → kết quả trùng lần chạy liền mạch.

## 14. Tiêu chí hoàn thành SP1

- 3 fixture đạt E2E ở mục 13.
- Resume sau kill đạt.
- Mọi giới hạn ở mục 1 có hiệu lực (test ít nhất: queue 429, trần trang crawl, trần tương tác).
- Key/mật khẩu không xuất hiện trong log, graph, output (test grep).
