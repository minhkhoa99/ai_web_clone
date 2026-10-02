# SP1 — UI ↔ Stitch parity — Design Spec

- Ngày: 2026-09-24
- Trạng thái: Chờ review
- Nhánh: `sp1-clone-engine`
- Phụ thuộc: spec SP1 `2026-09-23-sp1-clone-engine-design.md` (§1 giới hạn, §3 auth, §4 trạng thái, §9 QA, §10 UI), `CLAUDE.md` (drift, không bypass CAPTCHA), `rules.md` (lean, bounded, predictable).
- Đầu vào: gap audit 2026-09-24 (gap map + ảnh `current-*.png`, chụp 1440×900 từ `next start`), mockup `docs/superpowers/design/stitch/*.png|.html`, graph `graphify-out/graph.json`.

## 0. Bối cảnh, mục tiêu, phạm vi

UI SP1 hiện tại (Task 24/25) có đủ tính năng spec §10 nhưng lệch xa mockup Stitch: không có app shell/sidebar, không icon, token màu/radius/type khác, nhiều dữ liệu đã có ở core/API mà không hiện trên màn. Spec này đưa UI về **ngang Stitch về bố cục và hệ thị giác**, lấp phần UI còn thiếu cho tính năng đã có, thêm đúng 6 bổ sung backend nhỏ đã duyệt. Mockup chỉ là tham khảo bố cục: mọi thứ Stitch tự bịa là drift, không làm.

### 0.1 Mục tiêu

1. Một hệ token duy nhất lấy nguyên từ `tailwind.config` của Stitch (11 mockup có **cùng** giá trị, chỉ khác thứ tự key), khai báo thành CSS custom properties.
2. App shell: header cố định 56px, sidebar trái 224px chỉ gồm route thật.
3. Bộ component dùng chung `src/app/_ui/`, rồi dựng lại từng màn theo bảng element ở §3.
4. Mỗi element có id ổn định `ui_<screen>_<slug>` (dùng lại id graph khi khớp), gắn vào DOM bằng `data-ui="<id>"` để test và truy vết.

### 0.2 Quyết định đã duyệt (ràng buộc)

- **Approach A**: token Stitch → CSS custom properties trong `src/app/globals.css`. Không Tailwind, không UI lib.
- **Shell**: header 56px + sidebar 224px chỉ với route thật: Lịch sử, Clone mới, Cài đặt AI; dưới `/p/[id]` thêm khối dự án Tiến độ / Sitemap / Preview / Editor / Code.
- **Primary** = token Stitch xuất ra (`#c0c1ff` primary, `#8083ff` primary-container…). Bỏ ghi chú "indigo #6366F1" trong `stitch-screens.md`.
- **Icon**: Material Symbols Outlined tự host, subset đóng gói lúc build, không CDN lúc chạy. Nút chỉ có icon bắt buộc `aria-label` + `title`.
- **Phạm vi**: toàn bộ gap (a) — 22 mục visual/layout; toàn bộ gap (b) — 27 mục UI thiếu cho tính năng đã có (kể cả "small API tweak"); từ gap (c) **chỉ**:
  - c13 lịch sử log bền (event tail bounded trên đĩa, replay khi SSE connect / tải trang);
  - c20 "Chạy lại QA" sau khi lưu editor (xóa `stale`);
  - c7 HTTP status + thời gian phản hồi mỗi route trong sitemap (ghi lúc crawl);
  - c1 latency + HTTP code khi Test provider;
  - c8 + c9 ước tính token + thời gian chạy cho các trang đã chọn (**không USD**).
- **Ngoài phạm vi (không làm)**: ignore/accept section, abort clone, chi phí USD, chế độ DOM Delta, callout chẩn đoán fix (box-metric, giá trị thuộc tính), bộ đếm asset queue, stat số node DOM, route inspect DOM, cache model / default model / role matrix toàn cục, ping/robots line ở `/new`, Configure Rules, tab Failed / rows-per-page / regex ở lịch sử.
- **Drift**: 30 `drift_*` hiện có giữ nguyên loại trừ; các trang trí Stitch chưa có trong danh sách (gap §3(d) + các ô "decor" ở bảng từng màn) thành drift mới (§5).

### 0.3 Quyết định phát sinh trong spec này (cần người dùng xác nhận)

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Icon là **SVG path subset** sinh từ `@material-symbols/svg-400` (devDependency) vào file `src/app/_ui/icons.gen.ts` được commit; không dùng font ligature. | Cùng bộ glyph Material Symbols Outlined; không FOUT, không để lộ chữ ligature cho screen reader, chỉ bundle icon thực dùng (74 icon ≈ 30KB), không cần công cụ subset font. |
| D2 | Nút filled primary = nền `primary #c0c1ff` + chữ `on-primary #1000a9` (hover `primary-fixed #e1e0ff`); `primary-container #8083ff` + `on-primary-container #0d0096` dùng cho accent fill (hàng chọn, badge đếm của tab đang chọn, file đang mở). | 8/11 mockup dùng `bg-primary text-on-primary` cho CTA; settings/code-viewer dùng `primary-container` cho vùng chọn. Contrast chữ ≥ 7:1 cả hai. |
| D3 | "Chạy lại QA" chạy qua **job queue** như task `qa:rescore` (status `completed → running → completed`), chỉ chấm điểm, **không** mở fix loop. | Giữ giới hạn "1 job chạy đồng thời" (§1 spec SP1), tái dùng checkpoint/pause/SSE sẵn có; không để AI tự sửa đè lên chỉnh tay. |
| D4 | Danh sách drift chính thức chuyển vào `docs/superpowers/design/stitch-screens.md` (được commit); `.superpowers/sdd/.../drift-list.md` bị gitignore nên chỉ là bản local, cập nhật đồng bộ. | Nguồn sự thật phải nằm trong repo để graphify đọc được. |
| D5 | Mọi `JobEvent` được server đóng dấu `at` (epoch ms) trong `emit`; SSE gửi một message `history` đầu tiên. | Timestamp log là thật (không phải lúc client nhận); elapsed tính được từ event `status: running` mà không cần cột `started_at`. |
| D6 | "Khớp tổng" = **trung bình** điểm các section của trang × breakpoint đang xem; cổng đạt/không vẫn theo từng section (§9 spec SP1). | Khớp mockup "96.2% Match"; không đổi luật QA. |
| D7 | `POST /api/providers/test` nhận cùng union body với `/api/providers/models` (giá trị form chưa lưu **hoặc** `providerId`). | Nút "Test kết nối" trong form dùng được cả khi đang thêm provider mới. |
| D8 | `POST /api/projects/[id]/start` đóng cửa sổ đăng nhập đang mở trước khi chạy (giống `/crawl`). | Banner "Trang cần đăng nhập" ở sitemap mở cửa sổ; nếu không đóng, "Bắt đầu clone" luôn 409 `PROJECT_BUSY`. |
| D9 | Ngưỡng QA ở `/new`: slider 70–100 (mốc 70/85/95/100) **kèm** ô số 0–100 cùng state. | Giữ khả năng đặt mọi ngưỡng schema cho phép (0..1) mà vẫn có slider như Stitch. |
| D10 | Sitemap không vẽ hàng "origin" (ORIGIN badge); origin nằm ở chip trong page header. Folder ảo chỉ tạo cho prefix không phải là trang và có ≥2 trang con. | Hàng origin trùng chip header và trùng "Chọn tất cả". |

### 0.4 Nguyên tắc giữ nguyên (không được phá)

- Clone tất định, QA gate, fix loop, checkpoint, không auto-resume: không đổi. Thay đổi backend chỉ là 6 mục ở §4.
- `core/` không import `app/`. File mới ở core (`estimate.ts`, `event-log.ts`) không import `app/`; `estimate.ts` thuần (client import được như `statuses.ts`).
- Mọi route mới đi qua `handle()` (Host loopback + CSRF: Origin cùng host, body phải `application/json`), `requireProject`, `requireStatus`, `exclusive()` (busy guard).
- Secret (API key, mật khẩu, cookie) không vào event, log file, response, DOM (ngoài giá trị người dùng đang gõ).
- Workload bounded: mọi danh sách mới đều có trần (§4.8).

---

## 1. Design tokens

Nguồn: khối `<script id="tailwind-config">` của mọi mockup (đã so sánh: 11 file cùng giá trị). Khai báo trong `:root` của `src/app/globals.css`, tiền tố `--c-` (màu), `--t-` (chữ), `--r-` (radius), `--s-` (spacing). **Chỉ khai báo token thực dùng**; token Stitch không dùng ghi "—" ở cột CSS và không vào code.

### 1.1 Màu

| Token Stitch | Giá trị | CSS var | Dùng cho |
|---|---|---|---|
| `background` | `#10131a` | `--c-bg` | nền `body`, `main` |
| `surface` | `#10131a` | — (= `--c-bg`) | |
| `surface-dim` | `#10131a` | — (= `--c-bg`) | |
| `surface-container-lowest` | `#0b0e15` | `--c-surface-lowest` | header, sidebar, nền log, nền code pane, nền input URL lớn |
| `surface-container-low` | `#191c23` | `--c-surface-low` | card/panel, hover nav |
| `surface-container` | `#1d2027` | `--c-surface` | band header bảng, input thường, segmented đang chọn, icon-button hover |
| `surface-container-high` | `#272a31` | `--c-surface-high` | nút secondary, hàng hover, tooltip |
| `surface-container-highest` | `#32353c` | `--c-surface-highest` | nav item active, track progress bar |
| `surface-variant` | `#32353c` | — (= `--c-surface-highest`); border input dùng `--c-surface-highest` | |
| `surface-bright` | `#363941` | `--c-surface-bright` | hover của nút secondary |
| `surface-tint` | `#c0c1ff` | — | |
| `on-surface` | `#e0e2ec` | `--c-text` | chữ chính |
| `on-background` | `#e0e2ec` | — (= `--c-text`) | |
| `on-surface-variant` | `#c7c4d7` | `--c-text-2` | chữ phụ, label, icon mặc định |
| `outline` | `#908fa0` | `--c-text-3` | chữ cấp 3, placeholder, hint, border mạnh (nút ghost khi focus) |
| `outline-variant` | `#464554` | `--c-border` | mọi divider/border 1px |
| `primary` | `#c0c1ff` | `--c-primary` | nền CTA filled, chữ tab/nav active, link, focus ring, thanh tiến độ running |
| `on-primary` | `#1000a9` | `--c-on-primary` | chữ trên CTA filled |
| `primary-fixed` | `#e1e0ff` | `--c-primary-hover` | hover CTA filled |
| `primary-fixed-dim` | `#c0c1ff` | — | |
| `primary-container` | `#8083ff` | `--c-accent` | accent fill: hàng/file đang chọn (viền trái), badge đếm tab active, slider thumb |
| `on-primary-container` | `#0d0096` | `--c-on-accent` | chữ trên accent fill |
| `inverse-primary` | `#494bd6` | `--c-accent-strong` | viền hàng đang chọn (settings endpoint, file tree) |
| `on-primary-fixed`, `on-primary-fixed-variant` | `#07006c`, `#2f2ebe` | — | |
| `secondary` | `#4ae176` | `--c-success` | pill completed, điểm đạt, bước xong, dot OK |
| `secondary-container` | `#00b954` | — | |
| `secondary-fixed`, `secondary-fixed-dim` | `#6bff8f`, `#4ae176` | — | |
| `on-secondary`, `on-secondary-container`, `on-secondary-fixed`, `on-secondary-fixed-variant` | `#003915`, `#004119`, `#002109`, `#005321` | — | |
| `tertiary` | `#ffb95f` | `--c-warn` | needs_auth / interrupted, banner đăng nhập, nền nút warn |
| `on-tertiary-container` | `#3e2400` | `--c-on-warn` | chữ trên nút warn (Stitch: `bg-tertiary text-on-tertiary-container`) |
| `tertiary-container` | `#ca8100` | — | |
| `tertiary-fixed`, `tertiary-fixed-dim` | `#ffddb8`, `#ffb95f` | — | |
| `on-tertiary`, `on-tertiary-fixed`, `on-tertiary-fixed-variant` | `#472a00`, `#2a1700`, `#653e00` | — | |
| `error` | `#ffb4ab` | `--c-danger` | pill failed, điểm chưa đạt, lỗi, nút xóa (chữ) |
| `error-container` | `#93000a` | `--c-danger-strong` | nền alert lỗi đậm (confirm xóa) |
| `on-error-container` | `#ffdad6` | `--c-on-danger` | chữ trên `--c-danger-strong` |
| `on-error` | `#690005` | — | |
| `inverse-surface`, `inverse-on-surface` | `#e0e2ec`, `#2d3038` | — | |

Tint trạng thái (pill, banner, hàng tô màu) theo mẫu Stitch `bg-{c}/10 border-{c}/30 text-{c}`:
`background: color-mix(in srgb, var(--c-x) 10%, transparent); border: 1px solid color-mix(in srgb, var(--c-x) 30%, transparent); color: var(--c-x)`. Hàng được tô (needs_auth) dùng 5%.

Xóa khỏi `globals.css`: `--bg --surface --surface-2 --border --text --muted --primary --primary-soft --ok --warn --bad --radius --gap`, link `#a5b4fc`, các hex lẻ `#fca5a5 #86efac #07090d`.

### 1.2 Kiểu chữ

Font giữ nguyên (next/font tự host, subset latin + vietnamese): Space Grotesk `--font-head`, Inter `--font-body`, JetBrains Mono `--font-mono`.

| Token Stitch | Cỡ / line-height / weight | Family | CSS var (shorthand `font`) | Dùng cho |
|---|---|---|---|---|
| `headline-lg` | 28px / 36px / 600 | Space Grotesk | `--t-headline-lg` | tiêu đề trang (h1) |
| `headline-md` | 22px / 28px / 600 | Space Grotesk | `--t-headline-md` | tiêu đề card lớn (settings) |
| `headline-sm` | 18px / 24px / 600 | Space Grotesk | `--t-headline-sm` | tiêu đề card/panel (h2), CTA lớn ở `/new` |
| `body-lg` | 16px / 24px / 400 | Inter | `--t-body-lg` | subtitle trang |
| `body-md` | 14px / 20px / 400 | Inter | `--t-body-md` | chữ mặc định `body` |
| `body-sm` | 12px / 16px / 400 | Inter | `--t-body-sm` | hint, subtitle hàng, mô tả vai trò |
| `label-md` | 13px / 18px / 500 | JetBrains Mono | `--t-label-md` | nhãn nút, nav, input, URL, số liệu, breadcrumb, segmented |
| `label-sm` | 11px / 14px / 500 | JetBrains Mono | `--t-label-sm` | pill, badge, header cột bảng (UPPERCASE, letter-spacing 0.05em), counter, suffix đơn vị |

