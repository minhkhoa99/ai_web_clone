# E1 — Document model v2, Command API, History và Fidelity

- Ngày: 2026-09-27
- Trạng thái: Chờ review spec
- Phạm vi: E1, phần mở rộng SP1 đã được người dùng duyệt; không thuộc SP2/SP3
- Quy tắc: `CLAUDE.md`, `rules.md` và các ràng buộc của SP1 vẫn áp dụng

## 0. Mục tiêu và ranh giới

Editor phải sửa một document có cấu trúc, với ID node ổn định, style theo breakpoint, command dùng chung cho người dùng và AI, undo/redo lưu trên server và báo cáo phần clone chưa đầy đủ. Nâng cấp IR hiện có tại chỗ lên v2; giữ pipeline clone, emitter, QA và section/layout hiện tại. Không lưu GrapesJS JSON làm nguồn dữ liệu.

Lộ trình đã chốt: **E1 → E2 → E3 → E4**. E1 tạo nền dữ liệu và command. E2 thêm nhận diện component tương tác và sửa `CarouselComponent`. E3 xây visual editor. E4 cho AI chat sửa bằng chính editor command. E1 không tuyên bố carousel đã hoạt động đúng; báo cáo Fidelity phải ghi tình trạng hiện tại.

Giữ ba breakpoint cố định **1440 / 768 / 375**. Style tablet/mobile kế thừa base và chỉ lưu phần override. `core/` không import `app/`. Mọi input, traverse, batch và history đều có giới hạn. Không xử lý CAPTCHA tự động, stealth, anti-bot bypass hay các node `drift_*`.

## 1. IR v2

`IR.version = 2`; document đã vào History có `revision` tăng đơn điệu. `IRNode` có:

| Trường | Quy tắc |
|---|---|
| `id`, `parentId` | ID cấp từ seed đường dẫn gốc lúc capture/migration hoặc từ command khi tạo; không đổi sau move. Root không có `parentId`. |
| `tag`, `type`, `name?` | `type`: `container`, `text`, `image`, `link`, `button`, `input`, `media`, `svg`, `component-root`. Tag và type được kiểm tra trước khi lưu. |
| `attrs`, `text?`, `children`, `hidden?` | Cây có thứ tự. Text thực nằm ở node `#text`; `setText` không được âm thầm xóa cây con của element. |
| `styles` | `{ base, bp: { 768?, 375? }, state: { hover?, focus?, active? }, pseudo: { before?, after? } }`. Mỗi phần là map CSS property → value. |
| `box?` | Bbox `[x,y,w,h]` theo breakpoint lấy từ capture, chỉ để hiển thị/đối chiếu; command không sửa nó. |
| `component?` | `{ id, role: main | instance, sourceId?, overrides?: string[] }`; `sourceId` ghép node instance với main. |
| `behavior?` | Giữ dữ liệu tương tác cũ; E2 thay bằng model hành vi có type. |

`styles` là nguồn sự thật. `IR.classes`/`cls[]` không còn là dữ liệu sửa được; emitter suy ra các class `s-…` bằng dedupe lúc xuất HTML/CSS. Phải giữ thứ tự cascade và kết quả tại cả ba breakpoint, gồm việc trả về base khi override hẹp hơn không còn hiệu lực. Trạng thái kết hợp breakpoint hoặc pseudo chưa biểu diễn được phải đi vào Fidelity; không suy diễn từ CSSOM rồi âm thầm bỏ.

`Page.shell`, `Section.root`, section placeholder và shared layout tiếp tục tồn tại. Đổi thứ tự placeholder trong shell đổi thứ tự section; sửa một section/layout dùng chung hiện trên mọi trang tham chiếu. `IR.fidelity` là danh sách theo §5.

## 2. Command API

Một command là thay đổi có type trên IR, không phải HTML hay GrapesJS JSON. Lõi `applyCommands(ir, commands)` là hàm thuần: kiểm tra, áp dụng toàn batch theo thứ tự, trả IR mới, command nghịch đảo theo thứ tự ngược và ID mới. Nếu một command sai, toàn batch không có kết quả. Server cấp ID mới trước khi gọi lõi; không dùng ID do AI/client tự đặt để vượt kiểm tra trùng lặp.

