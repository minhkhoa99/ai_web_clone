# E3 — Visual editor kiểu Figma/Webflow trên IR v2

Đây là dự án con E3 của Visual Editor (E1 → E2 → **E3** → E4). Nền: `2026-09-27-e1-document-model-design.md` (IR v2, Command API, server History, Fidelity) và `2026-10-02-e2-interactive-components-design.md` (component tương tác, panel Component, runtime `?edit=1`). Người dùng duyệt spec theo từng phần ngày 2026-10-07.

## 0. Mục tiêu và quyết định đã chốt

Mục tiêu: thay editor GrapesJS bằng một visual editor chạy thẳng trên document model, cho phép:
- chọn và hover phần tử, layer tree;
- bounding box có handle, hiển thị spacing;
- Style Manager đầy đủ;
- thao tác trực tiếp (kéo, resize, đổi thứ tự, nhân bản, xoá, ẩn, chuyển cha);
- sửa theo breakpoint, Undo/Redo phía server;
- không nạp lại toàn bộ HTML sau mỗi thay đổi.

| Quyết định | Giá trị |
|---|---|
| Kéo / resize | Mặc định **theo luồng layout** (đổi thứ tự, chuyển cha, sửa width/height/spacing); giữ **Alt** để đặt tự do bằng `position:absolute` |
| Tính năng thêm | Sửa chữ trực tiếp, thay ảnh (upload), chèn phần tử mới, chọn nhiều, phím tắt, guide căn lề/snap, đo khoảng cách, zoom/pan |
| Kiến trúc | **Editor riêng bằng React** trên IR v2 (phương án A); bỏ GrapesJS |
| Triển khai | Một spec, hai đợt: **E3a** (lõi) và **E3b** (thao tác nâng cao); GrapesJS giữ dạng "Editor cũ" tới hết E3a, gỡ ở E3b |

## 1. Kiến trúc và luồng dữ liệu

```
/p/[id]/editor (React, client)
├─ EditorStore: document IR v2 (đã resolve), revision, selection[], hover, breakpoint, zoom, mode
├─ Canvas
│   ├─ <iframe srcdoc> = HTML trang (compileV2, giữ data-ir-id) + css + runtime.js?edit=1
│   └─ Overlay (ở cửa sổ cha): hover box, selection box + handle, spacing, guides, vạch chèn
├─ LayerTree · StylePanel · InsertPanel · ComponentPanel (E2, dùng lại nguyên)
└─ Command bus → POST /editor/commands {baseRevision, commands}
        ← { revision, createdIds, affected: { sections:[{id, html}], css, shellChanged } }
```

- **Nguồn sự thật** là IR v2 trên server. Client giữ một bản để hiển thị và áp **lạc quan** (optimistic) cho thay đổi nhẹ (style, text). Server trả về kết quả thật, client thay đúng các section bị ảnh hưởng.
- **Cập nhật từng phần:** canvas thay `outerHTML` của section theo `data-ir-id` và thay nội dung `<style>` của trang. Chỉ khi shell đổi (`shellChanged`) mới nạp lại cả iframe.
- **Canvas** là iframe `sandbox="allow-same-origin allow-scripts"`, chạy runtime ở chế độ edit. Overlay đọc toạ độ qua `getBoundingClientRect` và theo dõi `ResizeObserver` cùng sự kiện scroll trong iframe. Click trong iframe bị chặn và chuyển thành thao tác chọn; link và form không điều hướng.
- **Breakpoint:** iframe rộng 1440/768/375. Style chỉnh ở breakpoint nào ghi vào lớp breakpoint đó (`setStyle` với `target.bp`). Panel hiện giá trị đang có hiệu lực và nguồn gốc của nó.
- **Undo/Redo** dùng server History của E1. Một thao tác của người dùng là một batch command, tức một bước Undo.
- **409** (STALE_REVISION / PROJECT_BUSY): hiện banner "Tải lại", không ghi đè, huỷ các thay đổi lạc quan.