Mỗi token kèm 1 class tiện ích cùng tên (`.t-headline-lg` … `.t-label-sm`) — 8 class, không hơn. Quy tắc mono (theo Stitch): nav item, nhãn nút, header cột, pill, badge, counter, breadcrumb, URL, số (%, token, ms, KB), log. Văn xuôi (mô tả, hint, banner) dùng Inter.

### 1.3 Radius

| Token Stitch | Giá trị | CSS var | Dùng cho |
|---|---|---|---|
| `DEFAULT` | 2px | `--r-sm` | pill, badge, nút, input, checkbox, segmented item |
| `lg` | 4px | `--r-md` | card nhỏ, segmented container, thumbnail, popover |
| `xl` | 8px | `--r-lg` | card/panel lớn, card `/new`, banner |
| `full` | 12px | `--r-full` | dot trạng thái (6–8px → tròn), slider thumb |

### 1.4 Spacing và mật độ

| Token Stitch | Giá trị | CSS var |
|---|---|---|
| `space-xs` | 4px | `--s-xs` |
| `space-sm` | 8px | `--s-sm` |
| `space-md` | 12px | `--s-md` |
| `space-lg`, `gutter`, `margin` | 16px | `--s-lg` |
| `space-xl` | 24px | `--s-xl` |

Mật độ (gap a22): control cao 30px (`padding: 6px 12px` + line-height 18px của `label-md`); icon-button 28×28 (`padding: 6px`, icon 16px); input nhỏ trong bảng 28px; hàng bảng tối thiểu 44px (lịch sử có thumbnail: 64px); gap mặc định giữa khối 12px (`--s-md`), giữa section trang 16px; padding `main` 16px; padding card 16px (header card 12px 16px). Không còn `max-width: 1400px` — layout fluid.

Motion: `running` = dot `animate-ping` (keyframe scale 1→2, opacity 1→0, 1s), nút `:active { transform: scale(0.98) }`. `@media (prefers-reduced-motion: reduce)` tắt cả hai.

Focus: `:focus-visible { outline: 2px solid var(--c-primary); outline-offset: 1px }`; input focus: `border-color: var(--c-primary); box-shadow: 0 0 0 1px var(--c-primary)`.

### 1.5 Icon

- Gói: `@material-symbols/svg-400` (Apache-2.0), **devDependency**, bản Outlined, viewBox `0 -960 960 960`.
- Script `scripts/gen-icons.mjs` (npm script `icons`): đọc danh sách tên cố định trong script, lấy thuộc tính `d` của mỗi `outlined/<name>.svg`, ghi `src/app/_ui/icons.gen.ts` = `export const ICONS = { name: "d…" } as const; export type IconName = keyof typeof ICONS;`. File sinh ra được commit (build không cần mạng, không cần chạy script). Tên thiếu trong gói → script exit 1.
- Component `Icon` (§2.2) render `<svg aria-hidden="true" focusable="false" fill="currentColor">`; kích thước 16 (mặc định), 14 (trong pill), 20 (header trang, section header `/new`).
- Subset (74 icon), nguồn tên theo `data-icon` trong mockup (trừ panel Component của editor E2, không có mockup):
  - shell/nav: `history`, `add`, `settings`, `timeline`, `account_tree`, `difference`, `edit`, `code`
  - chung: `search`, `refresh`, `open_in_new`, `content_copy`, `visibility`, `visibility_off`, `expand_more`, `chevron_right`, `chevron_left`, `close`, `check`, `remove`, `more_vert`, `arrow_forward`, `undo`, `redo`, `save`
  - trạng thái: `check_circle`, `cancel`, `pause_circle`, `warning`, `lock`, `error`, `schedule`, `draft`
  - hành động dự án: `pause`, `play_arrow`, `replay`, `delete`, `download`, `folder_zip`, `drive_folder_upload`, `bolt`, `hub`, `add_circle`, `block`
  - `/new`: `language`, `radar`, `generating_tokens`, `output`
  - stepper: `task_alt`, `photo_camera`, `image`, `schema`, `badge`, `auto_fix_high`
  - preview: `phone_iphone`, `tablet_mac`, `desktop_windows`, `view_column_2`, `opacity`, `compare`, `layers`
  - code viewer: `folder`, `folder_open`, `description`, `html`, `css`, `javascript`, `data_object`, `format_list_numbered`, `wrap_text`
  - sitemap: `unfold_more`, `unfold_less`
  - editor, panel Component (E2 §7, sắp xếp bằng bàn phím): `arrow_upward`, `arrow_downward`
- A11y: icon trang trí luôn `aria-hidden`; nút chỉ có icon (`IconButton`) bắt buộc prop `label` → render `aria-label={label}` + `title={label}` (TypeScript bắt buộc, không optional).

---

## 2. App shell + component dùng chung

### 2.1 App shell (`src/app/layout.tsx` + `src/app/_ui/Shell.tsx`)

| ui_id | Stitch (mockup + vùng) | Copy | Hành vi | Nguồn | Nghiệm thu |
|---|---|---|---|---|---|
| `ui_shell_header` | mọi mockup, header `h-14` `bg-surface-container-lowest border-b` | brand "AI Web Clone" | `position: fixed; top:0; height:56px; z-index` trên sidebar; brand là link `/` (`t-headline-sm`, icon `code` 20px) | — | cao đúng 56px; không có bell/avatar/terminal/Docs/version chip (drift §5) |
| `ui_shell_new_clone_cta` | header phải, "+ New Clone" (`bg-primary`) | "Clone mới" (icon `add`) | link `/new`, style Button primary | route `/new` | click → `/new` |
| `ui_shell_settings_link` | header phải, icon `settings` | aria-label/title "Cài đặt AI" | IconButton-link `/settings/ai`; `aria-current="page"` khi đang ở đó | route | có `aria-label` |
| `ui_shell_sidebar_nav` | sidebar `w-56` `border-r` (history-alt3 trái) — chỉ giữ khung | nhóm "Chung": "Lịch sử" (`history`), "Clone mới" (`add`), "Cài đặt AI" (`settings`) | `position: fixed; top:56px; left:0; width:224px; height: calc(100vh - 56px)`; item `t-label-md` mono, cao 32px, active = nền `--c-surface-highest` + chữ `--c-primary` + viền trái 2px `--c-primary`, `aria-current="page"`; <1024px thu về rail 56px chỉ icon (tên thành `title` + `aria-label`) | `usePathname()` | chỉ đúng 3 item; không Engines/DOM Rules/Telemetry/… |
| `ui_shell_project_nav` | sidebar (không có tương đương thật trong Stitch) | nhóm "Dự án": "Tiến độ" (`timeline`) `/p/[id]`, "Sitemap" (`account_tree`), "Preview" (`difference`), "Editor" (`edit`), "Code" (`code`) | chỉ hiện khi pathname khớp `/p/<id>`; `Sidebar` là client component đọc `usePathname()`; thay cho các hàng link con ở header từng trang (bỏ hết `nav aria-label="Dự án"` cũ) | route | 5 link đúng id dự án; active đúng màn |
| `ui_shell_page_header` | vùng tiêu đề trang (sitemap "Pipelines / Task #8942 / …", settings breadcrumb) | breadcrumb dạng `Lịch sử / <host+path> / <Tên màn>` | component `PageHeader` (§2.2); `main` có `padding: 72px 16px 16px 240px` (56+16, 224+16) | — | breadcrumb không chứa "Task #", "Pipelines" |

Shell không có footer/status bar (mọi footer Stitch là telemetry drift).

### 2.2 Component `src/app/_ui/`

Mỗi component là 1 file, props tối thiểu, không state toàn cục. CSS của component nằm trong `globals.css` (mục có tên component).

| Component | Props | Hành vi / a11y |
|---|---|---|
| `Icon` | `name: IconName; size?: 14\|16\|20` | SVG `aria-hidden`, `fill: currentColor` |
| `Button` | `variant: "primary"\|"secondary"\|"warn"\|"danger"\|"ghost"; icon?: IconName; iconEnd?: IconName; size?: "md"\|"lg"; ...button/Link props (`href` → `next/link`)` | nhãn `t-label-md` mono; primary = `--c-primary`/`--c-on-primary`, hover `--c-primary-hover`; secondary = `--c-surface-high` + border `--c-border`, hover `--c-surface-bright`; warn = `--c-warn`/`--c-on-warn`; danger = secondary với chữ `--c-danger`; ghost = trong suốt, hover `--c-surface`; `disabled` opacity .45; `:active` scale .98 |
| `IconButton` | `icon: IconName; label: string; tone?: "default"\|"danger"\|"success"\|"warn"; href?` | 28×28, ghost; `aria-label` + `title` = `label` (bắt buộc) |
| `StatusPill` (thay `StatusPill.tsx`) | `status: ProjectStatus; queued?: boolean` | `inline-flex gap 4px; padding 2px 8px; --r-sm; t-label-sm`; tint theo §1.1; icon: draft `draft` (text-2), running = dot ping `--c-primary`, paused `pause_circle` (text-2), interrupted `warning` (warn), needs_auth `lock` (warn), failed `cancel` (danger), completed `check_circle` (success); `queued` thêm pill "đang chờ" (`schedule`, primary). **Chữ luôn là mã trạng thái** (spec §4), màu chỉ bổ trợ |
| `Badge` | `tone; children` | như pill không icon; dùng cho count, kind, "SP2", "Layout chung" |
| `SegmentedControl` | `label: string; options: {value, label, icon?, count?, disabled?}[]; value; onChange; semantics?: "toggle"\|"tabs"` | container `--c-surface-lowest` border `--c-border` `--r-md` padding 2px; item chọn = `--c-surface` + chữ `--c-primary` (+ gạch dưới 2px `--c-primary` khi `tabs`); `toggle` → `role="group" aria-label` + `aria-pressed`; `tabs` → `role="tablist"`, item `role="tab" aria-selected`, ←/→ chuyển tab; `count` hiện Badge (active: `--c-accent`/`--c-on-accent`) |
| `GridTable` | `label: string; columns: {key, header, width}[]; rows; rowKey; renderCell; rowTone?(row)` | `role="table"` + `role="row"/"columnheader"/"cell"` trên `div` (CSS grid `grid-template-columns` từ `width`); band header `--c-surface`, `t-label-sm` UPPERCASE `--c-text-2`; hàng border-bottom `--c-border`, hover `--c-surface-low`; `rowTone` tô 5% warn/danger |
| `PageHeader` | `crumbs: {label, href?}[]; title; subtitle?; meta?: ReactNode; actions?: ReactNode` | breadcrumb `nav aria-label="Breadcrumb"` `t-label-md` `--c-text-3`, crumb cuối `--c-primary` `aria-current="page"`; title `h1 t-headline-lg`; subtitle `t-body-lg --c-text-2`; `meta` (chip URL, pill) cạnh title; `actions` canh phải; border-bottom `--c-border` |
| `UrlChip` | `url; openable?: boolean; copyable?: boolean; extra?: ReactNode` | chip mono `--c-surface-lowest` border; `openable` → IconButton `open_in_new` "Mở trang gốc trong tab mới" (`<a target="_blank" rel="noopener noreferrer">`); `copyable` → IconButton `content_copy` "Sao chép URL" (`navigator.clipboard.writeText`, thành công → `title` đổi "Đã sao chép" 2s) |
| `Card` | `title?; icon?: IconName; hint?: ReactNode; actions?; children` | `--c-surface-low` border `--r-lg`; header 12px 16px, `t-headline-sm` hoặc `t-label-md` UPPERCASE (khi `variant="section"`), `hint` canh phải `t-label-sm --c-text-3` |
| `Field` | `label; hint?; suffix?: string; children (input)` | `label` bao input (a11y); suffix đơn vị trong ô (`t-label-sm --c-text-3`, vd "trang", "ms", "token") |
| `SearchInput` | `label; placeholder; value; onChange; onSubmit?` | icon `search` trái, `type="search"`, `aria-label=label` |
| `PasswordInput` | input props | nút `visibility`/`visibility_off` "Hiện mật khẩu"/"Ẩn mật khẩu" (`aria-pressed`) đổi `type` password↔text; chỉ hiện giá trị người dùng đang gõ, không bao giờ nhận giá trị lưu từ server |
| `StatTile` | `label; value; tone?` | `t-label-sm` label + `t-label-md` value, border `--c-border` `--r-md` |
| `ProgressBar` | `value: 0..100; status: ProjectStatus; label` | `role="progressbar"` + aria-value*; track `--c-surface-highest` 4px; màu: running primary, needs_auth/interrupted warn, failed danger, completed success, còn lại `--c-text-3` |
| `Banner` | `tone: "warn"\|"danger"\|"info"; icon; title?; children; actions?; role?` | icon tile 32px tint; tint 10% + border 30%; `role="alert"` khi warn/danger |
| `RelTime` | `at: number (epoch s hoặc ms qua prop unit)` | `<time dateTime title={absolute vi-VN}>`; SSR/hydrate render ngày tuyệt đối, sau mount đổi sang `Intl.RelativeTimeFormat("vi", {numeric:"auto"})` ("12 giây trước", "hôm qua"), cập nhật mỗi 30s bằng 1 interval chung của module (không mỗi instance 1 timer) |
| `LogView` | `lines: LogLine[]` (+ các control §3.6) | `role="log" aria-live="polite"`; mono `t-label-md`; dòng warn/error: nền 5% + viền trái 2px |
| `Disclosure` | `summary; children; defaultOpen?` | `<details>/<summary>` có icon `chevron_right` xoay 90° khi mở |
| `format.ts` | `fmtInt(n)` (`vi-VN`: "2.000.000"), `fmtPct(0..1, digits=1)` ("96,2%"), `fmtTokens(n)` ("1,2M", "140k", "950"), `fmtBytes(n)` ("18,6 KB"), `fmtDuration(ms)` ("00:04:12"), `fmtMinutes(s)` ("<1 phút", "~6 phút") | thuần, unit test |
| `download.ts` | `downloadZip(projectId, stripIds)` | tách từ `export-panel.tsx` (POST JSON → blob → `<a download>`), dùng chung cho code viewer và lịch sử |

