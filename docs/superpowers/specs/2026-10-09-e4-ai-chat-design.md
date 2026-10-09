# E4 — Chat AI sửa trang bằng editor command

Đây là dự án con E4 của Visual Editor (E1 → E2 → E3 → **E4**). Nền: `2026-09-27-e1-document-model-design.md` (IR v2, Command API, server History, nguồn `ai_editor`), `2026-10-02-e2-interactive-components-design.md` (component tương tác, alias carousel §6, field AI được sửa §8) và `2026-10-07-e3-visual-editor-design.md` (editor React, command bus, `affected`, Sửa main, view-only). Người dùng duyệt thiết kế theo từng phần ngày 2026-10-09.

## 0. Mục tiêu và quyết định đã chốt

Mục tiêu: trong `/p/[id]/editor`, người dùng gõ yêu cầu bằng lời ("đổi màu tiêu đề thành đỏ", "thêm một slide"), AI trả về **một batch editor command** và server ghi nó qua đúng đường Command API / History của E1 với `source = "ai_editor"`. Mỗi lượt sửa là một bước Undo.

| Quyết định | Giá trị |
|---|---|
| Phạm vi node | Các section của trang đang mở chứa vùng chọn; không chọn gì = mọi section của trang. Không bao giờ shell, trang khác hay main component |
| Cách áp | Áp ngay sau khi server validate, thành 1 bước History; hoàn tác bằng Undo / nút "Hoàn tác lượt này" |
| Số vòng | 1 batch mỗi tin nhắn; tool đọc ≤ 5 lần; lệnh bị từ chối thì gửi lỗi lại cho AI tối đa 2 lần |
| Token | Dùng chung ngân sách `tokens_used` / `tokenBudget` của project; trần ước tính mỗi request 60 000 token |
| Lịch sử chat | Bảng SQLite riêng `chat_messages`, ≤ 200 tin/project, AI nhận 6 lượt gần nhất |
| Sửa main / view-only | Khoá gửi, vẫn đọc được lịch sử |
| Tập lệnh | Nội dung + cấu trúc + item component (§3); không có lệnh đổi mô hình component/layout |
| Context | Chỉ text, model vai trò `code`; không ảnh, không trình duyệt |
| Vị trí UI | Tab "AI" thứ 4 ở rail phải |
| Kiến trúc | Server chạy trọn một lượt (route `editor/chat`); client chỉ gửi yêu cầu và áp `affected` |

## 1. Kiến trúc và luồng một lượt

```
Tab "AI" (rail phải) ──POST /api/projects/[id]/editor/chat──▶ server
  { baseRevision, pageId, selection[], breakpoint, text }
                                                   │
 core/ai-chat.ts (thuần; generate được inject)     │
  1. scope = các section chứa selection (không chọn → cả trang), chỉ trên pageId
  2. context = PAGE + OUTLINE + SELECTED + COMPONENTS + HISTORY (§2)
  3. generate(role "code") + tool đọc thuần trên IR (≤ 5 lần)
  4. parse {reply, commands[]} → kiểm op/phạm vi → dry-run prepareCommands + applyCommands trên snapshot
     bị từ chối → gửi lỗi lại cho AI, tối đa 2 lần
  5. commands rỗng → chỉ trả lời, không tạo bước History
                                                   │
 route: exclusiveEdit → withAffected → store.commitCommands(id, baseRevision, commands, "ai_editor")
  ◀── { reply, status, revision?, createdIds, canUndo, canRedo, affected?, tokens, message }
```

