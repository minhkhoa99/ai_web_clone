# E2 — Interactive components (carousel, tabs, accordion, modal, dropdown, menu, video)

Dự án con E2 của Visual Editor (E1 → **E2** → E3 → E4). Nền: `2026-09-27-e1-document-model-design.md` (IR v2, Command API, server History, Fidelity). Spec này được người dùng duyệt từng phần ngày 2026-10-02.

## 0. Bối cảnh và bằng chứng

Audit (2026-09-27) cho thấy carousel chưa clone được:
- **Phát hiện:** đã nhận diện `.swiper`, `.slick-slider`, `.splide` và scroll-snap (`interactions-eval.ts:44-92`). Nhưng lúc quét chỉ bấm "next" tối đa 10 lần để xem có chuyển động không, và không lưu dữ liệu slide nào (`interactions.ts:122-149`).
- **Gắn hành vi:** `behavior` gắn vào container chứ không gắn vào nút next/prev (`ir.ts:130-137`). Runtime chỉ cuộn được box overflow native (`runtime.js:16-21,53`).
- **Đóng băng:** `transform` của Swiper/Slick bị đóng băng ở giá trị lúc chụp. Class gốc và script gốc bị bỏ.
- **Slide clone:** slide clone do loop bị chụp thành node thường. Autoplay và pagination không được mô hình hoá.
- **Responsive:** số slide lệch giữa các breakpoint làm hỏng style responsive.
- **Modal:** `getElementById("#dialog")` (`runtime.js:44`) khiến modal không mở được.
- **Fidelity:** E1 đã ghi các hành vi JS này là partial/unsupported. E2 phải nâng chúng lên thành component có cấu trúc, chạy được và sửa được.

## 1. Phạm vi và quyết định đã chốt

| Quyết định | Giá trị |
|---|---|
| Kind trong E2 | carousel, tabs, accordion, modal, dropdown, menu, video (tất cả) |
| Runtime | Runtime riêng của tool (`out/js/runtime.js`, vanilla, không dependency). Không đóng gói Swiper/Slick, không chạy script gốc |
| UI chỉnh | Panel "Component" bằng React thuần (không phụ thuộc GrapesJS), gắn vào editor hiện tại; E3 dùng lại nguyên panel |
| Nguồn sự thật | IR v2 + Command API của E1; mọi thay đổi đi qua command và server History |

## 2. Model (IR v2)

Thêm `IRNode.interactive?: InteractiveSpec` trên node gốc của component. Trường này khác `component` (main/instance của E1): một instance vẫn có thể là carousel.

```ts
type Bp = "1440" | "768" | "375";
type InteractiveKind = "carousel" | "tabs" | "accordion" | "modal" | "dropdown" | "menu" | "video";
type Confidence = "config" | "observed" | "guessed" | "manual";

interface InteractiveBase { kind: InteractiveKind; source: "swiper" | "slick" | "splide" | "scroll-snap" | "aria" | "details" | "native" | "generic" | "manual"; confidence: Confidence }

interface CarouselSpec extends InteractiveBase {
  kind: "carousel";
  viewport: string; track: string;
  slides: string[];                 // id node slide theo thứ tự hiển thị; không gồm slide clone do loop
  active: number;                   // chỉ số slide lúc chụp
  autoplay: boolean; interval: number;   // ms, 1000..60000
  loop: boolean; direction: "horizontal" | "vertical";
  transition: "slide" | "fade"; speed: number;   // ms, 0..5000
  slidesPerView: Partial<Record<Bp, number>>;    // 1..10, cho phép số lẻ .5
  gap: Partial<Record<Bp, number>>;              // px, 0..200
  arrows?: { prev?: string; next?: string };
  pagination?: { container: string; kind: "bullets" | "fraction" };
}
interface TabsSpec extends InteractiveBase { kind: "tabs"; tabs: { trigger: string; panel: string }[]; active: number }
interface AccordionSpec extends InteractiveBase { kind: "accordion"; items: { trigger: string; panel: string; open: boolean }[]; multiple: boolean }
interface ModalSpec extends InteractiveBase { kind: "modal"; triggers: string[]; dialog: string; closeOn: ("backdrop" | "esc" | "button")[]; closeButton?: string }
interface DropdownSpec extends InteractiveBase { kind: "dropdown" | "menu"; trigger: string; panel: string; openOn: "click" | "hover" }
interface VideoSpec extends InteractiveBase { kind: "video"; node: string; mode: "native" | "embed"; autoplay: boolean; muted: boolean; loop: boolean; controls: boolean; poster?: string }
type InteractiveSpec = CarouselSpec | TabsSpec | AccordionSpec | ModalSpec | DropdownSpec | VideoSpec;
```