`api.ts` giữ nguyên. Mọi component thêm `data-ui` khi được truyền (`...rest` đẩy xuống root element).

---

## 3. Từng màn

Quy ước bảng: **Stitch** = file mockup + vùng; **Copy** = chữ UI chính xác (tiếng Việt; tên tính năng spec giữ nguyên tiếng Anh khi spec quy định); **Nguồn** = API/core (đã có, hoặc **MỚI** tham chiếu §4). Mọi element root có `data-ui="<ui_id>"`. Mục gap tương ứng xem ma trận §3.10.

### 3.1 `/settings/ai` — `screen_settings_ai` (mockup `settings-ai.png|html`)

Layout: `PageHeader` + lưới 2 cột `minmax(0, 5fr) minmax(0, 7fr)` gap 16px: trái = danh sách endpoint, phải = form cấu hình (luôn hiện; khi chưa chọn gì hiện trạng thái rỗng "Chọn một endpoint để sửa, hoặc thêm mới."). <1100px xếp dọc.

| ui_id | Stitch | Copy | Hành vi | Nguồn | Nghiệm thu |
|---|---|---|---|---|---|
| `ui_settings_ai_page_header` | vùng tiêu đề trên cùng (breadcrumb, title, mô tả) | crumbs "Cài đặt / AI Gateway & Provider"; title "AI Gateway & Provider"; subtitle "Thêm endpoint tương thích Anthropic hoặc OpenAI, lấy danh sách model, Test kết nối và gán model cho từng vai trò." | không badge version/ROUTER ACTIVE | — | không có chữ "v2.4-gateway", "ROUTER ACTIVE", "proxy keys" |
| `ui_settings_ai_add_provider_buttons` | góc phải header: "Add Anthropic Compatible" (viền amber, `hub`), "Add OpenAI Compatible" (indigo, `add_circle`) | "Add Anthropic Compatible", "Add OpenAI Compatible" (copy bắt buộc, spec §2) | Anthropic = Button secondary chữ/viền `--c-warn` + icon `hub`; OpenAI = Button primary + `add_circle`; click mở form thêm ở cột phải (kind cố định) | `POST /api/providers` (khi lưu) | đúng 2 nút, đúng copy |
| `ui_settings_ai_endpoint_list` | card trái "Configured Endpoints" + badge 4 | title "Endpoint đã cấu hình" + Badge số lượng; rỗng: "Chưa có provider nào." | Card; danh sách = `GET /api/providers` (≤100) | `GET /api/providers` | badge = số provider |
| `ui_settings_ai_endpoint_filter` | ô lọc dưới title card | placeholder "Lọc theo tên hoặc base URL…" | SearchInput, lọc client-side (substring, không phân biệt hoa thường) trên `name`, `baseUrl`, model đã gán | client | lọc tức thời; không gọi API |
| `ui_settings_ai_endpoint_row` | mỗi hàng: dot, tên, badge kind, "24ms", key che, bolt, kebab; hàng đang sửa có thanh accent trái | tên; Badge "ANTHROPIC"/"OPENAI"; key che `sk-…abcd`; latency lần Test gần nhất "182 ms"; chưa test: "chưa test" | dot: xanh = Test gần nhất OK, đỏ = lỗi, xám = chưa test (state client trong phiên, không lưu); hàng đang mở trong form: viền trái 2px `--c-accent-strong` + nền `--c-surface`; click hàng = mở form Sửa | `GET /api/providers` + state Test | chỉ 2 kind; không VLLM/OLLAMA; không hiện key thật |
| `ui_settings_ai_test_endpoint` | bolt trên hàng + nút xanh "Test Endpoint" và dòng "Connection verified: latency 182ms • HTTP 200" trong form | IconButton `bolt` "Test"; trong form Button secondary (chữ `--c-success`) "Test kết nối"; kết quả OK: "Kết nối OK · 182 ms · HTTP 200 · 14 model"; lỗi: thông điệp server (có mã + status HTTP) | đang chạy: "Đang test…", nút disabled; kết quả lưu vào state hàng (dot + latency); form: dùng `providerId` nếu đang sửa và chưa gõ key mới, ngược lại gửi giá trị form | **MỚI** §4.5 (`latencyMs`, `httpStatus`, body union) | test form chưa lưu chạy được; hiện ms + HTTP code |
| `ui_settings_ai_row_menu` | kebab `more_vert` trên hàng | IconButton `more_vert` "Thao tác"; menu: "Sửa", "Xóa" | menu `role="menu"` (Esc/click ngoài đóng, focus trả về nút); "Xóa" → `confirm("Xóa provider <tên>?")` → DELETE, nếu đang sửa provider đó thì đóng form | `PATCH`/`DELETE /api/providers/[id]` | xóa cần xác nhận; bàn phím dùng được |
| `ui_settings_ai_config_panel` | card phải "Provider Configuration — [Edit: …]" | title "Thêm Anthropic Compatible" / "Thêm OpenAI Compatible" / "Sửa: <tên>" | Card cột phải, là `<form>`; không có dòng "ID: … // status: 200 OK" | — | không hiện id nội bộ |
| `ui_settings_ai_display_name` | "Provider Display Name" | label "Tên hiển thị" | required, max 100 | `name` | |
| `ui_settings_ai_protocol` | "Protocol Standard" = "Anthropic Messages API (v1) LOCKED" | label "Chuẩn API"; giá trị "Anthropic Messages API" / "OpenAI Chat Completions API" + icon `lock` + "cố định" | read-only (kind bất biến sau khi tạo) | `kind` | không sửa được kind |
| `ui_settings_ai_base_url` | "Upstream Base URL" + "Default: https://api.anthropic.com/v1" | label "Base URL"; hint phải "Mặc định: https://api.anthropic.com/v1" (openai: "https://api.openai.com/v1") | required, `type=url`, placeholder = mặc định | `baseUrl` | |
| `ui_settings_ai_api_key` | "Secret API Token" + mắt + "Stored with AES-256 GCM in local daemon vault." | label "API key"; hint "Key được mã hóa khi lưu và không bao giờ hiển thị lại."; khi sửa: placeholder "để trống = giữ key cũ" | PasswordInput (§2.2); không bao giờ điền key đã lưu | `apiKey` (chỉ gửi đi) | không có chữ "AES-256 GCM", "vault"; toggle chỉ lộ chữ đang gõ |
| `ui_settings_ai_fetch_models` | nút "Fetch Models" + "Cached 4 mins ago • 14 models found" | Button secondary `refresh` "Fetch models"; trạng thái "14 model" / "Chưa có danh sách model" | như hiện tại; không có "Cached…", "Sync: OK" | `POST /api/providers/models` | số model đúng |
| `ui_settings_ai_role_matrix` | card "Engine Role Assignment" (Vision/Code/Design, icon, mô tả, select) | title "Vai trò model"; hàng `visibility` "vision — Đặt tên section (1 lần gọi mỗi trang, kèm ảnh thu nhỏ)."; hàng `code` "code — Vòng sửa section chưa đạt QA (patch IR, tối đa 3 vòng); nhận ảnh nếu cùng model với vision."; hàng `edit` "design — Dành cho SP3, SP1 không dùng."; option rỗng "(không gán)"; ghi chú cuối "Khi chạy: dùng provider của dự án nếu nó phục vụ vai trò, nếu không dùng provider lưu gần nhất có vai trò đó." | nằm trong cùng `<form>` của provider đang sửa (roles lưu theo provider, không phải ma trận toàn cục); select disabled khi chưa Fetch models (giữ model đang gán làm option) | `roles` của provider | không badge High Precision/…; không nút "Save Routing Matrix"; không model id cứng |
| `ui_settings_ai_save_provider` | "Discard Changes" / "Save Provider" | "Hủy thay đổi" (secondary, đóng form) / "Lưu provider" (primary) | submit → POST/PATCH → reload danh sách | `POST /api/providers`, `PATCH /api/providers/[id]` | |

Không hiện: HTTP Pool, Failover, Upstream Telemetry, footer gateway, Default Primary Model (`ui_settings_ai_default_model` ngoài phạm vi).

### 3.2 `/` Lịch sử — `screen_history` (mockup `history-alt3.png` là chuẩn, tham khảo `history*.png`)

| ui_id | Stitch | Copy | Hành vi | Nguồn | Nghiệm thu |
|---|---|---|---|---|---|
| `ui_history_page_header` | title "Project History" + "24 recorded" | crumbs "Lịch sử"; title "Lịch sử dự án"; meta Badge "<total> dự án" | badge = `counts.incomplete + counts.completed` (theo bộ lọc tìm kiếm `q` hiện tại) | **MỚI** `counts` §4.7 | |
| `ui_history_status_tabs` (gộp `ui_history_vi_status_tabs`) | tab "Chưa hoàn thành 4 / Đã hoàn thành 18" (alt3 trái) | "Chưa hoàn thành" [n], "Đã hoàn thành" [n] | SegmentedControl `semantics="tabs"` có count; đổi tab → page 1 | **MỚI** `counts` (tôn trọng `q`) | badge khớp số dòng thực |
| `ui_history_url_search` (gộp `ui_history_search`) | ô "search by URL" icon kính lúp | aria-label "Tìm theo URL"; placeholder "Tìm theo URL…" | Enter → `q` (substring, không regex), page 1 | `GET /api/projects?q=` | |
| `ui_history_refresh` | nút `refresh` cạnh bộ lọc | IconButton `refresh` "Tải lại" | gọi lại GET hiện tại | `GET /api/projects` | |
| `ui_history_job_rows` | bảng: header band "TARGET SOURCE & PREVIEW / STATUS / EXECUTION PHASE & METRICS / ACTIONS" | cột "NGUỒN & XEM TRƯỚC", "TRẠNG THÁI", "PHA & TIẾN ĐỘ", "THAO TÁC" | GridTable, 20 dòng/trang; `rowTone`: needs_auth → warn 5% | `GET /api/projects` | |
| `ui_history_row_thumb` | thumbnail 100×64 (+ badge DOM/SPA… → drift) | alt "" | ảnh `pages/<thumbPage>/shots/1440.png`, không có → khung trống; không badge loại trang | `thumbPage` | không có chữ DOM/SPA/AUTH/HTML/ERR |
| `ui_history_row_url` | URL mono + `open_in_new` | URL | UrlChip-lite (mono `t-label-md`, không nền) + IconButton `open_in_new` "Mở trang gốc trong tab mới" | `url` | link `rel="noopener noreferrer"` |
| `ui_history_row_subtitle` | "Target: DOM + CSS Assets • 42 pages queued • Started 2m ago" | "<Crawl\|1 trang> · <n> trang · bắt đầu <RelTime createdAt>"; draft chưa chọn trang: "<mode> · chưa chọn trang · tạo <RelTime>" | `t-body-sm --c-text-2` | `mode`, **MỚI** `pageCount`, `createdAt` | không có chữ "Target:" |
| `ui_history_failed_error_log` | dòng đỏ "Exit code: E_CORS_BLOCKED • 403 Forbidden" + nút Error Log | failed: "<CODE>: <message>" (`--c-danger`, 1 dòng, cắt …) + Disclosure "Chi tiết lỗi" (message đầy đủ ≤500 ký tự, pha/key); không có task lỗi: "Lỗi — mở dự án để xem log" | chỉ với `status=failed` | **MỚI** `lastError` §4.7 | message đã redact; không nút "Trace"/terminal |
| `ui_history_needs_auth_status` | hàng amber, pill `lock`, "Session cookies required" | subtitle thay bằng "Cần đăng nhập (<CODE>) — mở dự án để đăng nhập" (`--c-warn`) | `rowTone` warn; nút Tiếp tục/Mở dẫn tới `/p/[id]` (banner ở đó) | `status`, `lastError.code` | không "Inject Auth", không "Cloudflare/Turnstile" |
| `ui_history_status_pill` | cột STATUS | mã trạng thái | StatusPill (§2.2), `queued` → "đang chờ" | `status`, `queued` | 7 trạng thái + đang chờ có icon |
| `ui_history_progress_bar` | "capture 13/20 assets 65%" + thanh màu + "Updated 12s ago" | dòng 1: "<phase> <done>/<total>" trái, "<progress>%" phải (completed: "xong"); ProgressBar; dòng 2: "Cập nhật <RelTime updatedAt>" | màu theo status (§2.2 ProgressBar) | `phase`, **MỚI** `phaseDone`/`phaseTotal`, `progress`, `updatedAt` | không chữ "assets" giả |
| `ui_history_row_actions` | cột ACTIONS: dãy icon | — | nhóm IconButton theo thứ tự: pause, resume, open, clone lại, download, delete (chỉ hiện nút hợp lệ với status) | — | mọi icon có `aria-label` + `title` |
| `ui_history_pause_button` | `pause` trên hàng running | "Tạm dừng" | `status=running` → POST pause | `POST …/pause` | |
| `ui_history_resume_button` (gộp `ui_history_interrupted_resume`) | `play_arrow` trên paused/interrupted | "Tiếp tục" (tone warn khi interrupted) | `RESUMABLE_STATUSES`; `needsCredentials` hoặc `needs_auth` → link `/p/[id]` (màn tiến độ hỏi tài khoản / banner), ngược lại POST resume | `POST …/resume` | |
| `ui_history_open_button` | `visibility` | "Mở" | draft → `/p/[id]/sitemap`, còn lại `/p/[id]` | route | |
| `ui_history_reclone_button` | `replay` | "Clone lại" | link `/new?from=<id>` | `/new` prefill | |
| `ui_history_download_export` | `download` trên hàng completed | "Tải ZIP" | chỉ `status=completed`; `downloadZip(id, false)`; đang tải: nút disabled; lỗi → alert trang | `POST …/export {mode:"zip"}` (busy guard có sẵn) | tải được file `<id>.zip` |
| `ui_history_delete_button` | `delete` | "Xóa" (tone danger) | `confirm("Xóa dự án <url>? Toàn bộ workspace (ảnh chụp, output) sẽ bị xóa.")` → DELETE | `DELETE /api/projects/[id]` | |
| `ui_history_pagination` | footer "Showing 1-6 of 24 projects" + số trang + Previous/Next | trái "Hiển thị <a>–<b> / <total> dự án"; phải "Trước", số trang, "Sau" | cửa sổ ≤7 số (1 … k-1 k k+1 … N), trang hiện tại `aria-current="page"` nền `--c-accent`; 20/trang cố định (không select rows) | `total`, `page`, `pageSize` | không có "Rows: 20 per page" |
| `ui_history_empty` | — | "Không có dự án nào." + Button "Clone mới" | khi danh sách rỗng | — | |