- **AI không giữ khoá.** Bước 1–4 đọc `readDocument` ở `baseRevision`, ngoài `exclusiveEdit`; tab khác vẫn sửa được trong lúc AI chạy. Revision hiện tại khác `baseRevision` ngay từ đầu → 409 `STALE_REVISION`, không gọi AI. Chỉ bước commit vào `exclusiveEdit`; revision đã đổi trong lúc AI chạy → 409, không commit, token đã dùng vẫn tính.
- **Một lượt mỗi project:** map in-process trên `globalThis` (giống `session.ts`); lượt thứ hai → 409 `CHAT_BUSY`.
- **Huỷ:** `req.signal` được truyền vào `generate` và kiểm trước khi commit; abort trước commit = không commit. Mỗi lượt có hạn 5 phút (abort như huỷ).
- **Client:** trước khi gửi, chờ command bus hết hàng đợi để lấy revision mới nhất. Kết quả áp lên canvas qua `affected` đúng như một step của bus (thay section, cập nhật revision, `canUndo`/`canRedo`).
- **Hoàn tác:** Ctrl+Z / nút Undo như mọi bước. Mỗi tin AI có nút "Hoàn tác lượt này", chỉ bật khi revision hiện tại của tab bằng revision lượt đó tạo ra (bước đó vẫn là bước mới nhất); nút gọi Undo sẵn có.
- **Ranh giới module:** `src/core/ai-chat.ts` (scope, context, tool, parse, vòng lượt) và `src/core/chat-store.ts` (bảng chat) không import `app/`. Scope/context/tool/parse là hàm thuần; vòng lượt nhận `generate` và hàm dry-run qua tham số để test.
- `onUserEdit` của store chỉ chạy với `source = "user"`; bước `ai_editor` vẫn là sửa tay theo nghĩa hardening (đóng fix task còn dở) — gọi cùng hook cho `ai_editor` để resume không ghi đè document.

## 2. Phạm vi, context và tool

**Phạm vi** (server tự tính từ `pageId` + `selection`, không tin client)
- Mỗi id trong `selection` phải thuộc trang `pageId` (id không có trên trang bị bỏ qua). Lấy section chứa từng id, gộp lại. Không còn id hợp lệ nào = mọi section của trang.
- Tập id cho phép = mọi node (đã resolve, gồm node instance trên trang) trong các section đó. Gốc section được sửa thuộc tính nhưng không được làm đích của `deleteNode`, `moveNode`, `duplicateNode`.
- Section layout dùng chung nhiều trang được ghi trong context là "dùng chung N trang"; prompt yêu cầu AI nói rõ điều này trong `reply` khi sửa nó.

**Context** (chỉ text, role `code`, tổng ≤ 60 000 token ước tính bằng `estimateTokens`; `fitRequest` thu nhỏ OUTLINE khi vượt)
- `PAGE`: đường dẫn trang, breakpoint đang mở (1440/768/375), id các node đang chọn.
- `OUTLINE`: mỗi node một dòng `id · tag · type · tên · "chữ…" (≤ 60 ký tự) · W×H` theo `box` của breakpoint đang mở, thụt lề theo cây. Thứ tự ưu tiên khi cắt: tổ tiên, anh em, cây con của node chọn, phần còn lại; nhánh vượt ngân sách gập thành `… +N con`. Ngân sách 24 000 ký tự.
- `SELECTED`: tối đa 10 node đầu của vùng chọn. Mỗi node: `styles` mọi target, attr an toàn, text, `component` (role main/instance, overrides), `interactive` (kind + field AI được sửa).
- `COMPONENTS`: các `interactive` trong phạm vi với id item và field AI được sửa (tối đa 50, như `componentContext`).
- `HISTORY`: 6 lượt gần nhất của project (user + assistant), mỗi tin ≤ 1 000 ký tự.
- Không bao giờ có: credentials/secret, attr `on*`, `value` của `input[type=password]`.

**Tool đọc** (hàm thuần trên IR, chỉ id trong phạm vi; id ngoài phạm vi → kết quả lỗi, vẫn tính 1 lần; tổng ≤ 5 lần mỗi lượt)
- `readNode(id)`: style mọi target, attr an toàn, text, component, interactive. ≤ 8 000 ký tự.
- `readSubtree(id, depth ≤ 4)`: outline cây con cùng định dạng OUTLINE. ≤ 8 000 ký tự.
- `findText(query)`: ≤ 20 node trong phạm vi có text chứa `query` (không phân biệt hoa thường).

## 3. Trả lời của AI và quy tắc lệnh