- Mọi id trong spec phải là node thuộc subtree của node gốc. Ngoại lệ là `triggers` của modal: chúng có thể nằm ngoài subtree nhưng phải cùng page. Validate khi load và sau mỗi command.
- Node giữ vai trò (slide, trigger, panel…) không bị xoá bằng lệnh cây thông thường khi còn được tham chiếu. Phải dùng `removeComponentItem` hoặc `unwrapComponent`. Lỗi trả về `IR_PATCH_INVALID`, nêu đúng vai trò bị vướng.
- Slide clone do loop (`.swiper-slide-duplicate`, `.slick-cloned`, hoặc slide trùng structural hash ở hai đầu track) vẫn ở trong capture nhưng không vào IR. Trong IR chúng là node `hidden` bị loại khỏi `slides`, emit bỏ qua chúng, và Fidelity ghi lại việc này.

## 3. Nhận diện (capture)

Nhận diện theo thứ tự độ tin cậy. Mỗi bước chỉ chạy khi bước trước không cho kết quả.

1. **`config`: đọc cấu hình thư viện**, bằng một `evaluate` chỉ đọc, có timeout 30 s:
   - Swiper: `el.swiper.params` (`slidesPerView`, `spaceBetween`, `breakpoints`, `loop`, `autoplay.delay`, `effect`, `speed`, `direction`).
   - Slick: `$(el).slick('getSlick').options` khi có jQuery, nếu không thì đọc `data-slick`.
   - Splide: `el.splide?.options`.
   - Chỉ đọc số, boolean và enum. Không đọc hàm hay chuỗi tự do.
2. **`observed`: quan sát** trong thời gian có giới hạn:
   - Theo dõi `transform`/`scrollLeft`/slide active tối đa 6 s mỗi carousel để đo autoplay và interval.
   - Đếm số slide giao với viewport ở mỗi breakpoint đã chụp để ra slidesPerView; đo gap từ bbox.
   - Bấm next/prev bằng logic scan hiện có để xác định nút và hướng.
3. **`guessed`: suy từ cấu trúc**:
   - tabs: `[role=tablist]` + `aria-controls`;
   - accordion: `details > summary` hoặc `[aria-expanded][aria-controls]`;
   - modal: `[aria-haspopup=dialog]`, `[data-modal]`, `dialog`;
   - dropdown/menu: `aria-expanded` / `aria-haspopup`; hover suy từ delta khi hover;
   - video: `<video>`, iframe có host YouTube/Vimeo.

Kết quả ghi vào `PageCapture.interactives[]` (thay `interactions` cũ cho các kind này). IR build biến chúng thành `interactive` trên node gốc.

**Fidelity theo kind:**
- `config` → supported, trừ khi có effect không tái tạo được (`coverflow`, `cube`, `flip`, `cards`, `creative`, 3D, parallax), khi đó là partial.
- `observed` / `guessed` → partial, kèm ghi chú nêu field nào là suy đoán.
- Phát hiện được dấu hiệu nhưng không dựng được spec → unsupported.
- QA hành vi (§5) có thể nâng một item lên supported khi hành vi đã được kiểm chứng trên bản clone.

## 4. Emit và runtime