Không hiện: cluster/concurrency chips, "All Engines", tab Failed, footer daemon, icon copy/docs.

### 3.3 `/new` — `screen_new_clone` (mockup `new-clone.png|html`)

Layout: card giữa màn `max-width: 1000px`, `--r-lg`, padding 24px; mỗi nhóm có section header (icon 20px + `t-label-md` + hint phải `t-label-sm --c-text-3`); divider giữa nhóm.

| ui_id | Stitch | Copy | Hành vi | Nguồn | Nghiệm thu |
|---|---|---|---|---|---|
| `ui_new_clone_page_header` | "New Clone Configuration" + mô tả | crumbs "Clone mới"; title "Cấu hình clone mới"; subtitle "Nhập URL, chọn chế độ, cách đăng nhập, ngưỡng QA và ngân sách token." | không chip "TASK CONFIG / READY / DOM v3 Parser" | — | |
| `ui_new_clone_card` | card giữa | — | khung card + section headers như trên | — | rộng ≤1000px, giữa màn |
| `ui_new_clone_url_input` | "Website URL" (`language`), ô URL mono + icon copy + "HTTP/HTTPS Target" | header "URL trang web" hint "HTTP/HTTPS"; placeholder "https://example.com" | input lớn nền `--c-surface-lowest`, icon `language` trong ô, IconButton `content_copy` "Sao chép URL" trong ô; **không** nút Ping, **không** dòng robots/DNS | `url` | |
| `ui_new_clone_mode_toggle` | segmented "Single page / Crawl site" | "1 trang đầy đủ" (`description`), "Crawl nhiều trang" (`account_tree`) | SegmentedControl toggle, full width 2 cột | `mode` | |
| `ui_new_clone_crawl_limits` | card "CRAWL CONSTRAINTS" với hậu tố PGS/LVL/THRD | card title "GIỚI HẠN CRAWL"; "Số trang tối đa" [trang] 1–100; "Độ sâu" [cấp] 0–5; "Trang chụp song song" [trang] 1–5; "Delay giữa request" [ms] 0–10000 bước 100 | chỉ hiện khi mode crawl; Field có suffix, số canh giữa | `maxPages`, `depth`, `concurrency`, `delayMs` | không "Polite rate limiting active" |
| `ui_new_clone_auth_select` | "Authentication" (`lock`) + dropdown | header "Đăng nhập"; select: "Không", "Thủ công (tự đăng nhập trong cửa sổ Chrome)", "Tự động (tài khoản)" | `<select>` native full width | `auth.mode` | không "Session Cookie Vault" |
| `ui_new_clone_auth_credentials` | khối "Username / Email" + "Password" (mắt) | "Tài khoản", "Mật khẩu" (PasswordInput), checkbox "Ghi nhớ (mã hóa trên máy này)" | chỉ mode auto; required | `credentials` (RAM hoặc mã hóa nếu Ghi nhớ, spec §3) | toggle mắt hoạt động |
| `ui_new_clone_auth_selectors` | "› Optional selectors (Advanced)" | Disclosure "Selector form đăng nhập (tùy chọn)"; 3 ô "Selector ô tài khoản/ô mật khẩu/nút gửi" placeholder "CSS selector" | như hiện tại | `auth.selectors` | |
| `ui_new_clone_manual_login` | — (không có trong Stitch) | Banner info: "Mở cửa sổ Chrome, đăng nhập (tự xử lý CAPTCHA nếu có), rồi bấm Quét trang — cửa sổ sẽ được đóng trước khi quét."; "Mở cửa sổ đăng nhập" (secondary `open_in_new`), "Quét trang" (primary) | sau khi tạo dự án ở mode manual (giữ luồng hiện tại) | `POST …/auth/open`, `POST …/crawl` | không có gì tự giải CAPTCHA |
| `ui_new_clone_qa_threshold` | "QA threshold" + slider mốc 70/85/95/100 + badge "HIGH FIDELITY" + "95%" | header "Ngưỡng QA" + giá trị "95%" phải; mốc "70% (thoáng)", "85% (cân bằng)", "95% (chặt)", "100% (khớp pixel)"; ô số "Chính xác (%)" | range 70–100 bước 1 + ô số 0–100 cùng state (D9); không badge | `threshold` | kéo slider đổi ô số và ngược lại |
| `ui_new_clone_token_budget` | "Token budget" + "2,000,000 TOKENS" + helper | header "Ngân sách token" (`generating_tokens`); input placeholder "2.000.000 (mặc định)", suffix "token", hiển thị số có dấu chấm khi blur; hint "Dùng cho đặt tên section và vòng sửa QA. Hết ngân sách → dừng các bước AI, dự án vẫn hoàn thành." | rỗng = mặc định server | `tokenBudget` | không "Est. cost", không "$" |
| `ui_new_clone_output_format` | lưới card "HTML Clean DOM ACTIVE / React JSX SP2 / …" | header "Định dạng output" (`output`); card "HTML" + "HTML/CSS tĩnh" + Badge "Đang dùng"; card disabled "React", "Next.js", "Vue", "WordPress" mỗi cái Badge "SP2" | 5 card `role="radio"` trong `role="radiogroup"`, chỉ HTML chọn được (`aria-disabled` cho SP2) | HTML (SP1); SP2 = `feat_framework_emitters_sp2` (không build) | không Markdown, không Figma Tokens |
| `ui_new_clone_cancel` | "Cancel" | "Hủy" | Button secondary link `/` | — | |
| `ui_new_clone_preview_sitemap` | CTA "Preview sitemap →" (`radar`) | "Quét trang" (icon `radar` + `arrow_forward`, size lg); đang chạy: "Đang quét…" | submit: tạo dự án → crawl → `/p/[id]/sitemap` (manual: sang `ui_new_clone_manual_login`) | `POST /api/projects`, `POST …/crawl` | không "Save as preset" |
| `ui_new_clone_error` | — | alert lỗi + (nếu đã tạo) " — mở sitemap của dự án đã tạo" | như hiện tại | — | |

Không hiện: footer PIPELINE/EST. TIME/CLUSTER, sidebar Project Alpha/Engines/…

### 3.4 `/p/[id]/sitemap` — `screen_sitemap` (mockup `sitemap.png|html`)

Layout: `PageHeader`; dải công cụ 2 hàng (hàng 1: Chọn tất cả + counter/estimate trái, search + Mở hết/Thu gọn phải; hàng 2: filter tabs); bảng cây; banner đăng nhập (có điều kiện); action bar dính đáy; Disclosure phiên đăng nhập. Trang ≤100 → mọi lọc/cây chạy client.

| ui_id | Stitch | Copy | Hành vi | Nguồn | Nghiệm thu |
|---|---|---|---|---|---|
| `ui_sitemap_page_header` | breadcrumb + "Select pages to clone" + chip origin "https://stripe.com • 34 routes crawled • 18 cached" | crumbs "Lịch sử / <host> / Sitemap"; title "Chọn trang để clone"; meta StatusPill; chip phải UrlChip(origin, openable) + "<n> trang · <m> đã chụp"; khi không phải draft: link "Xem tiến độ" | — | `project`, `discover.json`, capture dates | không "Stage 3", "Task #", "Pipelines" |
| `ui_sitemap_select_all` | "Select all (34)" + "12 / 34 selected" | checkbox "Chọn tất cả (<số trang đang hiện>)"; counter "<đã chọn> / <tổng> đã chọn" | tri-state: chọn/bỏ mọi trang **đang hiện theo bộ lọc**; counter luôn tính trên tổng; disabled khi không phải draft | client | |
| `ui_sitemap_cost_estimate` | "~1.2M tokens • Est. cost ~$2.80" (cạnh counter) | "· ~<fmtTokens> token (ước tính)"; khi chạm trần: "· tối đa <fmtTokens(budget)> token (ngân sách)" | `estimateRun()` mỗi lần đổi lựa chọn (thuần, O(1)); title giải thích công thức ngắn | **MỚI** §4.6 | không "$", không "cost" |
| `ui_sitemap_route_search` | "Filter routes by path, regex or tag" | placeholder "Lọc theo đường dẫn…" | substring không phân biệt hoa thường trên path + query; khi lọc, folder tự mở | client | không regex |
| `ui_sitemap_expand_collapse` | "Expand" / "Collapse" | "Mở hết" (`unfold_more`), "Thu gọn" (`unfold_less`) | mở/đóng mọi nhánh | client | |
| `ui_sitemap_filter_tabs` | "All (34) / Public (28) / Auth Gated (6) / Modified < 7d" | "Tất cả (n)", "Công khai (n)", "Cần đăng nhập (n)" (icon `lock`, warn), "Đã chụp < 7 ngày (n)" | SegmentedControl toggle; count theo dữ liệu (`needsAuth`, `capturedAt ≥ now−7d`) | `discover.json` + capture dates | count khớp |
| `ui_sitemap_route_tree` | bảng "URL ROUTE HIERARCHY / STATUS / AUTH / CAPTURE…", connector ├ └, folder "/docs (8 nested children)" chevron + checkbox, icon file | cột "ĐƯỜNG DẪN", "HTTP", "ĐĂNG NHẬP", "ĐÃ CHỤP"; folder: "<prefix> (<n> trang con)"; trang: icon `description` + path ("/" hiển thị "/ (trang chủ)") | GridTable; cây dựng bởi `buildRouteTree(pages)` thuần (file `sitemap/route-tree.ts`): nút theo segment, folder ảo chỉ khi prefix không là trang và có ≥2 trang con (D10); connector CSS (`::before` ├/└ theo `isLast`); folder checkbox tri-state (`indeterminate`) = mọi trang con; chevron thu/mở nhánh (`aria-expanded`); hàng không chọn: chữ `--c-text-3` | `discover.json` | 100 trang render <50ms; tri-state đúng; unit test cây |
| `ui_sitemap_http_status` | "200 OK 1.2s", "302 Redirect" | "<status> · <x,y s>"; redirect: "<status> · chuyển hướng"; thiếu dữ liệu (discover cũ): "—" | Badge: 2xx success, 3xx/redirect text-2, 4xx warn (401/403) hoặc danger, 5xx danger | **MỚI** `CrawlPage.status/loadMs/redirected` §4.4 | hiện đúng cho discover mới |
| `ui_sitemap_auth_gated_rows` | hàng amber, `lock`, "Needs Login"/"Auth Required" | Badge warn `lock` "Cần đăng nhập"; title "Trang này cần đăng nhập" | `rowTone` warn | `needsAuth` | không "Turnstile", "injected cookies" |
| `ui_sitemap_captured_at` | "Captured: Today, 14:22" / "2d ago" / "Not yet cached" | RelTime "đã chụp 2 ngày trước"; chưa có: "Chưa chụp" | `capturedAt` (s) | capture tasks done | |
| `ui_sitemap_protected_banner` | "Protected Routes Detected (3 in selection)" + "Inject Cookies (.har)" + "Configure Turnstile Bypass" | Banner warn `lock`: title "Có <k> trang cần đăng nhập trong lựa chọn"; body "Mở cửa sổ Chrome để đăng nhập (tự xử lý CAPTCHA nếu có), hoặc import cookie/storageState JSON. Phiên được lưu trong profile của dự án."; nút "Mở cửa sổ đăng nhập" (secondary), "Import cookie JSON" (secondary, file input ẩn) | chỉ hiện khi lựa chọn có trang `needsAuth` và status draft; import dùng lại logic `SessionTools`; kết quả hiện Banner info/danger | `POST …/auth/open`, `POST …/session/import`, **MỚI** start đóng cửa sổ (D8) | không bypass, không ".har"; mở cửa sổ → Bắt đầu clone vẫn chạy |
| `ui_sitemap_action_bar` | thanh đáy dính "12 pages selected (3 auth gated) • Est. runtime • Engine…" | "<n> trang đã chọn" + " (<k> cần đăng nhập)" (warn, chỉ khi k>0) | `position: sticky; bottom: 0`, nền `--c-surface-lowest`, border-top; chứa runtime estimate, Hủy, Bắt đầu clone | client | không "Engine:", không "Configure Rules" |
| `ui_sitemap_runtime_estimate` | "Est. runtime: ~45s" | "Ước tính ~<fmtMinutes>" | `estimateRun().seconds` | **MỚI** §4.6 | |
| `ui_sitemap_cancel` | "Cancel" | "Hủy" | link `/` | — | |
| `ui_sitemap_start_clone` | "Start clone ⌘⏎" (primary lớn) | "Bắt đầu clone" (`play_arrow`) | disabled khi không draft / chưa chọn / đang chạy; POST start → `/p/[id]`; không phím tắt | `POST …/start` | |
| `ui_sitemap_recrawl` | — | "Chưa có sitemap (lần quét trước chưa xong hoặc lỗi)." + "Quét lại" / "Đang quét…" | như hiện tại | `POST …/crawl` | |
| `ui_sitemap_session_tools` | — (spec §3) | Disclosure "Phiên đăng nhập": "Xóa phiên", "Import cookie / storageState JSON" | `SessionTools` bọc trong Disclosure, cách khối trên 16px (sửa lỗi dính) | `POST …/session/clear`, `…/session/import` | không dính sát nút |

Không hiện: cột payload/assets, "cached", Engine label, Configure Rules, sidebar Execution IR/Asset Store/…

### 3.5 `/p/[id]` Tiến độ — `screen_progress` (mockup `progress.png|html`)

Layout: `PageHeader`; context bar (1 hàng, border-bottom); stepper; banner (có điều kiện); form tài khoản (có điều kiện); lưới 2 pane `360px minmax(0,1fr)` cao `calc(100vh − 56px − phần trên − 16px)` tối thiểu 480px, pane trái = danh sách trang, pane phải = log; Disclosure phiên cách 16px (sửa lỗi dính).