## 2. E3a — chọn, layer tree, sửa chữ, thay ảnh, phím tắt

**Chọn và hover**
- Click chọn node sâu nhất dưới con trỏ. Nhấp đúp vào container để đi xuống con; `Esc` chọn node cha.
- `Shift`+click thêm/bỏ node khỏi nhóm chọn.
- Hover hiện khung mảnh kèm nhãn `tag · tên · W×H`.
- Node đang chọn: khung đậm, margin/padding hiện bằng vùng màu, node cha được highlight nhẹ.
- Node `hidden` không chọn được trên canvas, chỉ chọn qua layer tree.

**Layer tree**
- Cây theo trang: shell → section → node. Tên lấy từ `name`, không có thì dùng `type` + đoạn chữ đầu.
- Mỗi dòng có icon theo `type`, badge component (kind) và main/instance, nút mắt (`setHidden`), đổi tên (`setName`).
- Kéo thả trong cây gửi `moveNode`. Chọn trên cây và canvas đồng bộ hai chiều; cây tự cuộn tới node đang chọn.
- Chỉ render các dòng đang nhìn thấy (virtualized), có ô tìm theo tên hoặc chữ.

**Sửa chữ trực tiếp**
- Nhấp đúp vào node text để bật `contenteditable` trong iframe. Chỉ cho chữ thuần cùng inline `b`, `i`, `a`, `br`; paste dạng plain text.
- `Enter` hoặc click ra ngoài để lưu (`setText`; link dùng `setAttribute href`), `Esc` để huỷ.
- Sửa trong instance thì ghi override (E1).

**Thay ảnh**
- Áp dụng cho `img`, `source` và node có `background-image`. Chọn ảnh từ thư viện asset của project hoặc upload (§5).
- Ghi bằng `setAttribute src`/`srcset` hoặc `setStyle background-image`, có ô alt.

**Phím tắt** (chỉ khi focus không ở trong ô nhập)
- Ctrl+Z, Ctrl+Shift+Z/Ctrl+Y: Undo / Redo.
- Delete: xoá. Ctrl+D: nhân bản. H: ẩn/hiện.
- Ctrl+C/Ctrl+V: copy/paste. Clipboard nội bộ giữ một subtree; dán sau node đang chọn qua `createNode` với ID mới.
- Alt+↑/↓: đổi thứ tự trong cùng cha.
- Ctrl+Enter / Esc: đi xuống con / lên cha. Ctrl+A: chọn các node anh em.
- Thao tác trên nhiều node được gom thành **một batch** (tối đa 50 lệnh), tức một bước Undo.

**Bảo vệ:** thao tác chạm vào vai trò trong component hoặc cấu trúc bên trong instance bị từ chối bằng thông báo tiếng Việt, kèm gợi ý dùng panel Component hoặc Detach (E1/E2).

**Song song:** tab "Editor cũ" (GrapesJS) vẫn hoạt động suốt E3a.

## 3. E3b — Style Manager, kéo/resize, chèn, guide/zoom

**Style Manager** (theo node đang chọn và breakpoint đang mở)

| Nhóm | Thuộc tính |
|---|---|
| Layout | display, flex (direction, wrap, justify, align, gap), grid (template cols/rows, gap), position + top/right/bottom/left, overflow, z-index |
| Size | width, height, min/max |
| Spacing | sơ đồ hộp margin/padding, kéo trực tiếp trên số |
| Typography | font-family (lấy từ các font của trang), size, weight, line-height, letter-spacing, align, color |
| Appearance | background (màu, ảnh, gradient dạng text), border, radius, opacity, box-shadow |
| Transform | translate, scale, rotate |