**Emit:**
- Node gốc nhận `data-c="<kind>"` và `data-c-cfg` (JSON đã escape, chỉ chứa số, boolean, enum và id node đã đổi sang `data-ir-id`).
- Node con nhận `data-c-role` ∈ `viewport | track | slide | prev | next | pagination | tab | panel | trigger | dialog | close | video`.
- `data-behavior` cũ bị bỏ. Class gốc vẫn không được xuất.
- CSS cơ bản cho từng kind (track flex hoặc grid, ẩn panel…) sinh theo spec rồi đi qua dedupe như style thường.

**`js/runtime.js`** (≤ 15 KB, vanilla, CSP giữ nguyên chỉ cho phép đúng file này):

| Kind | Hành vi |
|---|---|
| carousel | Trượt từng slide một. `slidesPerView`/`gap` theo breakpoint qua `matchMedia(max-width:1439.98px / 767.98px)`. `slide` dùng `transform` + `transition`; `fade` dùng opacity. Loop, autoplay (dừng khi hover/focus-within hoặc `document.hidden`), mũi tên, pagination bullets/fraction. Vuốt bằng pointer, phím ←/→ khi focus. ARIA: `aria-roledescription="carousel"`, slide `role="group"` + `aria-label="n / N"`, live region `polite` khi không autoplay. `prefers-reduced-motion` thì tắt autoplay và đặt transition về 0. |
| tabs | Click và phím ←/→/Home/End; `aria-selected`, `tabindex`; ẩn/hiện panel bằng `hidden`. |
| accordion | Mở/đóng từng mục, có `multiple`; `aria-expanded`. `<details>` native được giữ nguyên. |
| modal | Trigger mở dialog; đóng theo `closeOn` (backdrop / Esc / nút); khoá cuộn trang; đưa focus vào trong, giữ focus trong dialog rồi trả lại khi đóng. Tra id đúng cách, sửa lỗi `"#dialog"` cũ. |
| dropdown / menu | `openOn` click hoặc hover (hover có delay 150 ms khi đóng); đóng khi click ra ngoài hoặc Esc; `aria-expanded`. |
| video | `native`: dùng thuộc tính `<video>` từ spec, `muted` là bắt buộc nếu có autoplay. `embed`: giữ iframe; CSP `frame-src` chỉ cho `www.youtube-nocookie.com`, `player.vimeo.com` khi có embed; luôn ghi Fidelity partial. |

**Chế độ:**
- `?qa=1` (QA): không autoplay, không animation, đặt mọi component về trạng thái lúc chụp (`active`, tab, item đang mở).
- `?edit=1` (canvas editor): hiện đúng item đang chọn trong panel (nhận qua `postMessage` từ editor), không autoplay, không bắt sự kiện vuốt hay click.

Ngoài hai chế độ này là chạy bình thường. Một component cấu hình lỗi thì runtime bỏ qua nó và `console.warn`; các component khác vẫn chạy.

**Responsive:** số slide hoặc cấu trúc lệch giữa các breakpoint không còn chặn style. Node chỉ có ở một số breakpoint được emit kèm `display:none` ở các breakpoint còn lại, và ghi Fidelity partial.

## 5. QA

- **Pixel:** chấm như hiện tại trên trang `?qa=1`. Điểm một section không được thấp hơn baseline trước E2 trên các fixture hiện có (site1–3).
- **QA hành vi** (pha mới chạy sau pha `qa`, có giới hạn và không gọi AI), mỗi component:
  - carousel: next đổi slide active; autoplay đổi slide trong 1.5×interval (chỉ khi có autoplay); pagination click.
  - tabs: click tab 2 thì panel 2 hiện.
  - accordion: toggle.
  - modal: mở rồi Esc đóng.
  - dropdown: mở bằng click hoặc hover.
  - video: phần tử tồn tại với đúng thuộc tính.