| ui_id | Stitch | Copy | Hành vi | Nguồn | Nghiệm thu |
|---|---|---|---|---|---|
| `ui_progress_page_header` | — (top nav drift) | crumbs "Lịch sử / <host> / Tiến độ"; title "Tiến độ clone" | — | — | |
| `ui_progress_context_bar` | "Target Origin:" chip URL + `open_in_new`, pill running | "Trang gốc:" + UrlChip(url, openable); StatusPill (+ đang chờ); "<progress>%" | cập nhật từ SSE | `project`, SSE `status`/`progress` | link mở tab mới |
| `ui_progress_stats_bar` | "00:04:12 elapsed", "Tokens: 142k / $0.34" (DOM nodes, Asset queue = ngoài phạm vi) | StatTile "Thời gian chạy" = `fmtDuration`; StatTile "Token đã dùng" = "<fmtInt used> / <fmtInt budget>" (tone warn khi ≥90%) | elapsed: status running → `now − at` của event `status: running` cuối trong history (tick 1s, dừng khi rời running); không running → khoảng giữa event running cuối và event trạng thái kết thúc kế tiếp; không có history → "—". Token: SSR ban đầu + `progress.tokensUsed` | **MỚI** `at` §4.1, `progress.tokensUsed` §4.3; `projects.tokens_used`, `config.tokenBudget` | không "$", không DOM nodes, không asset queue |
| `ui_progress_controls` | "Pause" / "Resume" (footer) | "Tạm dừng" (secondary `pause`) khi running; "Tiếp tục" (primary `play_arrow`) khi resumable ≠ needs_auth | đặt ở phải context bar; resume hỏi tài khoản nếu `needsCredentials` (giữ luồng) | `POST …/pause`, `…/resume` | không "Abort Clone" |
| `ui_progress_phase_stepper` | 9 pha có icon, connector, pha active viền + dot pulse | "discover", "capture", "assets", "ir", "name", "emit", "qa", "fix", "done" (spec §4, bắt buộc đủ 9) | `ol` ngang, icon theo §1.5 (discover `radar`, capture `photo_camera`, assets `image`, ir `schema`, name `badge`, emit `code`, qa `difference`, fix `auto_fix_high`, done `task_alt`); connector 1px (xong: `--c-primary`); done = icon `check` nền success tint; active = viền `--c-primary` + dot ping + `aria-current="step"`; error = `error` danger; `title` = "chờ/đang chạy/xong/lỗi"; logic `phaseStates` giữ nguyên | tasks + SSE | đúng 9 pha, đúng thứ tự |
| `ui_progress_auth_banner` | "Action Required: Page /account needs login (…Turnstile…)" + "Open Window" + "Continue" | copy bắt buộc: "Trang <url> cần đăng nhập — Mở cửa sổ để đăng nhập, rồi bấm Tiếp tục" (path hiển thị trong chip mono); nút "Mở cửa sổ" (secondary `open_in_new`), "Tiếp tục" (warn `play_arrow`) | Banner warn icon tile `warning`; chỉ khi `needs_auth` | `POST …/auth/open`, `…/auth/continue` | không "Cloudflare", "Turnstile", "Worker thread", "clearance" |
| `ui_progress_credentials_form` | — | "Cần tài khoản để đăng nhập tự động (lần đăng nhập trước thất bại hoặc chưa có tài khoản)."; "Tài khoản", "Mật khẩu" (PasswordInput), "Ghi nhớ"; "Tiếp tục với tài khoản này", "Hủy" | giữ luồng hiện tại, restyle Card | `…/resume`, `…/auth/continue` với `credentials` | |
| `ui_progress_page_list` | pane trái: ô "Filter 18 crawled routes…", hàng dot + path + trạng thái ("Active Capturing", "Pending auth", "Queued"…) | SearchInput placeholder "Lọc <n> trang…"; hàng: dot + path mono + nhãn phải: "xong" (success), "đang chạy · <phase>" (primary, dot ping), "cần đăng nhập" (warn), "lỗi · <CODE>" (danger; mã SKIP như `ROBOTS_DISALLOWED` hiện "bỏ qua · <CODE>"), "chờ" (text-3) | `pageStates(tasks, pages)` thuần (file `p/[id]/page-states.ts`): task của trang = `capture:<pageId>`, `name:<pageId>`, `fix:<pageId>:*`; ưu tiên needs_auth > running > failed(capture) > done (capture done và name done/không có) > chờ; cập nhật theo SSE `task`; không có refresh (SSE là nguồn) | tasks (SSR) + **pages.json** (SSR, ≤100) + SSE | không "200 OK 1.2s" (chỉ sitemap có HTTP), không "Cached" |
| `ui_progress_page_counts` | footer pane trái "8 completed • 1 active • 1 blocked • 8 queued / 18 total" | "<a> xong • <b> đang chạy • <c> cần đăng nhập • <d> lỗi • <e> chờ" trái, "<n> trang" phải; dòng 2 (khi có): "Task đang chạy: [<phase>] <key>, …" (≤3, còn lại "+N") | từ `pageStates` + tasks running | tasks | giữ nội dung "task đang chạy" của spec §10 |
| `ui_progress_log_stream` | pane phải, header "stdout & ast-worker.log PID 4921" | header "Log"; rỗng: "Đang chờ sự kiện…" | LogView; khi SSE mở nhận message `history` → dựng lại tối đa 2000 dòng gần nhất (log còn sau reload/khởi động lại), rồi event trực tiếp; giữ ≤2000 dòng | **MỚI** event log bền + SSE `history` §4.1–4.2 | reload trang sau khi xong vẫn thấy log cũ |
| `ui_progress_log_level_filter` | "All / Info / Warn (2) / Error (0)" | "Tất cả", "Info", "Warn (<n>)", "Error (<n>)" | SegmentedControl toggle; lọc hiển thị client; đếm trên toàn bộ dòng đang giữ | level của event | |
| `ui_progress_log_toggles` | checkbox "Auto-scroll", "Wrap lines", icon `block` | "Tự cuộn", "Xuống dòng" (checkbox, mặc định bật); IconButton `block` "Xóa log đang hiển thị (lịch sử vẫn giữ)" | tự cuộn tắt khi người dùng cuộn lên, bật lại khi tick; xuống dòng = `white-space: pre-wrap` vs `pre` + cuộn ngang; xóa chỉ xóa state client | client | |
| `ui_progress_log_line` | "[14:22:01.104] [worker#01] [INFO] message", dòng warn nền amber + viền trái | "[HH:MM:SS.mmm] [INFO\|WARN\|ERROR] <text>"; text như `describe()` hiện tại (vd "[capture] home → done", "trạng thái → completed") | giờ từ `at` của server (giờ địa phương); warn/error nền 5% + viền trái 2px; không tag worker | **MỚI** `at` §4.1 | không "worker#", "Thread #" |
| `ui_progress_session_tools` | — (spec §3) | Disclosure "Phiên đăng nhập" (Xóa phiên / Import cookie / storageState JSON) | cách lưới 16px | session routes | không dính sát lưới |

Không hiện: DOM nodes, Asset queue, cost, daemon prompt, footer Workers/Mem/CPU, "Inspect DOM Snapshot" (`ui_progress_inspect_snapshot` ngoài phạm vi), "Abort Clone".

### 3.6 `/p/[id]/preview` — `screen_qa_preview` (mockup `qa-preview.png` + `qa-preview-alt.png`)

Layout: `PageHeader`; toolbar 1 hàng (trái: trang, breakpoint, chế độ so sánh, slider; phải: heatmap, khớp tổng, Chạy lại QA, Xuất mã); thân `minmax(0,1fr) 380px`: vùng so sánh cao `calc(100vh − 56px − header − toolbar − 32px)` | rail phải.

| ui_id | Stitch | Copy | Hành vi | Nguồn | Nghiệm thu |
|---|---|---|---|---|---|
| `ui_qa_preview_page_header` | "stripe.com-pricing / Diff QA #8942" | crumbs "Lịch sử / <host> / Preview & QA"; title "Preview & QA" | — | — | không "#8942" |
| `ui_qa_preview_page_select` | — (đa trang) | label "Trang"; option = path | `<select>`; đổi trang reset scroll | `pages` | |
| `ui_qa_preview_breakpoint_switch` | "375px / 768px / 1440px" + icon thiết bị | "375px" (`phone_iphone`), "768px" (`tablet_mac`), "1440px" (`desktop_windows`) | SegmentedControl toggle | scores theo bp | không "DPR 2.0x" |
| `ui_qa_preview_compare_modes` | "Side by Side / Onion Skin / Swipe Slider / DOM Delta" | "Cạnh nhau" (`view_column_2`), "Chồng mờ" (`opacity`), "Trượt so sánh" (`compare`) | Cạnh nhau: 2 pane; Chồng mờ: clone đặt đè ảnh gốc với `opacity = slider%`; Trượt so sánh: clip-path như "Chồng lớp" cũ (đổi tên) | shots + iframe clone | không có "DOM Delta"; không còn chữ "Chồng lớp" |
| `ui_qa_preview_overlay_slider` | "Blend ——● 65%" | Chồng mờ: "Độ trong <n>%"; Trượt: "Vị trí <n>%" | range 0–100, nhãn % cập nhật; ẩn ở Cạnh nhau | client | |
| `ui_qa_preview_heatmap_toggle` | chip "Heatmap On" có dot | "Heatmap" (`layers`), `aria-pressed` | bật: với mỗi section có `heatPath` ở bp hiện tại, đặt `<img>` heat tuyệt đối trên pane clone tại bbox của phần tử `[data-ir-id=rootId]` trong iframe (cùng origin, đo sau `onLoad` và khi đổi bp/trang), `mix-blend-mode: multiply; opacity: .6`; bỏ ảnh heat khỏi danh sách section (chỉ còn trong card fix) | `scores[].heatPath` | overlay khớp vị trí section |
| `ui_qa_preview_match_score` | chip xanh "96.2% Match" | "<fmtPct mean> khớp" | trung bình điểm section của trang × bp hiện tại (D6); success nếu mọi section đạt, ngược lại danger; ẩn khi chưa có điểm; `title` "Trung bình <n> section; cổng đạt tính theo từng section" | scores | số khớp tính tay |
| `ui_qa_preview_rerun_qa` | "Re-run Diff" | Banner info trong rail khi `stale`: "Điểm QA chưa cập nhật sau chỉnh sửa." + Button "Chạy lại QA" (`replay`); đang chạy: "Đang chấm lại…" | chỉ khi `stale` và status completed; POST → 202 → mở EventSource `/events`, chờ `status: completed` → tải lại `/preview`; `failed` → hiện lý do + link "Xem tiến độ"; đóng EventSource khi xong/unmount | **MỚI** `POST …/qa/rescore` §4.3 | sau khi xong `stale=false`, điểm mới |
| `ui_qa_preview_export_button` | "Export" | "Xuất mã" (`download`) | link `/p/[id]/code` | route | không "Approve & Deploy/Export" |
| `ui_qa_preview_side_by_side_panes` | 2 pane có chrome (3 dot + "Original (Live Reference)" / "Clone (Output)" + nhãn engine) | header pane "Gốc · <bp> × <cao>px", "Clone · <bp> × <cao>px" | scale = `min(1, (rộng vùng so sánh − 12px) / 2 / bp)` (Cạnh nhau) hoặc `min(1, rộng / bp)` (2 chế độ chồng), đo bằng `ResizeObserver` (thay hằng 440/880) → hết khoảng trống ở 1440; header pane dính đầu vùng cuộn | shots, iframe | ở 1440×900 mỗi pane rộng ≥ 500px; không "PUPPETEER", "VITE", "TAILWIND JIT" |
| `ui_qa_preview_sync_scroll` | toggle "Sync Scroll" | — (không có nút) | 2 pane nằm trong 1 vùng cuộn chung nên luôn đồng bộ; không render toggle | — | cuộn 1 lần 2 pane cùng chạy |
| `ui_qa_preview_rail_tabs` | tab "Sections (8)" / "Coverage checklist (12)" | "Section (<n>)", "Checklist độ phủ (<m>)" | SegmentedControl `tabs`; n = section của trang × bp, m = tương tác của trang | scores, interactions | count đúng |
| `ui_qa_preview_summary` | "7 Passing • 1 Action Item • Total Accuracy 96.2%" | "<a> đạt • <b> cần sửa · ngưỡng <fmtPct threshold>" | đầu tab Section | scores, `threshold` | |
| `ui_qa_preview_section_scores` | hàng: dot + tên snake_case + badge % + chevron | tên section (từ `naming`, fallback "section-N"); Badge "<pct>" success/danger | click hàng → cuộn clone tới section (hàm `scrollToSection` hiện có); hàng chưa đạt mở rộng thành `ui_qa_preview_fix_request` | `sections`, `scores` | |
| `ui_qa_preview_fix_request` | card đỏ mở rộng "94.2% [FIX REQ]" + "DOM Box Metric Mismatch" + "Inspect CSS Rule" / "Ignore (0.4%)" | Badge danger "cần sửa"; trạng thái theo task fix: xong + vẫn dưới ngưỡng → "Đã chạy vòng sửa tự động (tối đa 3 vòng), vẫn dưới ngưỡng."; `BUDGET_EXCEEDED` → "Dừng sửa: hết ngân sách token."; failed → "Vòng sửa lỗi: <CODE>."; đang chạy/chờ → "Đang sửa…"; không có task → "Chưa qua vòng sửa tự động."; ảnh heat thu nhỏ của section; Button primary "Sửa trong editor" (`edit`) | link `/p/[id]/editor?page=<pageId>` (editor đọc `?page=` làm trang ban đầu, §3.8) | **MỚI** `fixes` trong `GET …/preview` §4.7 | không số liệu chẩn đoán, không "Ignore", không "card-hero.tsx" |
| `ui_qa_preview_next_diff` | "Jump to next diff [N]" | "Section chưa đạt tiếp theo" (`arrow_forward`) | cuộn tới section chưa đạt kế tiếp (vòng lại đầu), đánh dấu hàng đó; disabled khi không có | scores + `scrollToSection` | |
| `ui_qa_preview_coverage_checklist` | "SYNTHESIS COVERAGE CHECKLIST 10/12 Passed" + hàng ✓/✗ tên dễ đọc + trạng thái | tiêu đề "CHECKLIST ĐỘ PHỦ" + "<captured>/<tổng> đã chụp"; bảng gọn toàn dự án "Trang · Đã chụp · Lỗi · Bỏ qua"; hàng: icon + nhãn "<Loại> · <trigger rút gọn ≤60 ký tự>" + trạng thái phải; loại: hover "Hover", menu "Menu thả xuống", tab "Tab", accordion "Accordion", modal "Modal", carousel "Carousel", sticky "Sticky/cuộn", form "Form"; trạng thái: captured `check` success "đã chụp", failed `close` danger "lỗi" (hàng tô danger 5%) | nhãn sinh tất định từ `kind` + `trigger` (không AI) | `interactions`, `coverage` | không chữ "Synthesis", "verified", "untriggered" |
| `ui_qa_preview_skipped_item` | "— Cookie Consent Banner skipped" | icon `remove` text-3 + "bỏ qua" | style hàng skipped | `status=skipped` | |