| Command E1 | Ý nghĩa |
|---|---|
| `setStyle(id, target, changes)` | `target` là base, bp 768/375, state hover/focus/active hoặc pseudo before/after. `null` xóa property ở target, để giá trị kế thừa có hiệu lực. |
| `setText(id, text)` | Chỉ trên node `#text`; adapter tìm hoặc tạo text node thích hợp trước khi gửi. |
| `setAttribute(id, name, value)` | `null` xóa attribute. Không nhận tên/value mà emitter sẽ loại vì không an toàn. |
| `createNode(parentId, index, draft)` | Chèn cây mới ở index xác định; server cấp ID cho mọi node mới. |
| `moveNode(id, parentId, index)` | Giữ ID, cập nhật `parentId`; index tính sau khi nhấc node khỏi parent cũ. |
| `deleteNode(id)` | Xóa cây con; inverse giữ cây cần khôi phục. |
| `duplicateNode(id, parentId, index)` | Sao chép cây và cấp toàn bộ ID mới; response trả ID root mới. |
| `promoteLayout(sectionIds)` | Đưa thao tác Gộp layout hiện tại vào cùng History; inverse khôi phục section và tham chiếu. |
| `resetOverride(instanceId, path?)`, `detachComponent(instanceId)` | Quy tắc ở §4; đều có undo/redo. |

E2 bổ sung `updateCarousel`, `addCarouselSlide`, `removeCarouselSlide` và lệnh slide còn lại mà editor cần (duplicate/reorder), cùng cơ chế validation/history. E4 dùng cùng endpoint và schema, với phạm vi node được phép sửa. E1 không nhận `replaceSubtree` từ AI. Vòng AI sửa QA đổi prompt/parser sang command E1; `setBehavior` cũ không còn là lệnh AI hợp lệ cho đến khi hành vi được model hóa ở E2. Capture và runtime behavior đã có vẫn được giữ.

API dự kiến: `POST /api/projects/[id]/editor/commands` nhận `{ baseRevision, commands }`, trả `{ revision, createdIds, canUndo, canRedo }`. `GET /editor` trả revision hiện tại. GrapesJS trong E1 là adapter tạm: diff JSON có giới hạn thành create/move/delete/setStyle/setText/setAttribute, rồi gửi cùng đường command. Nó không được dùng `replaceSubtree` để làm mất ID khi chỉ reorder. E3 phát command trực tiếp từ thao tác visual.

Validation chung: project có quyền sửa và không đang chạy; `baseRevision` phải khớp; ID và parent tồn tại; không cycle/trùng ID; không sửa root được bảo vệ; không chuyển node qua ranh giới main/section/shell. Shell chỉ cho move/delete placeholder hợp lệ, không duplicate một tham chiếu section. Kiểm tra tag, attribute, CSS, độ sâu/kích thước subtree và giới hạn batch trước khi ghi. Khởi đầu dùng tối đa **50 commands/batch**, **500 node/subtree**, **20 tầng/subtree** như giới hạn QA hiện có. Cây bị delete/duplicate và dữ liệu inverse của `promoteLayout` cũng phải qua giới hạn; một bước history mã hóa tối đa **8 MB**. Input vượt giới hạn bị từ chối có mã, không bị cắt ngầm. Việc đổi danh sách section phải đồng bộ `sectionIds`/layout references như `syncSections` hiện tại.

## 3. History chung trên server

History là timeline **mỗi project**, gồm tối đa **500 bước**; một batch command thành một bước. Người dùng ở nhiều tab và AI editor cùng dùng timeline. `Undo` áp dụng toàn bộ inverse của bước gần nhất; `Redo` áp dụng command gốc. Hai thao tác đều tăng `revision`, nên tab khác phải tải lại. Một batch mới sau Undo xóa nhánh Redo; khi vượt 500 bước, bỏ bước cũ nhất mà không đổi document hiện tại.

SQLite có `document_state(project_id, ir_json, revision, cursor, materialized_revision)` và `document_history(project_id, seq, forward_json, inverse_json, source, created_at)`. `source` phân biệt `user` và `ai_editor`; không lưu prompt, secret hoặc raw trang vào log. Giữ đúng một snapshot IR hiện tại trong SQLite, không tạo 500 snapshot. Command/inverse chứa cây con chỉ trong giới hạn §2. `Undo`/`Redo` nhận `baseRevision`, trả 409 với revision hiện tại nếu stale. Revision dùng để chống lost update; cursor dùng để chọn bước Undo/Redo, không thay revision.