- Mỗi lần kiểm tra có timeout 5 s, tối đa 50 component mỗi trang. Đạt thì Fidelity item của component đó lên `supported`, trừ những field vẫn còn ghi partial. Không đạt thì `partial` kèm lý do. Kết quả lưu ở `qa.json` (`behavior[]`) và hiện trên Preview.

## 6. Commands (bổ sung Command API E1)

| Lệnh | Ý nghĩa |
|---|---|
| `updateComponent(id, patch)` | Đổi field cấu hình của `interactive` theo schema zod của từng kind; field không thuộc kind thì bị từ chối. |
| `addComponentItem(id, { from?, index })` | carousel: thêm slide (nhân bản `from`, nếu không thì clone cấu trúc slide đầu với text/ảnh rỗng). tabs/accordion: thêm cặp trigger + panel. ID mới cấp ở server. |
| `removeComponentItem(id, itemId)` | Xoá item cùng node DOM của nó; chỉnh lại `active`; không cho xoá item cuối cùng. |
| `moveComponentItem(id, itemId, index)` | Đổi thứ tự trong spec và trong DOM cùng lúc. |
| `convertToComponent(id, kind, roles)` | Người dùng tự gắn kind và vai trò cho node con (`confidence: "manual"`); validate giống lúc load. |
| `unwrapComponent(id)` | Bỏ `interactive`, giữ HTML tĩnh; Fidelity ghi "bỏ hành vi theo yêu cầu". |

- Alias cho AI ở E4: `updateCarousel` = `updateComponent` trên carousel; `addCarouselSlide` / `removeCarouselSlide` = add/remove item trên carousel.
- Mọi lệnh đều thuần, có lệnh đảo ngược chính xác, tối đa 50 lệnh mỗi batch, mỗi bước History tối đa 8 MB.
- Trên instance của component E1, các lệnh item là lệnh cấu trúc nên bị từ chối ("sửa ở main hoặc detach"). `updateComponent` trên instance được ghi thành override path `interactive.<field>`.

## 7. Panel "Component"

React thuần trong `src/app/p/[id]/editor/component-panel/`. Không import GrapesJS; giao tiếp qua props `{ document, selectedId, revision, onCommands }`. Panel hiện ở rail phải khi node đang chọn nằm trong một `interactive`.

- **Đầu panel:** kind, source, confidence, badge Fidelity; nếu confidence là `guessed` thì hiện dòng nhắc "Clone lại để đọc cấu hình thật".
- **Danh sách item:** thumbnail lấy từ capture nếu có, kèm tên. Kéo thả để đổi thứ tự, có nút ↑↓ cho bàn phím. Có Thêm, Nhân bản, Xoá. Bấm item thì canvas chuyển sang item đó qua `postMessage` (chỉ là trạng thái khi sửa, không lưu).
- **Form theo kind** (giá trị đổi thì gửi `updateComponent`):
  - carousel: autoplay + interval, loop, hướng, transition + speed, slidesPerView và gap cho Desktop/Tablet/Mobile, mũi tên, pagination bullets/fraction/tắt;
  - tabs: tab mặc định;
  - accordion: cho mở nhiều mục, mục mở sẵn;
  - modal: cách đóng;
  - dropdown/menu: mở bằng click hoặc hover;
  - video: autoplay/muted/loop/controls.
- **Node không thuộc component:** hiện nút "Đánh dấu là component…", mở wizard chọn kind và vai trò rồi gửi `convertToComponent`.
- **Có component:** có nút "Bỏ hành vi" (`unwrapComponent`).
- Dùng component `_ui` và token Stitch có sẵn; mọi phần tử có `data-ui="ui_editor_component_*"` (ghi vào `stitch-screens.md`, không có trong mockup); không cuộn ngang ở 375; copy tiếng Việt.
- 409 (revision cũ hoặc đang bận) dùng lại banner "Tải lại" của editor.

## 8. AI (vòng QA fix)