- Mỗi ô ghi nguồn giá trị ("đặt ở bp này", "kế thừa từ Desktop", "từ main component") và có nút "↺ bỏ" để xoá đúng lớp đó.
- Chuyển trạng thái Mặc định / :hover / :focus / :active ghi vào `target.state`.
- Có ô "Thuộc tính khác" để nhập cặp prop/value tự do. Mọi giá trị đều qua `isSafeCss`.
- Giá trị áp lạc quan ngay lên canvas, rồi gửi `setStyle` sau 300 ms ngừng gõ. Chỉnh liên tiếp trên cùng một ô trong 1,5 s được gộp thành một bước Undo.

**Kéo**
- Mặc định theo luồng: hiện vạch chèn trước/sau node anh em, hoặc khung "thả vào trong" khi trỏ vào container. Thả thì gửi `moveNode`, ID giữ nguyên kể cả khi chuyển section.
- Kéo bị cấm ở shell, bên trong instance và vai trò của component. Khi đó vạch chèn đỏ kèm lý do.
- **Alt+kéo** đặt tự do: node nhận `position:absolute` với top/left tính theo cha gần nhất có position khác static. Nếu cha đang static thì đặt cha thành `relative`. Tất cả ghi ở breakpoint hiện tại, gom trong một batch.

**Resize**
- 8 handle. Width/height ghi ở breakpoint hiện tại; giữ Shift để khoá tỉ lệ.
- Handle trên/trái chỉ dành cho node absolute.
- Có thanh chỉnh padding/gap bằng cách kéo các mép trong.

**Chèn phần tử**
- Panel "Thêm" gồm: Text, Tiêu đề, Đoạn văn, Ảnh, Nút, Link, Khung trống, Flex hàng, Flex cột, Grid 2/3 cột, Section trống, và Carousel/Tabs/Accordion/Modal mẫu (`createNode` rồi `convertToComponent`).
- Kéo từ panel vào canvas (dùng vạch chèn), hoặc click để chèn sau node đang chọn.
- Nội dung mẫu bằng tiếng Việt, style tối thiểu, không gắn class.

**Guide, đo, zoom**
- Snap ở chế độ tự do: bắt vào mép và tâm của node anh em, cha và vùng nhìn (ngưỡng 4 px), có đường guide.
- Giữ Alt khi hover node khác để hiện khoảng cách px tới node đang chọn.
- Zoom 25–200% bằng Ctrl+lăn chuột hoặc Ctrl±, có nút "Vừa khung". Pan bằng Space+kéo. Iframe dùng `transform: scale()`, overlay quy đổi toạ độ theo tỉ lệ.

**Gỡ GrapesJS:** cuối E3b xoá GrapesJS, `grapes-adapter`, route `editor/save` và `editor/promote-layout` cũ; chức năng "Gộp thành layout" chuyển sang lệnh `promoteLayout` gọi từ editor mới.

## 4. Bố cục màn hình (theo Stitch parity)

- **Topbar:** chọn trang, chuyển breakpoint (1440/768/375), zoom, Undo/Redo, chuyển "Editor cũ" (chỉ ở E3a), trạng thái lưu ("Đã lưu" / "Đang lưu…").
- **Trái:** tab Layers / Thêm.
- **Giữa:** canvas.
- **Phải:** tab Style / Component (E2) / Hiệu ứng.
- Dùng `_ui` và token Stitch có sẵn. Mỗi phần tử mới có `data-ui="ui_editor_*"`, ghi vào `stitch-screens.md` với ghi chú "không có trong mockup, dùng token/component sẵn có". Copy tiếng Việt.
- Không cuộn ngang ở 1440. Ở 768, panel gập lại thành drawer; ở 375 chỉ xem và chọn, kèm thông báo "Dùng màn hình ≥ 768px để chỉnh sửa".

## 5. API bổ sung

- **`POST /api/projects/[id]/editor/commands`:** phản hồi thêm `affected: { sections: [{ id, html }], css, shellChanged }`.
  - Server tính các section có node bị batch chạm tới, compile một lần mỗi batch (`compileV2` / `emitSectionV2`).
  - Hơn 20 section bị ảnh hưởng thì trả `shellChanged: true`.