IR mới và history/cursor được commit trong **cùng transaction SQLite**. Sau commit, cập nhật `ir.json`, `out/`, graph và QA; `materialized_revision` chỉ tăng khi tất cả hoàn tất. Khi còn lệch revision, API đọc editor/preview/file đầu ra phải khôi phục từ snapshot SQLite trước khi phục vụ, hoặc trả lỗi tạm có mã nếu khôi phục thất bại; không phục vụ nửa bản xuất. QA cũ được đánh dấu stale. Giữ `exclusive(id, …)` của server local để serialize tác vụ file, cùng kiểm tra revision trong DB để chống ghi đè từ các tab. Nếu triển khai nhiều server process, cần khóa liên tiến trình trước khi cho phép cùng project; E1 chạy theo kiến trúc một process hiện tại.

Job đang chạy hoặc chờ bị chặn edit/Undo/Redo theo `requireEditable` và `exclusive`. Sau một sửa tay, các fix task còn dở được đóng như quy tắc hardening hiện có, để resume không ghi đè document. QA fix trong pipeline dùng lõi command nhưng chưa là bước interactive history: nó chạy trước khi project vào phiên editor và vẫn giữ checkpoint/revert theo điểm QA.

## 4. Component main/instance và override

`IR.components` chứa cây **main** thực, thay cho metadata `{ hash, instanceIds }` chỉ phục vụ graph. Các node xuất hiện trên trang là **instance**. Main có ID riêng; mỗi node instance ghép được có `sourceId` trỏ tới node main tương ứng. Instance giữ giá trị riêng và danh sách đường dẫn override, ví dụ `styles.base.color`, `attrs.href`, `text`, `children`.

Resolver thuần tạo cây hiệu lực trước khi emit hoặc hiển thị editor: property không override lấy từ main; property có override lấy từ instance. `children` override giữ toàn bộ thứ tự/con của parent instance, gồm node mới có ID riêng. Vì vậy slide list ở E2 có thể dùng cùng quy tắc. Sửa instance bằng command đánh dấu đúng đường dẫn; sửa main lan tới những instance không override nó. Không tạo vòng tham chiếu component.

`resetOverride(instanceId, path?)` xóa một path hoặc toàn bộ override của instance, rồi lấy giá trị hiệu lực từ main. `detachComponent` materialize cây đang nhìn thấy thành node thường, giữ ID node trên trang, bỏ liên kết main/instance. Inverse trong History giữ metadata cần thiết để Undo. Xóa một instance không xóa main; xóa main còn instance bị từ chối. Nếu sửa cấu trúc main làm mất node có override trong instance, từ chối với lỗi chỉ rõ instance liên quan; người dùng reset hoặc detach trước.

Migration chỉ nâng các nhóm lặp cũ lên component thật khi ghép cây chắc chắn. Lấy một bản làm main, biến tất cả bản xuất hiện (kể cả bản đầu) thành instance và tạo override cho mọi khác biệt hiện có để render không đổi. Nhóm không ghép chắc chắn giữ node thường và ghi Fidelity. E2 mở rộng detector và type component; E3 trình bày Edit main, Reset override và Detach.

## 5. Fidelity report

`IR.fidelity` lưu mục `{ pageId, feature, status, nodeId?, breakpoint?, sourceRef?, note }`, với `status = supported | partial | unsupported`. `sourceRef` là neo từ capture để mục thiếu sót không biến mất khi node clone bị xóa. Không lưu HTML/script thô hoặc secret trong note. Danh sách được tạo từ bằng chứng capture và cập nhật khi document/khả năng runtime thay đổi.

| Status | Tiêu chí |
|---|---|
| `supported` | Có biểu diễn IR, được emit và có kiểm chứng thích hợp cho tính năng đó. |
| `partial` | Chỉ có giao diện tĩnh, thiếu một phần hành vi/style, hoặc chỉ đúng ở vài breakpoint. |
| `unsupported` | Quan sát được trên trang gốc nhưng không có bản clone tương ứng. |