- Prompt fix được thêm `updateComponent` cho component thuộc section đang sửa, để AI chỉnh slidesPerView, gap, speed… khi lệch pixel.
- AI không được dùng `add/remove/moveComponentItem`, `convertToComponent`, `unwrapComponent`, vì các lệnh đó thay đổi nội dung chứ không sửa lệch hiển thị.
- Chat AI (E4) sẽ dùng các alias ở §6.

## 9. Migration

- IR v2 đã có, có `behavior` / `interactions` v1: khi nạp tài liệu (loader của E1), mỗi behavior `carousel|tabs|modal|toggle` được chuyển thành `interactive` với `confidence: "guessed"`, chỉ điền field suy ra được từ DOM. Field còn thiếu dùng giá trị mặc định an toàn (autoplay false, loop false, slidesPerView 1) và Fidelity ghi rõ đây là giá trị mặc định.
- `behavior: "unresolved"` không được chuyển; Fidelity giữ unsupported.
- Việc chuyển là idempotent và không tạo History.
- Muốn có cấu hình `config` thì phải Clone lại.

## 10. Giới hạn cứng (bổ sung bảng §1 SP1)

| Workload | Giới hạn |
|---|---|
| Component mỗi trang | 50 (vượt: phần còn lại ghi unsupported "vượt giới hạn") |
| Item mỗi component | 100 |
| Quan sát autoplay | ≤ 6 s mỗi carousel, ≤ 30 s mỗi trang (vượt: `guessed`) |
| Evaluate đọc cấu hình | 1 lần mỗi trang, timeout 30 s |
| `data-c-cfg` | ≤ 16 KB mỗi component |
| `runtime.js` | ≤ 15 KB (test kiểm) |
| QA hành vi | ≤ 5 s mỗi component, ≤ 50 component mỗi trang |

## 11. Lỗi và an toàn

- Đọc config lỗi thì chuyển sang observed, rồi sang guessed. Capture không fail vì E2.
- `data-c-cfg` chỉ chứa số, boolean, enum và id node. `poster`/`src` của video đi qua asset map hiện có. Embed chỉ cho host trong allowlist.
- Không chạy script gốc, không giả fingerprint, không vượt anti-bot (`rule_no_captcha_bypass`). Việc đọc `el.swiper.params` chỉ là đọc thuộc tính trên trang đã mở.
- Secret không đi vào spec, Fidelity hay request AI.

## 12. Test

- **Fixture mới** `tests/fixtures/site4`: Swiper (self-host bản build nhỏ: autoplay, loop, pagination, breakpoints), Slick (jQuery self-host), carousel scroll-snap, tabs ARIA, accordion `details` + ARIA, modal, dropdown hover, `<video>`, iframe embed giả (local). Không truy cập mạng ngoài.
- **Unit:**
  - nhận diện theo từng nguồn trên snapshot giả, bỏ slide clone;
  - schema và validate tham chiếu;
  - từng command với lệnh đảo ngược và redo;
  - từ chối xoá node đang giữ vai trò;
  - migration từ v1;
  - kích thước `runtime.js`.
- **E2E:**
  - clone site4 ra đúng kind và cấu hình (Swiper `config`, scroll-snap `observed`…);
  - trên bản clone: next đổi slide, autoplay đổi slide, Esc đóng modal, hover mở dropdown, tab đổi;
  - `?qa=1`: điểm pixel site1–3 không thấp hơn baseline;
  - editor: thêm, nhân bản, xoá, đổi thứ tự slide; Undo/Redo; reload vẫn còn; 409 hiện banner;
  - QA hành vi cập nhật Fidelity;
  - parity: 375/1440 không cuộn ngang.

## 13. Không làm trong E2

- Hiệu ứng 3D, coverflow, cube, flip, cards, parallax (ghi partial).
- Lazy-load ảnh slide do JS điều khiển ngoài `src`/`srcset` (ghi partial).
- Chat AI (E4).
- Canvas editor mới (E3).
- Chạy hoặc đóng gói thư viện JS gốc.