Không hiện: DOM Delta, Auto-reconcile CSS, Approve & Deploy, status bar AST Worker, callout delta trên clone, "Pixel QA 1 Diff".

### 3.7 `/p/[id]/code` — `screen_code_viewer` (mockup `code-viewer.png|html`)

Layout: `PageHeader`; lưới `280px minmax(0,1fr)` cao `calc(100vh − 56px − header − 32px)`: trái = lọc + cây; phải = header file (dính), code pane, footer. Trang server giữ phần đọc file/shiki; `FileTree`, `CopyButton`, `WrapToggle`, `ExportActions` là client component nhỏ.

| ui_id | Stitch | Copy | Hành vi | Nguồn | Nghiệm thu |
|---|---|---|---|---|---|
| `ui_code_viewer_page_header` | — (brand DevBrowser = drift) | crumbs "Lịch sử / <host> / Mã nguồn"; title "Mã nguồn"; meta UrlChip(url) | — | `project` | không "DevBrowser", "workspace-root", "main branch" |
| `ui_code_viewer_file_search` | "Search project files…" | placeholder "Lọc file theo tên…" | substring trên đường dẫn tương đối (không tìm nội dung); lọc cây client, folder chứa kết quả tự mở | danh sách file (≤2000) | |
| `ui_code_viewer_file_tree` | cây "out" gập được, icon theo loại, hàng chọn nổi | thư mục gốc "out"; thư mục/file theo tên | cây từ danh sách đường dẫn; folder `folder`/`folder_open` + chevron (`aria-expanded`), mặc định mở nhánh chứa file đang xem; icon: `.html` `html`, `.css` `css`, `.js` `javascript`, `.json` `data_object`, ảnh `image`, khác `description`; file đang xem nền `--c-accent` 20% + viền trái `--c-accent-strong`, `aria-current="page"`; link `?file=` | `listOut` | |
| `ui_code_viewer_file_header` | chip "out/index.html" + "18.6 KB" + "42 lines" | chip `description` "out/<file>"; "<fmtBytes size>"; "<n> dòng" | size từ `stat` sẵn có; số dòng đếm trên text đã đọc (server) | `stat` + nội dung | |
| `ui_code_viewer_copy_button` | "Copy" | "Sao chép" (`content_copy`); sau khi xong "Đã sao chép" 2s | fetch `/api/projects/<id>/files/out/<file>` → `navigator.clipboard.writeText`; chỉ file text (có `LANG`) | files route (out/ only) | nội dung clipboard = file |
| `ui_code_viewer_strip_ids` | — | checkbox "Bỏ data-ir-id" | áp cho cả ZIP và thư mục | `stripIds` | |
| `ui_code_viewer_export_zip` | "Export ZIP" (primary header) | "Xuất ZIP" (`folder_zip`) | `downloadZip(id, stripIds)` | `POST …/export {mode:"zip"}` | |
| `ui_code_viewer_export_folder` | "Export to folder" | "Xuất ra thư mục" (`drive_folder_upload`) mở popover: Field "Thư mục đích (đường dẫn tuyệt đối)" placeholder `D:\exports\site` + "Xuất"; kết quả "Đã xuất ra <dest>" / lỗi | popover = Disclosure neo dưới nút (Esc đóng); giữ ô đường dẫn (bắt buộc cho API) | `POST …/export {mode:"folder"}` | |
| `ui_code_viewer_code_pane` | code chỉ đọc có gutter số dòng, tô màu | — | shiki `github-dark` giữ nguyên; nền `--c-surface-lowest`; gutter = CSS counter trên `.line` (số `--c-text-3`, canh phải, `user-select: none`); ảnh hiện `<img>`; file >512KB: "File quá lớn để xem (<n> KB)." | shiki | có số dòng; không copy dính số dòng |
| `ui_code_viewer_wrap_toggle` | — (gap: HTML xuất 1 dòng dài) | IconButton `wrap_text` "Xuống dòng" (`aria-pressed`, mặc định **bật** cho `.html`) | đổi `white-space: pre-wrap` / `pre` trên pane | client | HTML dài đọc được không cuộn ngang |
| `ui_code_viewer_build_status` | footer "Build Successful \| 12 files · 184 KB \| HTML5 / UTF-8 \| Synced 2m ago" | "<n> file · <fmtBytes tổng>" | tổng dung lượng: `stat` mọi file trong danh sách qua `mapLimit(8)` (≤2000) | `listOut` + `stat` | chỉ số file + dung lượng |

Không hiện: Git tab, Explorer/Search/Export side nav, "Export Package", "Build Successful", "HTML5 / UTF-8", "Synced".

### 3.8 `/p/[id]/editor` — `screen_editor` (không có mockup; chỉ token + chrome)

| ui_id | Stitch | Copy | Hành vi | Nguồn | Nghiệm thu |
|---|---|---|---|---|---|
| `ui_editor_page_header` | — | crumbs "Lịch sử / <host> / Editor"; title "Editor" | — | — | |
| `ui_editor_toolbar` | — | "Trang" (select); SegmentedControl "Thiết bị": "1440", "768", "375"; IconButton `undo` "Hoàn tác", `redo` "Làm lại"; Button primary `save` "Lưu"; trạng thái: "Đã lưu: <n> thay đổi — điểm QA cần chạy lại" + link "Mở Preview" | trang ban đầu = `?page=` nếu hợp lệ, ngược lại mặc định API; giữ logic save/undo hiện có | `GET/POST …/editor*` | |
| `ui_editor_canvas_chrome` | — | — | theme GrapesJS bằng override trong `globals.css` scope `.editor-shell`: `.gjs-one-bg` → `--c-surface-low`, `.gjs-two-color` → `--c-text-2`, `.gjs-three-bg` → `--c-surface-high`, `.gjs-four-color`/`.gjs-four-color-h:hover` → `--c-primary`; border panel `--c-border`; font `--t-label-md` | GrapesJS | không còn panel xám `#444` mặc định |
| `ui_editor_effects_panel` | — | Card "Hiệu ứng": "Keyframes", "Thời lượng (ms)", "Áp cho phần tử đang chọn" | restyle, logic giữ nguyên | `effects` | |
| `ui_editor_sections_panel` | — | Card "Section": mô tả "Chọn section ở các trang khác nhau; section chọn đầu tiên thành layout chung."; Badge "Layout chung"; "Gộp thành layout" | restyle, logic giữ nguyên | `…/editor/promote-layout` | |

### 3.9 Số element

| Màn | Số `ui_*` |
|---|---|
| shell | 6 |
| settings-ai | 15 |
| history | 21 |
| new-clone | 15 |
| sitemap | 17 |
| progress | 14 |
| qa-preview | 18 |
| code-viewer | 11 |
| editor | 5 |
| **Tổng** | **122** |

Id graph cũ không dựng (giữ node, gắn `out_of_scope`): `ui_history_status_filter` (tab Failed), `ui_history_inject_auth` (drift `drift_history_inject_auth`), `ui_settings_ai_default_model`, `ui_progress_inspect_snapshot`. Id gộp (alias): `ui_history_vi_status_tabs` → `ui_history_status_tabs`, `ui_history_search` → `ui_history_url_search`, `ui_history_interrupted_resume` → `ui_history_resume_button`.

### 3.10 Ma trận phủ gap (mỗi mục đúng 1 hàng)

| Gap | Mục | Chỗ trong spec |
|---|---|---|
| a1 | App shell | §2.1 `ui_shell_*` |
| a2 | Màu | §1.1 |
| a3 | Radius | §1.3 |
| a4 | Type scale + mono | §1.2 |
| a5 | Icon self-host + aria | §1.5, `Icon`/`IconButton` §2.2 |
| a6 | Status pill | `StatusPill` §2.2, `ui_history_status_pill`, `ui_history_needs_auth_status`, `ui_sitemap_auth_gated_rows` |
| a7 | Nút | `Button`/`IconButton` §2.2 |
| a8 | Grid table | `GridTable` §2.2, `ui_history_job_rows`, `ui_sitemap_route_tree` |
| a9 | Segmented control | `SegmentedControl` §2.2 (tab lịch sử, mode, breakpoint, compare, rail) |
| a10 | Page header | `PageHeader` §2.2, `ui_*_page_header` |
| a11 | Thời gian tương đối | `RelTime` §2.2, `ui_history_progress_bar`, `ui_sitemap_captured_at` |
| a12 | Hành động icon + thanh màu | `ui_history_row_actions`, `ui_history_progress_bar` |
| a13 | `/new` bố cục | `ui_new_clone_card`, `ui_new_clone_crawl_limits`, `ui_new_clone_auth_select`, `ui_new_clone_qa_threshold`, `ui_new_clone_output_format` |
| a14 | Settings 2 cột, kind read-only, vai trò đúng | `ui_settings_ai_config_panel`, `ui_settings_ai_protocol`, `ui_settings_ai_role_matrix` |
| a15 | Sitemap connector + folder + action bar | `ui_sitemap_route_tree`, `ui_sitemap_action_bar` |
| a16 | Progress stepper, banner, 2 pane, dòng log | `ui_progress_phase_stepper`, `ui_progress_auth_banner`, layout §3.5, `ui_progress_log_line` |
| a17 | QA toolbar, pane chrome, dùng hết chỗ, rail | toolbar §3.6, `ui_qa_preview_side_by_side_panes`, `ui_qa_preview_rail_tabs` |
| a18 | Code header, gutter, wrap, cây | `ui_code_viewer_file_header`, `ui_code_viewer_code_pane`, `ui_code_viewer_wrap_toggle`, `ui_code_viewer_file_tree` |
| a19 | Lỗi dính khoảng cách | `ui_sitemap_session_tools`, `ui_progress_session_tools` |
| a20 | Đổi tên "Chồng lớp" + % | `ui_qa_preview_compare_modes`, `ui_qa_preview_overlay_slider` |
| a21 | Chrome editor | `ui_editor_canvas_chrome`, `ui_editor_toolbar` |
| a22 | Mật độ | §1.4 |
| b1 | Count badge 2 tab | `ui_history_status_tabs` + §4.7 `counts` |
| b2 | Tải ZIP trên hàng completed | `ui_history_download_export` |
| b3 | Mã + message lỗi | `ui_history_failed_error_log` + §4.7 `lastError` |
| b4 | Subtitle hàng | `ui_history_row_subtitle` + §4.7 `pageCount` |
| b5 | "capture 2/3" | `ui_history_progress_bar` + §4.7 `phaseDone/phaseTotal` |
| b6 | Refresh + link URL | `ui_history_refresh`, `ui_history_row_url` |
| b7 | Danh sách trạng thái từng trang + lọc | `ui_progress_page_list` |
| b8 | Đếm trang | `ui_progress_page_counts` |
| b9 | Token đã dùng / ngân sách | `ui_progress_stats_bar` + §4.3 `tokensUsed` |
| b10 | Thời gian chạy | `ui_progress_stats_bar` + §4.1 `at` |
| b11 | Lọc level, tự cuộn, xuống dòng, xóa | `ui_progress_log_level_filter`, `ui_progress_log_toggles` |
| b12 | Timestamp log | `ui_progress_log_line` + §4.1 `at` |
| b13 | Link URL gốc | `ui_progress_context_bar` |
| b14 | Khớp tổng + tóm tắt | `ui_qa_preview_match_score`, `ui_qa_preview_summary` |
| b15 | Count checklist + x/y | `ui_qa_preview_rail_tabs`, `ui_qa_preview_coverage_checklist` |
| b16 | Chế độ onion | `ui_qa_preview_compare_modes` |
| b17 | Nhảy tới section chưa đạt | `ui_qa_preview_next_diff` |
| b18 | Nút Export | `ui_qa_preview_export_button` |
| b19 | Card section chưa đạt + Sửa trong editor | `ui_qa_preview_fix_request` + §4.7 `fixes` |
| b20 | Heatmap overlay | `ui_qa_preview_heatmap_toggle` |
| b21 | Filter tabs sitemap | `ui_sitemap_filter_tabs` |
| b22 | Tìm route, folder, mở/thu, tri-state | `ui_sitemap_route_search`, `ui_sitemap_expand_collapse`, `ui_sitemap_route_tree` |
| b23 | Banner trang cần đăng nhập | `ui_sitemap_protected_banner` + §4.7 (start đóng cửa sổ) |
| b24 | Size, số dòng, Copy, lọc file, footer | `ui_code_viewer_file_header`, `ui_code_viewer_copy_button`, `ui_code_viewer_file_search`, `ui_code_viewer_build_status` |
| b25 | Lọc endpoint, count, kind, dot, kebab | `ui_settings_ai_endpoint_list`, `ui_settings_ai_endpoint_filter`, `ui_settings_ai_endpoint_row`, `ui_settings_ai_row_menu` |
| b26 | Mắt mật khẩu, Hủy, copy URL | `ui_new_clone_auth_credentials`, `ui_new_clone_cancel`, `ui_new_clone_url_input` |
| b27 | Mắt API key | `ui_settings_ai_api_key` |
| c1 | Latency + HTTP code khi Test | `ui_settings_ai_test_endpoint` + §4.5 |
| c7 | HTTP status + thời gian mỗi route | `ui_sitemap_http_status` + §4.4 |
| c8 | Ước tính token | `ui_sitemap_cost_estimate` + §4.6 |
| c9 | Ước tính thời gian | `ui_sitemap_runtime_estimate` + §4.6 |
| c13 | Log bền | `ui_progress_log_stream` + §4.1–4.2 |
| c20 | Chạy lại QA | `ui_qa_preview_rerun_qa` + §4.3 |