Không suy `supported` từ `Interaction.status = captured`: carousel hiện chỉ được scan chuyển động, không lưu slides/autoplay/pagination và runtime chỉ cuộn native overflow, nên là `partial`. E2 cập nhật sau khi `CarouselComponent` và runtime được kiểm chứng. Pixel QA 95% là chỉ số hình ảnh riêng, không thay cho Fidelity.

E1 phải kiểm kê từ dữ liệu hiện có: `@media` không biểu diễn được, pseudo theo breakpoint, focus form, sticky khi cuộn, `subtreeHtml` chưa dựng lại, interaction `failed/skipped`, asset tải lỗi, iframe và canvas ảnh tĩnh. Capture mới ghi một inventory gọn cho script/iframe/canvas và phần bị bỏ trong quá trình quét; không ghi nội dung script. Với capture cũ không có inventory, báo cáo `partial` với note “chưa đủ dữ liệu capture để xác nhận”, không tự nhận `supported`. Xóa node clone không xóa mục nguồn còn thiếu.

Preview & QA hiển thị tổng số từng trạng thái, lọc theo trang/trạng thái và liên kết đến node khi có. Preview API trả cùng dữ liệu để xuất báo cáo. E3 có thể đưa badge lên canvas; không bắt E1 xây lại editor UI.

## 6. Migration, lỗi và kiểm thử

Một loader trung tâm đọc IR cho jobs/editor/preview/export, xác thực `version`, và chuyển v1→v2 đúng một lần khi an toàn để ghi. Job đang chạy có thể chuyển trong memory rồi checkpoint qua đường job của nó; project đã có bản emit và đang idle khởi tạo `document_state` revision 0/history rỗng. Sau khi History tồn tại, SQLite là nguồn sự thật; `ir.json` là mirror. V2 đọc lại không tạo thêm history hoặc thay ID. Version mới hơn v2 bị từ chối với mã rõ ràng.

Migration giải class hash về `styles` (kể cả media, pseudo, state), tạo ID ổn định từ ID đường dẫn v1, điền `parentId` và lấy `box` từ capture.json khi có. Mọi tham chiếu node/component/section/graph được đổi theo cùng ID map. Thiếu capture cho `box` thì bỏ trường tùy chọn và ghi Fidelity; thiếu định nghĩa class, ID trùng hoặc IR sai cấu trúc thì lỗi và giữ nguyên v1. File v2 được ghi tmp→rename, không ghi đè v1 bằng nội dung dở dang. QA cũ được đánh dấu stale sau migration; người dùng có thể chấm lại ba breakpoint.

Lỗi command trả mã có ngữ cảnh nhưng không lộ input nhạy cảm: invalid command/target, xung đột component, stale revision (409), project đang chạy (409), lỗi materialization. Không retry lỗi validation; rollback transaction khi apply hoặc ghi history lỗi. Materialization thất bại giữ snapshot đã commit và trạng thái cần sửa, lần đọc sau khôi phục rồi mới phục vụ output.

Kiểm thử bắt buộc trước khi hoàn tất E1:

1. Fixture v1→v2 idempotent; bảo toàn render/style/section và so ảnh ở 1440/768/375. Node ID giữ nguyên sau move; thiếu dữ liệu đi vào Fidelity.
2. Unit command/inverse cho style, text, attr, create/move/delete/duplicate, section/layout, component Reset/Detach; batch sai không để lại nửa thay đổi; mọi workload chạm trần đều bị từ chối.
3. History qua reload, hai tab cùng revision, Undo/Redo chung, cắt nhánh Redo, giới hạn 500 bước và khôi phục sau gián đoạn materialization.
4. E2E mở project v1, sửa và lưu từ editor, Undo/Redo, Preview & QA có Fidelity; QA fix vẫn có giới hạn vòng, revert khi điểm giảm. Chạy `npm run typecheck`, unit test và `npm run build`.

## 7. Điều kiện bàn giao E1

E1 đạt khi document v2 là nguồn sửa duy nhất, mọi editor edit đi qua command, History server dùng chung và bền sau reload, migration không làm mất bản v1 khi lỗi, và Preview & QA không giấu tính năng chưa clone. E1 không bao gồm runtime carousel mới, visual canvas mới hay AI chat; các phần đó thuộc E2/E3/E4 theo thứ tự đã duyệt.