- **`GET /api/projects/[id]/editor?page=`:** thêm `page.html` (trang đã compile, có `data-ir-id`), `css`, `fonts[]`, `assets[]` (key, url, kích thước, loại); giữ `interactives` (E2), `revision`, `canUndo`, `canRedo`.
- **`POST /api/projects/[id]/assets`:** multipart, một file mỗi request, ≤ 25 MB.
  - Chỉ nhận png/jpg/webp/gif/svg/avif, kiểm tra cả đuôi file lẫn magic bytes.
  - SVG được làm sạch: bỏ `script`, `foreignObject`, thuộc tính `on*`, `href`/`xlink:href` dạng `javascript:`/`data:` (trừ data:image raster).
  - Lưu tên theo hash vào `assets/` và cập nhật asset map. Trả `{ key, url }`.
  - Dùng guard loopback/CSRF và `exclusiveEdit`; tổng asset mỗi project vẫn ≤ 500 MB.
- **Lệnh mới `setName(id, name)`:** 1–80 ký tự, trim, có lệnh đảo ngược; client gửi được (thêm vào zod union).

## 6. Giới hạn cứng

| Workload | Giới hạn |
|---|---|
| Batch command | 50 |
| Clipboard | 1 subtree, ≤ 500 node |
| Upload | ≤ 25 MB/file; tổng asset ≤ 500 MB/project |
| Section thay trên canvas mỗi phản hồi | ≤ 20 (vượt thì nạp lại trang) |
| Request đang bay | 1; hàng đợi ≤ 20 thao tác |
| Debounce style | 300 ms; gộp Undo trong 1,5 s cùng ô |
| Zoom | 25–200% |
| Layer tree | virtualized, render ≤ ~200 dòng |

## 7. Lỗi và đồng bộ

| Lỗi | Xử lý |
|---|---|
| 409 STALE / PROJECT_BUSY | Huỷ thay đổi lạc quan, hiện banner "Tải lại" |
| 400 IR_PATCH_INVALID | Hoàn lại thay đổi lạc quan, báo lý do bằng tiếng Việt |
| 503 materialize | Giữ trạng thái, cho thử lại |
| Thay section lỗi / iframe lệch | Nạp lại trang |
| Hàng đợi đầy | Báo "Đang lưu… chờ chút" |

## 8. Bảo mật

- Iframe chạy sandbox; chặn điều hướng do link/form; không chạy script nào ngoài `runtime.js`.
- `contenteditable` được làm sạch ở client; server kiểm tra lại `setText` và `setAttribute` (E1).
- Upload kiểm tra magic bytes và làm sạch SVG; không ghi file ngoài `assets/`.
- Không gửi gì ra AI hay mạng ngoài. Secret không đi vào editor state.

## 9. Test

**Unit**
- Tính `affected` từ một batch.
- Chuyển thao tác thành command: kéo theo luồng → `moveNode`; Alt+kéo → các `setStyle` absolute (gồm `relative` cho cha); resize ghi theo breakpoint.
- Snap/guide là hàm thuần.
- Làm sạch SVG, kiểm tra magic bytes.
- `setName` và lệnh đảo ngược; clipboard đổi ID mới.
- Style Manager xác định đúng nguồn giá trị (bp / kế thừa / main).

**E2E** (Chromium thật, site1/site4)
- Chọn và hover; layer tree đồng bộ hai chiều.
- Sửa chữ trực tiếp, reload vẫn còn. Thay ảnh bằng upload.
- Phím tắt Delete, Ctrl+D, Ctrl+Z/Y, Alt+↑.
- Chọn nhiều rồi xoá, một lần Undo khôi phục hết.
- Kéo theo luồng sang section khác giữ nguyên ID; Alt+kéo thành absolute.
- Resize ở 768 không ảnh hưởng 1440. Style Manager hiện giá trị kế thừa.
- Chèn Flex/Carousel. Zoom 50% vẫn chọn đúng phần tử.
- 409 hiện banner. Một lần sửa style chỉ thay một section.
- Parity: không cuộn ngang ở 1440; ở 768 panel thành drawer.