Mục (c) còn lại (c2–c6, c10–c12, c14–c19, c21) ngoài phạm vi theo §0.2.

---

## 4. Thay đổi backend

Tất cả route mới/đổi: `handle()` (loopback Host + CSRF JSON), `requireProject`, `requireStatus` khi cần, `exclusive()` cho thao tác đụng workspace/browser. Lỗi theo `errorResponse` hiện có. Không có route nào trả secret.

### 4.1 Event bus: dấu thời gian + tail bền (`core/jobs-base.ts`, `core/event-log.ts` MỚI)

**Kiểu**

```ts
// jobs-base.ts
export type JobEvent = /* union hiện có */ | { type: "progress"; progress: number; tokensUsed: number }; // progress thêm tokensUsed (§4.3)
export type StampedEvent = JobEvent & { at: number }; // epoch ms, đóng dấu trong emit
```

**`emit(projectId, e)`** (thứ tự cố định, đồng bộ):
1. `stamped = { ...e, at: Date.now() }`; các trường chuỗi `message`, `reason`, `error`, `url` qua `redact(projectId, s)` rồi cắt 2000 ký tự.
2. `record(projectId, stamped)` (event-log) — trừ `type: "progress"` (nhiễu, suy ra được).
3. Gọi listener như hiện tại (lỗi listener bị nuốt).

**Redact dùng chung**: `secretsOf` + `redact` chuyển từ `jobs.ts` sang `jobs-base.ts` (export `setRunSecrets(id, list)`, `clearRunSecrets(id)`, `redact(id, text)`); `jobs.ts` giữ các lời gọi hiện có (ghi `error_msg` vào DB). Như vậy mọi event (kể cả log của cửa sổ đăng nhập trong `session.ts`) đi qua cùng một chốt redact trước khi tới SSE và đĩa. API key và cookie không bao giờ được đưa vào event (không đổi).

**`core/event-log.ts`** — ring trong RAM + đĩa, không import `app/`:

| Hằng | Giá trị | Ý nghĩa |
|---|---|---|
| `MAX_EVENTS` | 2000 | ring / dự án và ngưỡng xoay file |
| `MAX_RINGS` | 32 | số ring giữ trong RAM |
| `MAX_FIELD_CHARS` | 2000 | cắt chuỗi (áp ở emit) |

- File: `workspace/<id>/events.jsonl` (hiện tại) + `workspace/<id>/events.prev.jsonl` (đoạn trước). Mỗi dòng = `JSON.stringify(stamped) + "\n"`.
- `record(id, ev)`: đảm bảo ring đã nạp (`load`), push (giữ ≤ `MAX_EVENTS`, bỏ đầu), rồi nối vào chuỗi promise ghi của dự án (tuần tự, không xen kẽ): `appendFile(current, line)`; đếm dòng của file hiện tại trong RAM; đạt `MAX_EVENTS` → `rename(current, prev)` (atomic, thay prev cũ) và đếm lại từ 0. Trên đĩa luôn ≤ 2×`MAX_EVENTS` dòng ≤ ~2×2000×2.5KB ≈ 10MB trường hợp xấu nhất.
- Append **không** tạo thư mục: `createProject` tạo `workspace/<id>/` (thêm `mkdir` recursive). Sau khi xóa dự án, append rơi vào ENOENT → bỏ qua. Lỗi ghi khác → `console.error` 1 lần/dự án, không bao giờ làm hỏng job.
- `load(id)` (lần đầu chạm vào dự án trong process): `readFileSync` prev + current (bounded), parse từng dòng, **bỏ dòng hỏng** (dòng cuối bị cắt khi mất điện), giữ 2000 dòng cuối, đếm dòng current. Đồng bộ và bounded, chạy 1 lần/dự án/process.
- `history(id): StampedEvent[]` — bản sao ring (đồng bộ, sau `load`).
- `forget(id)`: xóa ring + bộ đếm (gọi từ `DELETE /api/projects/[id]` sau khi xóa workspace).
- Eviction: >`MAX_RINGS` ring → bỏ ring ít dùng nhất **không** có listener và **không** có lần ghi đang chờ (nạp lại từ đĩa khi cần).
- Đây là log, không phải checkpoint: không cần tmp→rename cho từng dòng; tính toàn vẹn = dòng hoàn chỉnh hoặc bị bỏ.
- File không phục vụ qua `/files/[...path]` (regex `ALLOWED` giữ nguyên: chỉ `out/`, `qa/`, `pages/*/shots/`), không vào ZIP/thư mục xuất (chỉ `out/`), không vào graph.

### 4.2 SSE replay (`GET /api/projects/[id]/events`)

Thứ tự message khi connect (cùng tick đồng bộ nên không trùng, không hở):
1. `data: {"type":"history","events":[...]}` — `history(id)` (≤2000 event).
2. `data: {"type":"status","status":…, "queued":…, "at":…}` — như hiện tại.
3. Event trực tiếp (`subscribe` đăng ký ngay sau khi lấy snapshot, cùng tick).

Client: `history` chỉ dùng cho log + elapsed, **không** áp vào state task/status (task SSR mới hơn); state chỉ đổi theo event trực tiếp. Heartbeat, `MAX_BUFFERED`, đóng khi abort: giữ nguyên.

### 4.3 Chạy lại QA — `POST /api/projects/[id]/qa/rescore` (MỚI)

- Request: không body (hoặc `{}`); `optionalJson` + `z.object({}).strict()`.
- Kiểm tra: `requireProject`; `requireStatus(["completed"], "rescore")`; `out/` phải tồn tại, không thì 409 `NO_OUTPUT` "nothing emitted yet"; trong `exclusive(id)`: `queueHasRoom()` sai → `AppError(QUEUE_FULL)` (429); `requeueRescore(db, id)`; `startProject(db, id)`.
- Response: 202 `{ ok: true, queued: boolean }`.
- `requeueRescore` (jobs.ts, export mới): `INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'qa','rescore','pending') ON CONFLICT(project_id,phase,key) DO UPDATE SET status='pending',attempts=0,error_code=NULL,error_msg=NULL,updated_at=unixepoch()`.
- `runQa`: khi `t.key === "rescore"` thì **không** tạo task fix (chỉ chấm + ghi `qa.json` qua `scoreAll`, file mới không có `stale` ⇒ xóa cờ). Key nằm trong DB nên đúng cả khi bị ngắt rồi resume.
- Luồng: dự án `completed → running → completed` qua queue (1 job đồng thời, ≤5 chờ), pause/resume/SSE/lịch sử hoạt động sẵn. Dự án `completed` không còn task runnable khác (capture lỗi đều attempts=3 hoặc NO_RETRY; test khẳng định) nên chỉ task `qa:rescore` chạy.
- Editor không lưu được khi đang chấm (status `running` ≠ `completed`) — đúng, tránh điểm lệch IR.
- Token: không gọi AI.

**`progress` mang `tokensUsed`**: `updateProgress` đọc thêm `tokens_used` trong cùng transaction; `finishTask` emit `{type:"progress", progress, tokensUsed}`; `runProject` emit cuối cũng kèm `tokensUsed`.

### 4.4 Crawl: HTTP status + thời gian (`core/crawl.ts`)

```ts
export type CrawlPage = { url: string; needsAuth: boolean; status?: number | null; loadMs?: number; redirected?: boolean };
```

- `loadPage`: `t0 = performance.now()` trước `page.goto(…, { waitUntil: "domcontentloaded" })`; `loadMs = Math.round(performance.now() − t0)` (thời gian tới DOMContentLoaded); `status = response?.status() ?? null`; `redirected = !!response?.request().redirectedFrom()`.
- Ghi vào `discover.json` như hiện tại (optional để `discover.json` cũ vẫn đọc được, UI hiện "—").
- Không thêm request nào (dùng response điều hướng sẵn có); politeness delay, robots, giới hạn trang/độ sâu giữ nguyên.
- `POST …/crawl` trả thêm các trường này (shape `pages` mở rộng).

### 4.5 Provider Test: latency + HTTP code

- `core/gateway.ts`: `fetchModels` trả `{ models: string[]; httpStatus: number }` (status của response thành công). Cập nhật 2 caller (`/api/providers/models` trả `{ models }` như cũ; `/api/providers/test`).
- `POST /api/providers/test`: body = cùng union với `/models` (giá trị form `{kind, baseUrl, apiKey}` **hoặc** `{providerId}`) — tách schema union ra `_server/providers.ts` dùng chung. Đo `latencyMs = Math.round(performance.now() − t0)` quanh `fetchModels`.
- Response 200: `{ ok: true, models: number, latencyMs: number, httpStatus: number }`. Lỗi: như hiện tại (`AI_*` → 502, message đã có "status <n>"). Key đã giải mã chỉ dùng trong server, không log.

### 4.6 Ước tính token + thời gian (`core/estimate.ts` MỚI, thuần)

```ts
export type EstimateInput = { pages: number; concurrency: number; delayMs: number; tokenBudget: number; sectionsPerPage: number; fixRate: number };
export type Estimate = { tokens: number; cappedByBudget: boolean; seconds: number; fixSections: number };
export function estimateRun(i: EstimateInput): Estimate;
```

Hằng heuristic (mỗi hằng có comment ghi căn cứ và ghi rõ đây là ước lượng thô, hiệu chỉnh khi có số đo thực):

| Hằng | Giá trị | Căn cứ |
|---|---|---|
| `NAME_TOKENS_PER_PAGE` | 3 000 | outline (cây tag sâu 3 + 200 ký tự text/section, ~8 section ≈ 1 200 token) + thumbnail ≤400×1200px (≈ w·h/750 ≈ 640 token) + prompt/đáp ≈ 500 |
| `FIX_TOKENS_PER_SECTION` | 60 000 | 1 lần gọi fix ≈ context 24 000 ký tự/4 ≈ 6 000 + 3 ảnh crop ≈ 4 800 + đáp ≤ 4 096 ≈ 15 000; giả định trung bình 2 vòng × 2 lần gọi (trần thật: 3 vòng × 6 lần gọi, luôn bị chặn bởi ngân sách) |
| `DEFAULT_SECTIONS_PER_PAGE` | 8 | khi chưa có dữ liệu lịch sử |
| `DEFAULT_FIX_RATE` | 0.25 | tỷ lệ section phải fix khi chưa có dữ liệu |
| `CAPTURE_S_PER_PAGE` | 45 | load + lazy scroll + 3 breakpoint + quét tương tác (trần 5 phút/trang không tính) |
| `NAME_S_PER_PAGE` | 10 | 1 lần gọi AI |
| `QA_S_PER_PAGE_BP` | 4 | render + chụp 1 trang × 1 breakpoint |
| `FIX_S_PER_SECTION` | 120 | 2 vòng × (2 lần gọi AI + chấm lại) |
| `FIX_CONCURRENCY` | 2 | spec §1 |

Công thức (`BPS = 3`):
- `fixSections = ceil(pages × sectionsPerPage × fixRate)`
- `raw = pages × NAME_TOKENS_PER_PAGE + fixSections × FIX_TOKENS_PER_SECTION`; `tokens = min(raw, tokenBudget)`; `cappedByBudget = raw > tokenBudget`
- `seconds = ceil(pages / concurrency) × CAPTURE_S_PER_PAGE + pages × delayMs / 1000 + pages × NAME_S_PER_PAGE + pages × BPS × QA_S_PER_PAGE_BP + ceil(fixSections / FIX_CONCURRENCY) × FIX_S_PER_SECTION + (fixSections > 0 ? pages × BPS × QA_S_PER_PAGE_BP : 0)`

Dữ liệu lịch sử (`historyRates(db)` trong `src/app/p/[id]/data.ts`, server, 2 query aggregate):
- `sectionsPerPage = COUNT(nodes type='Section') / COUNT(nodes type='Page')` trên toàn bảng `nodes`;
- `fixRate = COUNT(tasks phase='fix' của dự án completed) / COUNT(nodes type='Section' của dự án completed)`;
- mỗi tỷ lệ chỉ dùng khi mẫu số ≥ 20, ngược lại dùng mặc định. Kết quả truyền vào `SitemapPicker` qua prop; client gọi `estimateRun` khi lựa chọn đổi (O(1)).
- Không có USD ở bất cứ đâu.

### 4.7 Tinh chỉnh API nhỏ (từ gap b)

**`GET /api/projects`** — thêm (query bounded theo 20 dòng của trang):

```ts
{
  projects: Array<Row & {
    pageCount: number | null;          // số task capture (trang đã chọn); null = draft chưa chọn
    phaseDone: number | null;          // task done của `phase` hiện tại
    phaseTotal: number | null;         // tổng task của `phase`
    lastError: { code: string | null; message: string; phase: string; key: string } | null; // chỉ status failed|needs_auth
  }>;
  total: number; page: number; pageSize: 20;
  counts: { incomplete: number; completed: number };  // cùng bộ lọc q, bỏ qua group
}
```
- `counts`: 1 query `SELECT COALESCE(SUM(status<>'completed'),0), COALESCE(SUM(status='completed'),0) FROM projects WHERE <q>`.
- `pageCount/phaseDone/phaseTotal`: 1 query `SELECT project_id, phase, COUNT(*) total, SUM(status='done') done FROM tasks WHERE project_id IN (<≤20 id>) GROUP BY project_id, phase` → ghép trong JS.
- `lastError`: 1 query window `ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY updated_at DESC, rowid DESC)` trên task `status IN ('failed','needs_auth')` của các dự án failed/needs_auth trong trang, lấy `rn=1`, `substr(error_msg,1,500)`. `error_msg` đã được redact khi ghi.
- Tổng: 4 query cố định/request (không N+1).

**`GET /api/projects/[id]/preview`** — thêm `fixes: { pageId: string; sectionId: string; status: TaskStatus; errorCode: string | null }[]` từ task `phase='fix'` (key `pageId:sectionId`), `LIMIT 2000`.

**`POST /api/projects/[id]/start`** — `await closeAuthWindow(id)` trước `exclusive` (D8), như `/crawl`.

**`DELETE /api/projects/[id]`** — sau khi xóa workspace + rows: `forget(id)` (event-log).

**Trang server** (không phải API):
- `/p/[id]` (progress): thêm `pages` (đọc `pages.json`, ≤100), `tokensUsed` + `tokenBudget` vào `initial`.
- `/p/[id]/sitemap`: thêm `historyRates`, `tokenBudget`, `concurrency`, `delayMs` từ config.
- `/p/[id]/code`: thêm size + số dòng file đang xem, tổng file/dung lượng (`mapLimit(8)`).
- `/p/[id]/editor`: đọc `?page=` làm trang ban đầu (client, `useSearchParams`).

