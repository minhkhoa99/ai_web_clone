# SP1 UI — Stitch Design Reference

Stitch project: **AI Web Clone Tool** (`projects/5886124613364668099`)
Design system: `assets/12550457517034224226` — dark, Space Grotesk headline, Inter body, JetBrains Mono for URLs/code/scores, indigo #6366F1 primary, green/amber/red status. Đây là nguồn token khởi tạo cho `css/styles.css` của UI (SP1 Task 24).

Bản tải về (HTML + PNG 2560px) ở `docs/superpowers/design/stitch/`: settings-ai, history (+alt1-3), new-clone, sitemap, progress, qa-preview (+alt), code-viewer. Mở `.html` trực tiếp trong trình duyệt (dùng Tailwind CDN, cần mạng).

| Route (spec §10) | Màn Stitch | Screen ID |
|---|---|---|
| `/settings/ai` | AI Gateway & Provider Settings | `43abfe91321b417e977c467411b9c92c` |
| `/` (Lịch sử) | Project History | `75442317e4e140c89efa8ed9caa6cc91` |
| `/new` | New Clone Configuration | `b993bfce1ea94061b7996d8b554afef5` |
| `/p/[id]/sitemap` | Select Pages to Clone | `9da0bfa11ae44403a413b1841b97ef9d` |
| `/p/[id]` | Clone Progress (phase stepper + log + auth banner) | `09b69e1bb548414086a28374933a425c` |
| `/p/[id]/preview` | QA Preview & Compare | `480fa9cbfb75480696136e0cddff7785` |
| `/p/[id]/preview` (variant) | Visual Diff & QA Compare | `9410f8b12f0940bfa715f530a09abdfd` |
| `/p/[id]/code` | Export - Source Browser | `e367b9ea70fa4329bfba8a9d6d19fdb1` |
| `/p/[id]/editor` | GrapesJS — dùng editor thật, không mock Stitch | — |

## Ghi chú khi implement (khớp spec, sửa copy do Stitch tự thêm)

- **Auth banner (Clone Progress):** Stitch chèn chữ "Cloudflare Turnstile / bot clearance / human-in-the-loop". **Bỏ.** Copy cuối: "Trang X cần đăng nhập — Mở cửa sổ để đăng nhập, rồi bấm Tiếp tục". Không bypass anti-bot (spec §0 Ngoài phạm vi).
- **Provider settings:** giữ đúng 2 nút "Add Anthropic Compatible" / "Add OpenAI Compatible", Fetch models, Test, gán role vision/code/design. Bỏ model id demo Stitch bịa.
- **Phase stepper:** đúng 9 pha spec §4: discover→capture→assets→ir→name→emit→qa→fix→done.
- **Status pill:** draft, running, paused, interrupted, needs_auth, failed, completed (spec §4).
- **Dùng lại design system** này làm token gốc, không copy HTML Stitch vào production (Stitch xuất Tailwind CDN — SP1 dùng CSS token thật).