**Hiệu năng**
- Trang 5 000 node: từ click chọn đến vẽ overlay dưới 50 ms.
- Một lần sửa style chỉ thay đúng một section (đếm số lần thay DOM).

## 10. Không làm ở E3

- Chat AI (E4).
- Cộng tác nhiều người cùng lúc.
- Auto-layout kiểu Figma.
- Vẽ vector hay hình khối.
- Chỉnh sửa bằng mã code.
- Animation timeline (giữ panel "Hiệu ứng" hiện có).

## 11. Rulings khi triển khai E3a (2026-10-07)

Quyết định phát sinh khi viết plan E3a (R1–R20, `docs/superpowers/plans/2026-10-07-e3a-visual-editor-core.md`) và khi review từng task, chép lại để spec khớp code:
- `affected.sections[i] = { id, html, root }` (gốc section đã resolve) + `affected.interactives`; chỉ khi body có `pageId`; Undo/Redo cũng trả. Lỗi sau khi đã commit → `affected` rỗng + `shellChanged: true` (client tải lại), không trả 500.
- Section "bị chạm" = view đã compile **hoặc** gốc section đã resolve khác nhau (nên `setName` / `setHidden` cũng làm mới section); shell/title/meta/thứ tự section đổi hoặc > 20 → `shellChanged`.
- Tài liệu canvas: `<base>` về `out/<page>`, meta CSP chỉ cho `runtime.js`, `<style data-aiwc-css>`; tên hàm thật `renderSectionsHtml` / `emitSection` / `renderSite`. Site xuất ra không đổi khi không truyền tham số canvas.
- Upload: key `https://upload.aiwc.invalid/<sha>.<ext>` trong `uploads.json`, gộp vào asset map; multipart cần `Origin` trùng host; kiểm magic bytes; SVG lọc theo allowlist (~65 phần tử) và chỉ dùng qua `<img>` / `url()`, không bao giờ inline. Lỗi 413 hiện tiếng Việt; file > 25 MB bị chặn ngay ở client.
- Loopback: chỉ nhận `Host` là host thuần + cổng tuỳ chọn; Host lạ → 403.
- Command bus: 1 request đang bay + hàng đợi ≤ 20; op áp lạc quan lúc `push`, `apply()` tự ghi trạng thái trước, `rollback()` khôi phục; bị từ chối → gỡ ngược rồi phát lại phần còn trong hàng.
- Nhân bản / dán bỏ `id`, `aria-controls`, `aria-labelledby`, `for` để không trùng id HTML. Alt+↑/↓ bỏ qua node chữ chỉ có khoảng trắng; đổi thứ tự ở mép bị từ chối.
- Mắt / H = `setHidden` + `display:none` ở base; layer tree không có dòng `#text`, dòng gốc mang nhãn "Trang <path>"; E3a chưa cho chuyển node sang section khác.
- Sửa chữ: setText khi cấu trúc giữ nguyên, thay con trong một batch khi chỉ còn chữ + b/i/a/br (giữ style + attr an toàn), còn lại từ chối. Dán chỉ lấy text thuần, xuống dòng khi dán thành dấu cách; Shift+Enter = `<br>`; Enter khi bị từ chối giữ nguyên chế độ sửa; bỏ qua Enter/Esc khi IME đang gõ. Ctrl+C khi đang bôi đen chữ để trình duyệt tự copy.
- Panel ảnh: thay `src` + `srcset` + `<source>` trong `<picture>` cùng một batch; nền chỉ coi là ảnh khi có `url(`; href qua allowlist an toàn.
- "Editor cũ" = `?legacy=1`; "Edit main" của E1 không nằm trong E3a (thêm vào E3b).