AI trả JSON (bỏ được rào ```` ``` ````): `{"reply": string ≤ 1000 ký tự, "commands": [...] ≤ 50}`.
- `commands: []` = chỉ trả lời câu hỏi, không sửa, không tạo bước History.
- `reply` viết bằng ngôn ngữ người dùng dùng.
- `setStyle` mặc định ghi ở breakpoint đang mở: 1440 → `base`, 768 → `768`, 375 → `375`. Chỉ ghi `base` cho "mọi kích thước" khi người dùng nói rõ.

| Được dùng | Không được dùng |
|---|---|
| `setStyle`, `setText`, `setAttribute`, `setHidden`, `setName`, `createNode`, `moveNode`, `duplicateNode`, `deleteNode`, `updateComponent`, `updateCarousel`, `addComponentItem`, `removeComponentItem`, `moveComponentItem`, `addCarouselSlide`, `removeCarouselSlide` | `promoteLayout`, `detachComponent`, `resetOverride`, `convertToComponent`, `unwrapComponent`; ref `new:`; mọi op `restore*` |

- Mọi `id`, `parentId`, `itemId`, `from` phải thuộc phạm vi; `moveNode`/`createNode`/`duplicateNode` đặt node vào cha trong phạm vi.
- `updateComponent` / `updateCarousel` chỉ nhận field AI được sửa (`PATCHABLE[kind]` trừ `arrows`, `pagination`, `closeButton` — E2 §8); id phải là `interactive` trong phạm vi. Lệnh item chỉ trên `interactive` trong phạm vi.
- Core kiểm phần còn lại như với người dùng: `isSafeCss`, attr an toàn, tag/draft, override instance, vai trò component, 50 lệnh / 500 node / 20 tầng / 8 MB.
- **Bị từ chối** (JSON hỏng, sai shape, op cấm, ngoài phạm vi, field cấm, dry-run lỗi): thêm lượt `user` "Lệnh bị từ chối: <lý do>. Trả lại JSON đã sửa." và gọi lại, tối đa 2 lần. Lý do là message `AppError` đã cắt ≤ 500 ký tự, không chứa input nhạy cảm.
- Tổng gọi `generate` mỗi lượt ≤ 8 (≤ 5 lượt có tool call + 1 trả lời + ≤ 2 lần sửa).
- `AI_TOO_LARGE`: thử lại một lần với ngân sách OUTLINE/SELECTED còn một nửa (không tính vào 2 lần sửa), rồi báo lỗi.

## 4. Lưu chat và API

**Bảng** (tạo trong `openDb`, tách khỏi `document_history` để giữ E1 §3 "không lưu prompt vào log History")

```
chat_messages(project_id TEXT, seq INTEGER, role TEXT  -- 'user' | 'assistant'
              text TEXT, page_id TEXT,
              status TEXT     -- assistant: 'ok' | 'answer' | 'refused' | 'error' | 'cancelled' | 'stale'
              revision INTEGER NULL,  -- revision bước History tạo ra (status ok)
              commands INTEGER, tokens INTEGER, created_at TEXT,
              PRIMARY KEY(project_id, seq))
```
- Ghi cặp user + assistant trong một transaction khi lượt kết thúc, kể cả lỗi / huỷ / stale. Tin lỗi chỉ ghi câu tiếng Việt ngắn, không ghi body thô của provider.
- ≤ 200 tin mỗi project (xoá cũ nhất khi ghi); tin user ≤ 2 000 ký tự, tin assistant ≤ 1 000 ký tự.
- Server dừng giữa commit lệnh và ghi chat: lệnh vẫn trong History, chat thiếu một lượt (chấp nhận, chat là nhật ký).
- Xoá project xoá cả `chat_messages` (thêm vào vòng DELETE ở `api/projects/[id]/route.ts`).

**API** (guard loopback/CSRF như route editor khác; `requireProject` + `requireEditable`; zod strict)
- `GET /api/projects/[id]/editor/chat?before=<seq>` → `{ messages (≤ 50, mới nhất trước seq), tokensUsed, tokenBudget, busy }`. GET không cần `requireEditable` (đọc được cả khi view-only).
- `POST /api/projects/[id]/editor/chat` — body `{ text: 1..2000, baseRevision, pageId, selection: id[] ≤ 50, breakpoint: 1440 | 768 | 375 }` → `{ reply, status, revision?, createdIds, canUndo, canRedo, affected?, tokens, message }` (`message` = tin assistant đã lưu).
- `DELETE /api/projects/[id]/editor/chat` → xoá hội thoại của project, không đụng History; 409 `CHAT_BUSY` khi đang có lượt.
- Log/events chỉ ghi `chat: <n> lệnh, <tokens> token, <status>`; nội dung chat không vào `events.jsonl`, run-log, graph hay `document_history`.

## 5. UI — tab "AI"

Tab thứ 4 ở rail phải (Style / Component / Hiệu ứng / **AI**). Dùng `_ui` và token Stitch có sẵn; mọi phần tử mới có `data-ui="ui_editor_ai_*"`, ghi vào `stitch-screens.md` kèm chú thích "không có trong mockup, dùng token/component sẵn có". Copy tiếng Việt, không cuộn ngang.

| Phần tử | `data-ui` | Hành vi |
|---|---|---|
| Tab | `ui_editor_ai_tab` | Mục "AI" trong `ui_editor_right_tabs` |
| Danh sách tin | `ui_editor_ai_messages` | Tin user / AI; tin AI có reply, chip "N thay đổi", token, badge trạng thái (refused/error/cancelled/stale); cuộn lên đầu tải tin cũ (`before`) |
| Hoàn tác lượt | `ui_editor_ai_undo` | Chỉ bật khi lượt đó vẫn là bước mới nhất (§1) |
| Chip phạm vi | `ui_editor_ai_scope` | "Phạm vi: section <tên> (+N)" hoặc "Cả trang"; client tính để hiển thị |
| Ô nhập | `ui_editor_ai_input` | Enter gửi, Shift+Enter xuống dòng, bỏ qua Enter khi IME đang gõ, đếm 2 000 ký tự |
| Gửi / Huỷ | `ui_editor_ai_send` / `ui_editor_ai_cancel` | Đang chạy: nút Huỷ + dòng "AI đang sửa…" |
| Token | `ui_editor_ai_tokens` | "Token: đã dùng / ngân sách"; tông cảnh báo từ 90 % như trang Tiến độ |
| Xoá hội thoại | `ui_editor_ai_clear` | Có hộp xác nhận |

**Trong lúc một lượt chạy (ở tab đó):** `run()` từ chối mọi thao tác sửa với "AI đang sửa — chờ hoặc bấm Huỷ" (gồm sửa chữ inline, kéo/resize, chèn, Sửa main, Undo/Redo). Chọn, hover, zoom, đổi tab vẫn được; phạm vi đã cố định lúc gửi. Xong: áp `affected`; giữ vùng chọn nếu node còn, không thì chọn node mới tạo đầu tiên. 409 stale/busy dùng banner "Tải lại" sẵn có.

**Khoá theo chế độ**
- **Sửa main:** ô nhập tắt kèm "Đang sửa main component — bấm Xong để chat."; lịch sử vẫn đọc được.
- **View-only (< 768px):** ô nhập tắt kèm "Dùng màn hình ≥ 768px để chỉnh sửa". Drawer phải mở được ở view-only nhưng **chỉ có tab AI, dạng chỉ đọc**.
- Chuyển sang view-only trong lúc có lượt chạy → tự Huỷ (abort, không commit).
- Ngân sách đã hết → ô nhập tắt kèm "Hết ngân sách token của project".

## 6. Giới hạn cứng

| Workload | Giới hạn |
|---|---|
| Lượt chat đang chạy | 1 / project (`CHAT_BUSY`) |
| Gọi model mỗi lượt | ≤ 8 (≤ 5 tool + 1 + ≤ 2 sửa; +1 khi `AI_TOO_LARGE`) |
| Thời gian một lượt | ≤ 5 phút; mỗi request timeout 120 s (gateway) |
| Request ước tính | ≤ 60 000 token |
| OUTLINE / output mỗi tool | 24 000 / 8 000 ký tự |
| SELECTED / COMPONENTS | ≤ 10 node / ≤ 50 component |
| `findText` | ≤ 20 kết quả |
| Lịch sử gửi AI | 6 lượt, ≤ 1 000 ký tự mỗi tin |
| Tin user / tin AI | ≤ 2 000 / ≤ 1 000 ký tự |
| Lưu trữ chat | ≤ 200 tin / project; GET ≤ 50 tin mỗi trang |
| `selection` gửi lên | ≤ 50 id |
| Batch AI | ≤ 50 lệnh, 500 node, 20 tầng, 8 MB (core E1) |
| Ngân sách | Chung `tokens_used` / `tokenBudget` của project |

## 7. Lỗi

| Lỗi | Xử lý |
|---|---|
| Parse lỗi / ngoài phạm vi / op hoặc field cấm / dry-run từ chối | Gửi lại cho AI (≤ 2 lần); vẫn lỗi → status `refused`, không commit, chat ghi lý do tiếng Việt |
| `BUDGET_EXCEEDED` | Dừng lượt, status `error` "Hết ngân sách token của project"; ô nhập tắt |
| Không có provider cho vai trò `code` / `AI_BAD_CONFIG` | Status `error` "Chưa cấu hình model vai trò Code", link sang Cài đặt AI |
| `AI_TOO_LARGE` | Thử lại 1 lần với context còn một nửa, rồi `error` |
| Mạng / 5xx sau retry của gateway, `AI_BAD_RESPONSE` | Status `error`, cho gửi lại |
| 409 STALE / PROJECT_BUSY khi bắt đầu hoặc lúc commit | Status `stale`, không commit, banner "Tải lại" |
| 409 `CHAT_BUSY` | Báo "Đang có một lượt chat khác cho project này" |
| Huỷ / hết 5 phút | Status `cancelled`, không commit (abort đến sau commit: kết quả đã ở History, tab thấy khi tải lại) |
| Commit xong nhưng materialize lỗi | Như route commands: `affected` rỗng + `shellChanged: true`, client nạp lại trang |

## 8. Bảo mật

- API key chỉ ở server (gateway); client không gọi provider.
- Context không chứa credentials/secret, `on*`, value password; nội dung chat không vào log, events, graph, History, output.
- Mọi lệnh AI đi qua cùng validate của core như lệnh người dùng; phạm vi tính lại ở server.
- Không chạy trình duyệt, không mạng ngoài ngoài provider đã cấu hình; không vi phạm `rule_no_captcha_bypass`.

## 9. Test

**Unit** (hàm thuần, `generate` giả)
- Phạm vi: một / nhiều section; không chọn → cả trang; id không thuộc trang bị bỏ; không có shell/trang khác; gốc section không làm đích delete/move/duplicate.
- Context: OUTLINE ưu tiên đúng thứ tự và gập theo ngân sách; SELECTED ≤ 10; HISTORY 6 lượt; không có secret / `on*` / value password; vượt 60k thì thu nhỏ.
- Tool: chặn id ngoài phạm vi, trần ký tự, trần 5 lần.
- Parse: JSON hỏng, rào ```` ``` ````, op cấm, id/parentId/itemId/from ngoài phạm vi, field component cấm, `reply` quá dài.
- Vòng lượt: từ chối → gửi lỗi lại → lần sau đạt; quá 2 lần → `refused`; `commands: []` → không có bước History; abort trước commit → không commit; `AI_TOO_LARGE` → thử lại nửa context.
- Chat store: ghi cặp tin, cắt 200, phân trang `before`, xoá theo project.
- Client: hàm thuần tính chip phạm vi và trạng thái nút "Hoàn tác lượt này".

**E2E** (Chromium thật, provider OpenAI-compatible giả như `qa-fixloop`)
- Chọn tiêu đề → "đổi màu chữ thành đỏ" → canvas thay đúng một section; reload còn; History có bước `ai_editor`; "Hoàn tác lượt này" khôi phục.
- Ở 768: lệnh ghi lớp 768, 1440 không đổi.
- Carousel: "thêm một slide" → `addCarouselSlide`; một lần Undo xoá nó.
- AI trả id ngoài phạm vi rồi sửa được → commit; sai cả 3 lần → báo lỗi, revision không đổi.
- Huỷ giữa lượt → không có bước mới; tab khác sửa xen giữa → 409 + banner.
- Sửa main và view-only tắt ô nhập, lịch sử vẫn đọc; khi AI chạy, Delete bị chặn kèm thông báo.
- Hết ngân sách → thông báo, ô nhập tắt.
- Parity: không cuộn ngang ở 1440; ở 768 tab AI nằm trong drawer.

**Hoàn tất khi** `npm run typecheck`, unit, e2e liên quan và `npm run build` xanh; `/graphify docs --update` để graph có node E4.

## 10. Không làm ở E4

- Ảnh / vision, chụp màn hình section.
- Agent nhiều bước (nhiều batch mỗi tin nhắn), streaming từng token.
- Vai trò model riêng cho chat.
- AI sửa main component, shell, trang khác.
- Lệnh `promoteLayout`, `detachComponent`, `resetOverride`, `convertToComponent`, `unwrapComponent`.
- Chat ngoài màn editor; cộng tác nhiều người.