### 4.8 Giới hạn mới (bổ sung bảng §1 spec SP1)

| Giới hạn | Giá trị |
|---|---|
| Event giữ / dự án (RAM và replay) | 2000 |
| Dòng trên đĩa / dự án | ≤ 4000 (2 file xoay vòng) |
| Ring event trong RAM | 32 dự án |
| Độ dài chuỗi trong event | 2000 ký tự |
| `lastError.message` trong danh sách | 500 ký tự |
| Dòng log hiển thị ở client | 2000 |
| File thống kê ở code viewer | 2000, `stat` song song 8 |
| `fixes` trong preview | 2000 |
| Rescore | 1 job qua queue chung (1 chạy, ≤5 chờ, vượt → 429) |

---

## 5. Drift bổ sung

30 `drift_*` hiện có giữ nguyên. Thêm các id sau (không render, không implement). Nguồn: gap §3(d) và các ô "decor" ở bảng từng màn của gap map.

| id | Chuỗi / phần tử Stitch | Xuất hiện ở |
|---|---|---|
| `drift_shell_version_chips` | "v2.4.0-edge • PID 4921", "Daemon v2.4.0", "CORE v2.4.0-rc1", "WebClone Core", "PID 4921 DAEMON SYNC" | mọi mockup, header/sidebar trên |
| `drift_shell_workspace_switcher` | "Project Alpha" + chọn workspace | new-clone, history sidebar |
| `drift_shell_notification_bell` | chuông thông báo + chấm cam | mọi mockup, header phải |
| `drift_shell_terminal_cli` | icon terminal, nút "Terminal CLI" | mọi mockup, header/sidebar dưới |
| `drift_shell_tune_icon` | icon `tune` ở header | mọi mockup, header phải |
| `drift_shell_avatars` | avatar "DX" / "WC" / "CL" | header phải |
| `drift_shell_docs_links` | "Docs", "API Proxy Docs" | header, sidebar dưới, footer settings |
| `drift_shell_task_ids` | "Task #8942", "#8942-PRICING", "Diff QA #8942", crumb "Pipelines" | sitemap, progress, qa-preview |
| `drift_history_page_type_badges` | badge thumbnail DOM / SPA / AUTH / DOCS / HTML / ERR | history* thumbnail |
| `drift_history_target_wording` | "Target: DOM + CSS Assets", "Target: Full SPAs • SSR hydration dump", "HTML+Tailwind export • 18.4MB bundle • Zero diff errors", "ready • bundle exported" | history* subtitle/phase |
| `drift_history_copy_icon` | icon copy/docs trên hàng completed (nghĩa không rõ) | history.png |
| `drift_new_clone_task_config_chips` | "TASK CONFIG 0X88F", "READY", "DOM v3 Parser • Headless Chromium" | new-clone đầu card |
| `drift_new_clone_polite_rate_badge` | "Polite rate limiting active", hint "limit/hops/workers", hậu tố "PGS/LVL/THRD" | new-clone crawl constraints |
| `drift_new_clone_fidelity_badge` | "HIGH FIDELITY" | new-clone QA threshold |
| `drift_new_clone_budget_helper_copy` | "Allocated for AST layout synthesis, multi-pass stylesheet reconciliation, and icon vectorization.", "Target AST dialect" | new-clone token/output |
| `drift_sitemap_stage_chip` | "Stage 3: AST Scoping" | sitemap title |
| `drift_sitemap_har_import` | "Inject Cookies (.har)" (HAR không hỗ trợ; bản hợp lệ = cookie/storageState JSON) | sitemap banner |
| `drift_settings_ai_version_badges` | "v2.4-gateway", "ROUTER ACTIVE", "MATRIX v1.2", "GATEWAY" | settings header, role card |
| `drift_settings_ai_role_badges` | "High Precision", "Low Latency", "Token Extractor" + mô tả vai trò sai ("Tailwind synthesis, JSX…", "Token extraction…") | settings role card |
| `drift_settings_ai_extra_kinds` | badge "VLLM / OAI", "OLLAMA" | settings endpoint list |
| `drift_settings_ai_config_id_line` | "ID: prov_anthropic_v1 // status: 200 OK" | settings config panel |
| `drift_settings_ai_model_cache_age` | "Cached 4 mins ago", "Sync: OK" | settings fetch models |
| `drift_progress_worker_tags` | "[worker#01]", "Thread #04", "stdout & ast-worker.log PID 4921" | progress log, banner |
| `drift_qa_preview_pixel_qa_badge` | "Pixel QA 1 Diff" | qa-preview sidebar |
| `drift_qa_preview_source_ref` | "card-hero.tsx:42" (output là HTML thuần) | qa-preview fix card |
| `drift_qa_preview_synthesis_wording` | "SYNTHESIS COVERAGE CHECKLIST", "verified", "untriggered" | qa-preview checklist |
| `drift_code_viewer_build_successful` | "Build Successful" | code-viewer footer |
| `drift_code_viewer_export_package` | nút "Export Package" (trùng Export ZIP) | code-viewer sidebar dưới |
| `drift_code_viewer_encoding_label` | "HTML5 / UTF-8" | code-viewer footer |

Tổng sau bổ sung: 30 + 29 = 59 drift. Node `ui_history_inject_auth` giữ, nối với `drift_history_inject_auth`, đánh dấu không dựng.

---

## 6. Cập nhật tài liệu + graph

Làm trong plan implement (không phải trong commit spec này):

1. **Viết lại `docs/superpowers/design/stitch-screens.md`** thành bản map mức element:
   - Header: project/design system Stitch; câu "indigo #6366F1" thay bằng "token Stitch xuất ra: primary `#c0c1ff`, primary-container `#8083ff` (xem spec parity §1)".
   - Mỗi màn: route ↔ `screen_*` ↔ mockup file; bảng `ui_* | feature (feat_*) | API | mockup file + vùng | trạng thái (build / out_of_scope / alias)`. Feature map: settings → `feat_ai_gateway`; history → `feat_history_resume`, `feat_export`; new-clone → `feat_crawl`, `feat_auth`, `feat_qa_score`, `feat_ai_gateway`; sitemap → `feat_crawl`, `feat_auth`; progress → `feat_job_queue_sse`, `feat_auth`, `feat_history_resume`, `feat_capture_dom`, `feat_asset_download`; qa-preview → `feat_qa_score`, `feat_fix_loop`, `feat_interaction_scan`, `feat_section_naming`, `feat_editor`; code-viewer → `feat_export`, `feat_emit_html`; editor → `feat_editor`, `feat_ir`.
   - Mục "Drift" = danh sách chính thức 59 id (D4), mỗi id kèm mockup + chuỗi.
   - Giữ các ghi chú copy bắt buộc (auth banner, 2 nút provider, 9 pha, 7 status).
2. **Đồng bộ** `.superpowers/sdd/2026-09-23-sp1-clone-engine/drift-list.md` (bản local) với danh sách mới.
3. **Spec SP1 §10**: thêm 1 dòng dưới bảng: "Bố cục, token và element từng màn: xem `2026-09-24-sp1-ui-stitch-parity-design.md`."
4. **Plan**: thêm plan riêng `docs/superpowers/plans/2026-09-24-sp1-ui-stitch-parity.md` (task: token + icon → component → shell → từng màn → backend §4 → docs/graph → kiểm chứng).
5. **Graph**: chạy `/graphify docs --update` sau bước 1–4; kết quả phải có: 122 node `ui_*` (id §3), mỗi node nối `screen_*` (references) và ≥1 `feat_*`; 29 node `drift_*` mới nối `screen_*`; 4 node out_of_scope và 3 alias như §3.9; không node `ui_*` nào nối tới `drift_*` trừ `ui_history_inject_auth`. Kiểm bằng `/graphify explain screen_<x>` cho 8 màn.

---

## 7. Kiểm chứng

### 7.1 So sánh thị giác (reviewer đánh giá)

- Script `tests/e2e/parity-shots.ts` (không phải test pass/fail): seed như gap audit (2 provider; dự án crawl site3 completed; 2 draft; 1 dự án site1 đang chạy; 1 dự án `auth/captcha.html` needs_auth) qua API, chụp full page 1440×900 từng màn (+ trạng thái: settings có form mở, history completed/running/mixed, new-clone crawl+auto, progress running/needs_auth/completed, preview side-by-side/onion/checklist, code, editor) vào `test-results/parity/<screen>-<state>.png`.
- Reviewer đặt cạnh PNG Stitch tương ứng và duyệt: shell, mật độ, màu, radius, typo, icon, bố cục khớp; không có drift. Kết quả duyệt ghi vào PR.

### 7.2 UI smoke (tự động, mở rộng `tests/e2e/ui-smoke.test.ts`)

- Mỗi màn: mọi `data-ui` của element "luôn hiện" trong §3 tồn tại; element có điều kiện được kiểm ở đúng trạng thái seed (banner needs_auth ở progress; `ui_sitemap_protected_banner` khi chọn trang cần đăng nhập; `ui_qa_preview_rerun_qa` sau một lần lưu editor).
- Nút chỉ có icon: mọi `button`/`a` không có chữ hiển thị (chỉ chứa `svg`) có `aria-label` và `title` khác rỗng.
- Copy bắt buộc: auth banner đúng chuỗi; "Add Anthropic Compatible"/"Add OpenAI Compatible"; stepper đúng 9 pha theo thứ tự; pill hiện mã trạng thái.
- **Không chuỗi drift** trong `document.body.innerText` của mọi màn (iframe clone không tính): `Turnstile`, `Cloudflare`, `Inject Auth`, `Inject Cookies`, `.har`, `Puppeteer`, `Stealth`, `Auto-reconcile`, `Approve`, `Deploy`, `Telemetry`, `PID`, `Daemon`, `worker#`, `Thread #`, `Build Successful`, `Export Package`, `Save as preset`, `Figma`, `Markdown`, `DOM Delta`, `Abort`, `Configure Rules`, `Engine`, `Cluster`, `DevBrowser`, `main branch`, `Synced`, `ROUTER ACTIVE`, `High Precision`, `AES-256`, regex `/\$\s?\d/` (USD), `Task #`.
- Không request tới `fonts.googleapis.com`, `fonts.gstatic.com` hay CDN nào khi tải mọi màn (theo dõi `page.on("request")`: chỉ host loopback).
- Sidebar: đúng 3 item chung; dưới `/p/[id]` đúng 5 item dự án.

### 7.3 Unit (Vitest)

- `estimateRun`: công thức, trần ngân sách, `fixSections` làm tròn lên, pages=1/100.
- `buildRouteTree`: folder ảo đúng điều kiện D10, tri-state, thứ tự, `isLast`, 100 trang.
- `pageStates`: mọi tổ hợp capture/name/fix → đúng nhãn và ưu tiên.
- `format.ts`: `fmtInt`, `fmtPct`, `fmtTokens`, `fmtBytes`, `fmtDuration`, `fmtMinutes` (vi-VN).
- `event-log`: ring giữ 2000 cuối; xoay file ở 2000 dòng; `load` bỏ dòng hỏng cuối; eviction không bỏ ring có listener/ghi chờ; append sau `rm` workspace không tạo lại thư mục; `emit` redact secret đang chạy và cắt 2000 ký tự.
- Nhãn checklist tương tác từ `kind` + `trigger`.
- `gen-icons`: mọi tên trong subset tồn tại (chạy script ở CI không cần — test đọc `icons.gen.ts` so với danh sách).

### 7.4 E2E backend (Vitest e2e, mở rộng suite hiện có)

- **Log bền**: chạy site1 tới completed → mở SSE mới → message đầu `history` chứa event của lần chạy (có `at` tăng dần); khởi động lại module (xóa ring, giữ file) → `history` vẫn trả event từ đĩa; > 2000 event → giữ đúng 2000 cuối.
- **Rescore**: dự án completed → lưu editor (`stale: true`) → `POST qa/rescore` 202 → status running → completed; `qa.json` không `stale`; không tạo task fix mới; không gọi AI (mock provider đếm 0). Từ chối: draft/running → 409 `BAD_STATE`; không `out/` → 409 `NO_OUTPUT`; đang bận → 409 `PROJECT_BUSY`; queue đầy → 429; Origin khác → 403; body `text/plain` → 403.
- **Crawl**: site3 → `discover.json` mỗi trang có `status` 200, `loadMs ≥ 0`; fixture redirect (thêm route 302 vào fixture server) → `redirected: true`; `auth/` → 401/403 hiện đúng.
- **Provider test**: mock server → `latencyMs`, `httpStatus: 200`; body form chưa lưu chạy được; 401 → 502 `AI_AUTH`, message có "401".
- **List API**: `counts` đúng với/không `q`; `pageCount`, `phaseDone/phaseTotal`, `lastError` (failed + needs_auth), số query cố định (không N+1 — kiểm bằng đếm `prepare` qua spy DB trong test).
- **Preview API**: `fixes` phản ánh task fix (kể cả marker `BUDGET_EXCEEDED`).
- **Start đóng cửa sổ**: draft + `auth/open` → `start` 202 (không 409).

### 7.5 Bảo mật (không đổi hành vi)

- `files-csp`, `session-routes`, `api` suite xanh không sửa kỳ vọng cũ.
- `secrets.test.ts` mở rộng: sau khi chạy với mật khẩu/API key giả, grep `events.jsonl`, `events.prev.jsonl`, response `/events` (message `history`), response `GET /api/projects` (`lastError`) → không chứa secret.
- `/files/events.jsonl` và `/files/events.prev.jsonl` → 404; ZIP xuất không chứa file event.
- Toggle mắt không bao giờ nhận giá trị lưu: `GET /api/providers` vẫn chỉ trả key che (test sẵn có).

### 7.6 Cổng hoàn thành

- `npm run typecheck`, `npm test`, `npm run test:e2e` xanh toàn bộ.
- `next build` 0 warning.
- 8 ảnh parity 1440 được reviewer duyệt; ma trận §3.10 mọi hàng có element/phần tương ứng trong code (`data-ui` tìm được bằng grep).
- `graphify-out/graph.json` sau update đạt điều kiện §6.5.
