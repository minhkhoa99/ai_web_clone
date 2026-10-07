# SP1 UI — Stitch Design Reference (element map)

Stitch project: **AI Web Clone Tool** (`projects/5886124613364668099`). Design system `assets/12550457517034224226`: dark; Space Grotesk headline, Inter body, JetBrains Mono for labels/URLs/code/numbers; token Stitch xuất ra: primary `#c0c1ff`, primary-container `#8083ff` (xem spec parity §1); success `#4ae176`, warn `#ffb95f`, danger `#ffb4ab`.

Nguồn sự thật: spec `docs/superpowers/specs/2026-09-24-sp1-ui-stitch-parity-design.md` (token §1, shell + component §2, element §3, drift §5). Bản tải về (HTML + PNG 2560px) ở `docs/superpowers/design/stitch/` — chỉ tham khảo bố cục; mọi thứ Stitch tự bịa là drift (cuối file). Mỗi element có `data-ui="<ui_id>"` trong DOM.

**Lưu ý:** PNG của Stitch là ảnh chụp 2x của layout ~1280px — kích thước lấy từ class Tailwind trong file HTML mockup, không bao giờ đo bằng pixel PNG (P22).

Trạng thái: **build** = đã dựng; **out_of_scope** = node giữ trong graph, không dựng; **alias** = id cũ gộp vào id khác.

## Ghi chú copy bắt buộc

- **Auth banner (Tiến độ):** "Trang <url> cần đăng nhập — Mở cửa sổ để đăng nhập, rồi bấm Tiếp tục" (không Cloudflare/Turnstile/clearance). Không bypass anti-bot: gặp login/CAPTCHA → `needs_auth`, người dùng tự xử lý trong cửa sổ Chrome.
- **Provider settings:** đúng 2 nút "Add Anthropic Compatible" / "Add OpenAI Compatible"; không model id cứng.
- **Phase stepper:** đúng 9 pha: discover → capture → assets → ir → name → emit → qa → fix → done.
- **Status pill:** draft, running, paused, interrupted, needs_auth, failed, completed (chữ = mã trạng thái) + "đang chờ".

## Shell (mọi màn) — `src/app/_ui/Shell.tsx`

Screens: `screen_history`, `screen_new_clone`, `screen_settings_ai`, `screen_sitemap`, `screen_progress`, `screen_qa_preview`, `screen_code_viewer`, `screen_editor`. Mockup: header + sidebar trái của mọi file (`history-alt3.png` chuẩn).

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_shell_header` | `feat_history_resume` | — | header `h-14` | build |
| `ui_shell_new_clone_cta` | `feat_crawl` | route `/new` | header phải "+ New Clone" | build |
| `ui_shell_settings_link` | `feat_ai_gateway` | route `/settings/ai` | header phải icon settings | build |
| `ui_shell_sidebar_nav` | `feat_history_resume`, `feat_crawl`, `feat_ai_gateway` | `usePathname()` | sidebar `w-56` | build |
| `ui_shell_project_nav` | `feat_job_queue_sse`, `feat_qa_score`, `feat_editor`, `feat_export` | route `/p/[id]/*` | sidebar (không có tương đương thật) | build |
| `ui_shell_page_header` | `feat_history_resume` | `PageHeader` | vùng tiêu đề trang | build |

## `/settings/ai` ↔ `screen_settings_ai` ↔ `settings-ai.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_settings_ai_page_header` | `feat_ai_gateway` | — | tiêu đề trên cùng | build |
| `ui_settings_ai_add_provider_buttons` | `feat_ai_gateway` | `POST /api/providers` | góc phải header | build |
| `ui_settings_ai_endpoint_list` | `feat_ai_gateway` | `GET /api/providers` | card "Configured Endpoints" | build |
| `ui_settings_ai_endpoint_filter` | `feat_ai_gateway` | client | ô lọc dưới title card | build |
| `ui_settings_ai_endpoint_row` | `feat_ai_gateway` | `GET /api/providers` + state Test | hàng endpoint | build |
| `ui_settings_ai_test_endpoint` | `feat_ai_gateway` | `POST /api/providers/test` (`latencyMs`, `httpStatus`) | bolt + "Test Endpoint" | build |
| `ui_settings_ai_row_menu` | `feat_ai_gateway` | `PATCH`/`DELETE /api/providers/[id]` | kebab | build |
| `ui_settings_ai_config_panel` | `feat_ai_gateway` | — | card "Provider Configuration" | build |
| `ui_settings_ai_display_name` | `feat_ai_gateway` | `name` | "Provider Display Name" | build |
| `ui_settings_ai_protocol` | `feat_ai_gateway` | `kind` | "Protocol Standard … LOCKED" | build |
| `ui_settings_ai_base_url` | `feat_ai_gateway` | `baseUrl` | "Upstream Base URL" | build |
| `ui_settings_ai_api_key` | `feat_ai_gateway` | `apiKey` (chỉ gửi đi) | "Secret API Token" | build |
| `ui_settings_ai_fetch_models` | `feat_ai_gateway` | `POST /api/providers/models` | "Fetch Models" | build |
| `ui_settings_ai_role_matrix` | `feat_ai_gateway`, `feat_section_naming`, `feat_fix_loop` | `roles` của provider | card "Engine Role Assignment" | build |
| `ui_settings_ai_save_provider` | `feat_ai_gateway` | `POST`/`PATCH /api/providers` | "Discard Changes" / "Save Provider" | build |
| `ui_settings_ai_default_model` | `feat_ai_gateway` | — | "Default Primary Model" | out_of_scope |

## `/` ↔ `screen_history` ↔ `history-alt3.png` (chuẩn), `history.png`, `history-alt1.png`, `history-alt2.png`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_history_page_header` | `feat_history_resume` | `counts` | tiêu đề + "24 recorded" | build |
| `ui_history_status_tabs` | `feat_history_resume` | `GET /api/projects` `counts` | tab trái có count | build |
| `ui_history_url_search` | `feat_history_resume` | `GET /api/projects?q=` | ô search | build |
| `ui_history_refresh` | `feat_history_resume` | `GET /api/projects` | nút refresh | build |
| `ui_history_job_rows` | `feat_history_resume` | `GET /api/projects` | bảng + header band | build |
| `ui_history_row_thumb` | `feat_capture_dom` | `thumbPage` → `shots/1440.png` | thumbnail 100×64 | build |
| `ui_history_row_url` | `feat_history_resume` | `url` | URL + open_in_new | build |
| `ui_history_row_subtitle` | `feat_history_resume`, `feat_crawl` | `mode`, `pageCount`, `createdAt` | dòng phụ dưới URL | build |
| `ui_history_failed_error_log` | `feat_history_resume` | `lastError` | dòng đỏ lỗi | build |
| `ui_history_needs_auth_status` | `feat_auth` | `status`, `lastError.code` | hàng amber | build |
| `ui_history_status_pill` | `feat_job_queue_sse` | `status`, `queued` | cột STATUS | build |
| `ui_history_progress_bar` | `feat_job_queue_sse` | `phase`, `phaseDone/phaseTotal`, `progress`, `updatedAt` | cột pha + thanh màu | build |
| `ui_history_row_actions` | `feat_history_resume` | — | cột ACTIONS | build |
| `ui_history_pause_button` | `feat_history_resume` | `POST …/pause` | pause | build |
| `ui_history_resume_button` | `feat_history_resume` | `POST …/resume` | play_arrow | build |
| `ui_history_open_button` | `feat_history_resume` | route | visibility | build |
| `ui_history_reclone_button` | `feat_history_resume`, `feat_crawl` | `/new?from=` | replay | build |
| `ui_history_download_export` | `feat_export` | `POST …/export {mode:"zip"}` | download | build |
| `ui_history_delete_button` | `feat_history_resume` | `DELETE /api/projects/[id]` | delete | build |
| `ui_history_pagination` | `feat_history_resume` | `total`, `page`, `pageSize` | footer phân trang | build |
| `ui_history_empty` | `feat_history_resume` | — | — | build |
| `ui_history_status_filter` | `feat_history_resume` | — | tab Failed | out_of_scope |
| `ui_history_inject_auth` | `feat_auth` | — | "Inject Auth" (`drift_history_inject_auth`) | out_of_scope |
| `ui_history_vi_status_tabs` | `feat_history_resume` | — | — | alias → `ui_history_status_tabs` |
| `ui_history_search` | `feat_history_resume` | — | — | alias → `ui_history_url_search` |
| `ui_history_interrupted_resume` | `feat_history_resume` | — | — | alias → `ui_history_resume_button` |

## `/new` ↔ `screen_new_clone` ↔ `new-clone.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_new_clone_page_header` | `feat_crawl` | — | "New Clone Configuration" | build |
| `ui_new_clone_card` | `feat_crawl` | — | card giữa | build |
| `ui_new_clone_url_input` | `feat_crawl` | `url` | "Website URL" | build |
| `ui_new_clone_mode_toggle` | `feat_crawl` | `mode` | "Single page / Crawl site" | build |
| `ui_new_clone_crawl_limits` | `feat_crawl` | `maxPages`, `depth`, `concurrency`, `delayMs` | "CRAWL CONSTRAINTS" | build |
| `ui_new_headed_toggle` | `feat_headed_browser` | `headed` (config, mặc định `false`) — checkbox "Hiện trình duyệt khi chạy" (hardening §5) | không có trong mockup, dùng token/component sẵn có | build |
| `ui_new_clone_auth_select` | `feat_auth` | `auth.mode` | "Authentication" | build |
| `ui_new_clone_auth_credentials` | `feat_auth` | `credentials` | "Username / Password" | build |
| `ui_new_clone_auth_selectors` | `feat_auth` | `auth.selectors` | "Optional selectors" | build |
| `ui_new_clone_manual_login` | `feat_auth` | `POST …/auth/open`, `POST …/crawl` | — | build |
| `ui_new_clone_qa_threshold` | `feat_qa_score` | `threshold` | "QA threshold" slider | build |
| `ui_new_threshold_warning` | `feat_qa_score` | `threshold > 98` (client) — Banner warn "Ngưỡng rất cao: …" (hardening §6) | không có trong mockup, dùng token/component sẵn có | build |
| `ui_new_clone_token_budget` | `feat_ai_gateway` | `tokenBudget` | "Token budget" | build |
| `ui_new_clone_output_format` | `feat_emit_html` (SP2 card = `feat_framework_emitters_sp2`, không build) | HTML | lưới card output | build |
| `ui_new_clone_cancel` | `feat_crawl` | route `/` | "Cancel" | build |
| `ui_new_clone_preview_sitemap` | `feat_crawl` | `POST /api/projects`, `POST …/crawl` | "Preview sitemap →" | build |
| `ui_new_clone_error` | `feat_crawl` | — | — | build |

## `/p/[id]/sitemap` ↔ `screen_sitemap` ↔ `sitemap.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_sitemap_page_header` | `feat_crawl` | `project`, `discover.json` | breadcrumb + title + chip origin | build |
| `ui_sitemap_select_all` | `feat_crawl` | client | "Select all (34)" | build |
| `ui_sitemap_cost_estimate` | `feat_crawl`, `feat_ai_gateway` | `estimateRun()` (`core/estimate.ts`) | "~1.2M tokens" | build |
| `ui_sitemap_route_search` | `feat_crawl` | client | "Filter routes…" | build |
| `ui_sitemap_expand_collapse` | `feat_crawl` | client | "Expand / Collapse" | build |
| `ui_sitemap_filter_tabs` | `feat_crawl`, `feat_auth` | `discover.json` + capture dates | "All / Public / Auth Gated / Modified" | build |
| `ui_sitemap_route_tree` | `feat_crawl` | `buildRouteTree()` | bảng cây | build |
| `ui_sitemap_http_status` | `feat_crawl` | `CrawlPage.status/loadMs/redirected` | "200 OK 1.2s" | build |
| `ui_sitemap_auth_gated_rows` | `feat_auth` | `needsAuth` | hàng amber | build |
| `ui_sitemap_captured_at` | `feat_capture_dom` | capture tasks done | "Captured: …" | build |
| `ui_sitemap_protected_banner` | `feat_auth` | `POST …/auth/open`, `POST …/session/import` | "Protected Routes Detected" | build |
| `ui_sitemap_action_bar` | `feat_crawl` | client | thanh đáy dính | build |
| `ui_sitemap_runtime_estimate` | `feat_crawl` | `estimateRun().seconds` | "Est. runtime" | build |
| `ui_sitemap_cancel` | `feat_crawl` | route `/` | "Cancel" | build |
| `ui_sitemap_start_clone` | `feat_crawl`, `feat_job_queue_sse` | `POST …/start` (đóng cửa sổ đăng nhập trước, D8) | "Start clone" | build |
| `ui_sitemap_recrawl` | `feat_crawl` | `POST …/crawl` | — | build |
| `ui_sitemap_session_tools` | `feat_auth` | `POST …/session/clear`, `…/session/import` | — | build |
| `ui_sitemap_locked_note` | `feat_crawl` | `status !== "draft"` — Banner info "Đã bắt đầu clone — danh sách trang đã chốt. Dùng Clone lại để quét lại." (hardening §3) | không có trong mockup, dùng token/component sẵn có | build |

## `/p/[id]` ↔ `screen_progress` ↔ `progress.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_progress_page_header` | `feat_job_queue_sse` | — | — | build |
| `ui_progress_context_bar` | `feat_job_queue_sse` | `project`, SSE `status`/`progress` | "Target Origin" + pill | build |
| `ui_progress_stats_bar` | `feat_job_queue_sse`, `feat_ai_gateway` | event `at`, `progress.tokensUsed`, `tokenBudget` | "elapsed", "Tokens" | build |
| `ui_progress_controls` | `feat_history_resume` | `POST …/pause`, `…/resume` | "Pause / Resume" | build |
| `ui_progress_phase_stepper` | `feat_job_queue_sse` | tasks + SSE | stepper 9 pha | build |
| `ui_progress_auth_banner` | `feat_auth` | `POST …/auth/open`, `…/auth/continue` | "Action Required" banner | build |
| `ui_progress_credentials_form` | `feat_auth` | `…/resume`, `…/auth/continue` + `credentials` | — | build |
| `ui_progress_page_list` | `feat_capture_dom`, `feat_asset_download` | `pageStates()` + `pages.json` + SSE | pane trái | build |
| `ui_progress_page_counts` | `feat_job_queue_sse` | `pageStates()` + tasks running | footer pane trái | build |
| `ui_progress_log_stream` | `feat_job_queue_sse` | SSE `history` + event log bền (`core/event-log.ts`) | pane log | build |
| `ui_progress_log_level_filter` | `feat_job_queue_sse` | client | "All / Info / Warn / Error" | build |
| `ui_progress_log_toggles` | `feat_job_queue_sse` | client | "Auto-scroll / Wrap lines" | build |
| `ui_progress_log_line` | `feat_job_queue_sse` | event `at` | dòng log | build |
| `ui_progress_session_tools` | `feat_auth` | session routes | — | build |
| `ui_progress_reason_banner` | `feat_error_surfacing` | `status_reason` + `error_msg` + `error-hints.ts` (failed = danger, completed = warn) (hardening §4) | không có trong mockup, dùng token/component sẵn có | build |
| `ui_progress_error_panel` | `feat_error_surfacing` | task có `error_code` (pha, trang·section, mã, thông báo, gợi ý); rỗng thì ẩn (hardening §4) | không có trong mockup, dùng token/component sẵn có | build |
| `ui_progress_download_log` | `feat_error_surfacing` | `GET /api/projects/[id]/log` (`run.prev.log` + `run.log`) — nút "Tải log" trong `ui_progress_controls` (hardening §4) | không có trong mockup, dùng token/component sẵn có | build |
| `ui_progress_inspect_snapshot` | `feat_capture_dom` | — | "Inspect DOM Snapshot" | out_of_scope |

## `/p/[id]/preview` ↔ `screen_qa_preview` ↔ `qa-preview.png|html`, `qa-preview-alt.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_qa_preview_page_header` | `feat_qa_score` | — | "stripe.com-pricing / …" | build |
| `ui_qa_preview_page_select` | `feat_qa_score` | `pages` | — | build |
| `ui_qa_preview_breakpoint_switch` | `feat_qa_score` | scores theo bp | "375 / 768 / 1440" | build |
| `ui_qa_preview_compare_modes` | `feat_qa_score` | shots + iframe clone | "Side by Side / Onion / Swipe" | build |
| `ui_qa_preview_overlay_slider` | `feat_qa_score` | client | "Blend 65%" | build |
| `ui_qa_preview_heatmap_toggle` | `feat_qa_score` | `scores[].heatPath` | "Heatmap On" | build |
| `ui_qa_preview_match_score` | `feat_qa_score` | scores (trung bình, D6) | "96.2% Match" | build |
| `ui_qa_preview_rerun_qa` | `feat_qa_score`, `feat_editor` | `POST …/qa/rescore` | "Re-run Diff" | build |
| `ui_qa_preview_export_button` | `feat_export` | route `/p/[id]/code` | "Export" | build |
| `ui_qa_preview_side_by_side_panes` | `feat_qa_score` | shots, iframe | 2 pane có chrome | build |
| `ui_qa_preview_sync_scroll` | `feat_qa_score` | 1 vùng cuộn chung | "Sync Scroll" (không render toggle) | build |
| `ui_qa_preview_rail_tabs` | `feat_qa_score`, `feat_interaction_scan` | scores, interactions | "Sections / Coverage checklist" | build |
| `ui_qa_preview_summary` | `feat_qa_score` | scores, `threshold` | "7 Passing • 1 Action Item" | build |
| `ui_qa_preview_section_scores` | `feat_qa_score`, `feat_section_naming` | `sections`, `scores` | hàng section | build |
| `ui_qa_preview_fix_request` | `feat_fix_loop`, `feat_editor` | `fixes` trong `GET …/preview` | card đỏ "FIX REQ" | build |
| `ui_qa_preview_next_diff` | `feat_qa_score` | scores | "Jump to next diff" | build |
| `ui_qa_preview_coverage_checklist` | `feat_interaction_scan` | `interactions`, `coverage` | "COVERAGE CHECKLIST" | build |
| `ui_qa_preview_skipped_item` | `feat_interaction_scan` | `status=skipped` | "— … skipped" | build |
| `ui_qa_preview_behavior_list` | E2 §5 QA hành vi | `behavior` trong `GET …/preview` (rỗng khi stale) — trong tab Checklist, lọc theo trang đang xem | không có trong mockup, dùng token/component sẵn có | build |
| `ui_qa_preview_fidelity_panel` | E1 §5 Fidelity (chưa có node `feat_*`) | `fidelity` trong `GET …/preview` (≤2000 mục) — tab thứ 3 "Fidelity (n)" của `ui_qa_preview_rail_tabs` | không có trong mockup, dùng token/component sẵn có | build |
| `ui_qa_preview_fidelity_summary` | E1 §5 Fidelity | tổng theo status (Badge success/warn/danger: hỗ trợ / một phần / không hỗ trợ), theo bộ lọc trang; không gộp vào điểm pixel | không có trong mockup, dùng token/component sẵn có | build |
| `ui_qa_preview_fidelity_filters` | E1 §5 Fidelity | client — select Trang (Tất cả trang + từng trang) và Trạng thái | không có trong mockup, dùng token/component sẵn có | build |
| `ui_qa_preview_fidelity_list` | E1 §5 Fidelity | mỗi mục một thẻ (status, feature, trang, bp, note); mục `script` nhiều trang gộp 1 dòng "N trang"; "Tới node" chỉ khi trang clone đang tải có `data-ir-id` đó, không thì hiện `nguồn: sourceRef` | không có trong mockup, dùng token/component sẵn có | build |
| `ui_qa_preview_fidelity_export` | E1 §5 Fidelity | client — "Xuất JSON" đúng dữ liệu đang lọc (`{ page, status, counts, items }`) | không có trong mockup, dùng token/component sẵn có | build |

## `/p/[id]/code` ↔ `screen_code_viewer` ↔ `code-viewer.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_code_viewer_page_header` | `feat_export` | `project` | — | build |
| `ui_code_viewer_file_search` | `feat_export` | danh sách file (≤2000) | "Search project files…" | build |
| `ui_code_viewer_file_tree` | `feat_emit_html` | `listOut` | cây "out" | build |
| `ui_code_viewer_file_header` | `feat_emit_html` | `stat` + nội dung | chip file + size + lines | build |
| `ui_code_viewer_copy_button` | `feat_export` | files route (out/) | "Copy" | build |
| `ui_code_viewer_strip_ids` | `feat_export` | `stripIds` | — | build |
| `ui_code_viewer_export_zip` | `feat_export` | `POST …/export {mode:"zip"}` | "Export ZIP" | build |
| `ui_code_viewer_export_folder` | `feat_export` | `POST …/export {mode:"folder"}` | "Export to folder" | build |
| `ui_code_viewer_code_pane` | `feat_emit_html` | shiki | code + gutter | build |
| `ui_code_viewer_wrap_toggle` | `feat_emit_html` | client | — | build |
| `ui_code_viewer_build_status` | `feat_export` | `listOut` + `stat` (`mapLimit(8)`) | footer | build |

## `/p/[id]/editor` ↔ `screen_editor` — visual editor E3 (GrapesJS ở "Editor cũ" tới hết E3a), không có mockup Stitch (chỉ token + chrome)

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_editor_page_header` | `feat_editor` | — | — | build |
| `ui_editor_toolbar` | `feat_editor` | `GET …/editor`, `POST …/editor/{commands,undo,redo}` + `pageId`, `?page=`, `?legacy=1` | — | build |
| `ui_editor_canvas_chrome` | `feat_editor`, `feat_ir` | khung canvas E3; GrapesJS chỉ ở `?legacy=1` | — | build |
| `ui_editor_canvas_frame` | `feat_editor`, `feat_ir` | E3 §1 iframe `srcdoc` sandbox (`page.html` của `GET …/editor`), click → chọn, link/form không điều hướng | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_bp_switch` | `feat_editor` | E3 §1 SegmentedControl "Thiết bị" 1440/768/375 = độ rộng iframe + `target` của setStyle | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_save_state` | `feat_editor` | E3 §4 "Đã lưu" / "Đang lưu…" theo command bus | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_legacy_link` | `feat_editor` | E3 §2 link "Editor cũ" → `?legacy=1` (chỉ E3a) | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_stale_banner` | `feat_editor` | E3 §7 Banner "Tải lại" (409) / "Thử lại" (lỗi mạng, 503) | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_layers` | `feat_editor`, `feat_ir` | E3 §4 cột trái Layers | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_right_tabs` | `feat_editor` | E3 §4 tab Style / Component / Hiệu ứng | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_effects_panel` | `feat_editor` | `effects` | — | build |
| `ui_editor_sections_panel` | `feat_editor`, `feat_ir` | `…/editor/promote-layout` | — | build |
| `ui_editor_component_panel` | `feat_editor`, `feat_interaction_scan` | E2 §7 Card "Component" ở rail phải khi node đang chọn thuộc một `interactive` (hoặc nút đánh dấu khi không thuộc) — `interactives` trong `GET …/editor` | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_component_header` | `feat_editor`, `feat_interaction_scan` | E2 §7 kind · nguồn · độ tin cậy + Badge Fidelity; dòng nhắc "Clone lại để đọc cấu hình thật" khi `guessed` — `interactives[].spec`, `fidelity` | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_component_items` | `feat_editor`, `feat_interaction_scan` | E2 §7 danh sách item (thumbnail cắt từ shot 1440 + tên), kéo thả + nút ↑↓, Nhân bản, Xoá; bấm item → canvas hiện item đó (`aiwc:show`) — `POST …/editor/commands` add/remove/moveComponentItem; `shot` | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_component_item` | `feat_editor`, `feat_interaction_scan` | E2 §7 một item của danh sách — như trên | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_component_form` | `feat_editor`, `feat_interaction_scan` | E2 §7 form cấu hình theo kind (carousel/tabs/accordion/modal/dropdown/menu/video) — `updateComponent` | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_component_unwrap` | `feat_editor`, `feat_interaction_scan` | E2 §7 nút "Bỏ hành vi" — `unwrapComponent` | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_component_convert` | `feat_editor`, `feat_interaction_scan` | E2 §7 nút "Đánh dấu là component…" khi node không thuộc component — mở wizard | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_component_show_on_canvas` | `feat_editor`, `feat_interaction_scan` | E2 §7 nút "Mở trên canvas" cho modal / dropdown / menu (không có danh sách item); rời component → đóng lại (`aiwc:hide`) — `aiwc:show` qua postMessage, không lưu | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_component_wizard` | `feat_editor`, `feat_interaction_scan` | E2 §7 wizard chọn kind + vai trò trong node đang chọn và con cháu (≤ 100) — `convertToComponent` | không có trong mockup, dùng token/component sẵn có | build |

## Drift — danh sách chính thức (59 id, không render, không implement)

Không `ui_*` nào nối tới `drift_*`, trừ `ui_history_inject_auth` (out_of_scope) ↔ `drift_history_inject_auth`.

| drift id | Chuỗi / phần tử Stitch | Mockup |
|---|---|---|
| `drift_history_cloudflare_bot` | "Cloudflare Bot Management Challenge" (hàng failed) | `history.html` |
| `drift_history_cluster_metrics` | us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers | `history-alt1.html` |
| `drift_history_engine_filter` | Engine filter (Playwright DOM / Puppeteer / Static Wget AST) | `history.html` |
| `drift_history_fake_engines` | Chromium Headless, Playwright Spider, Wasm Synthesizer / Engine Pool | `history-alt2.html` |
| `drift_history_inject_auth` | nút "Inject Auth" trên hàng Cloudflare Turnstile | `history-alt1.html` |
| `drift_history_invented_nav` | Engines, DOM Rules, Tokens & Budget, Telemetry, Keyring & Auth, Run Test, Deploy Clone, CLONE//ARCH | `history-alt1.html` |
| `drift_history_nav_artifacts_audit` | Configure / Pipeline / Artifacts / Audit, Deploy Clone | `history.html` |
| `drift_history_stealth_engine` | "Puppeteer Stealth" | `history-alt3.html` |
| `drift_history_trace_button` | "Trace" / nút terminal trên hàng failed | `history-alt2.html` |
| `drift_history_cluster_telemetry` | Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar | `history.html` |
| `drift_progress_system_telemetry` | Mem/CPU/Network, socket :9422, worker threads | `progress.html` |
| `drift_progress_turnstile_wording` | "Cloudflare Turnstile detected / headless browser clearance" | `progress.html` |
| `drift_sitemap_turnstile_bypass` | "Configure Turnstile Bypass" / "Turnstile pass" | `sitemap.html` |
| `drift_sitemap_capture_telemetry` | cột cached, asset KB; Engine DOM v3 + Tailwind JIT | `sitemap.html` |
| `drift_sitemap_extra_nav` | Projects / Pipelines / Diff QA / Templates / Execution IR / Asset Store | `sitemap.html` |
| `drift_new_clone_fake_telemetry` | PIPELINE SYNTH_CHROMIUM_V8, cluster us-east-1a, DNS IP | `new-clone.html` |
| `drift_new_clone_figma_tokens` | output "Figma Tokens (DTCG schema)", "Markdown" | `new-clone.html` |
| `drift_new_clone_nav_artifacts_audit` | Configure / Pipeline / Artifacts / Audit, Deploy Clone, Engine Pool | `new-clone.html` |
| `drift_new_clone_cookie_vault` | "Session Cookie Vault" / "Save as preset" | `new-clone.html` |
| `drift_qa_preview_auto_reconcile_css` | "Auto-reconcile CSS" / "Approve & Deploy" | `qa-preview.html` |
| `drift_qa_preview_fake_engine_labels` | Puppeteer Headless, Vite + Tailwind JIT, AST v3.1, DPR 2.0x | `qa-preview-alt.html` |
| `drift_qa_preview_fake_telemetry` | AST Worker Node #4, DOM nodes, latency, memory | `qa-preview.html` |
| `drift_qa_preview_invented_nav` | Projects, Pipelines, Templates, Execution IR, Asset Store, System Logs, Terminal CLI, PID | `qa-preview.html` |
| `drift_code_viewer_devbrowser_brand` | "DevBrowser static generator" | `code-viewer.html` |
| `drift_code_viewer_git_branch` | Git tab / "main branch" / "Synced 2m ago" | `code-viewer.html` |
| `drift_settings_ai_aes_vault_claim` | "Stored with AES-256 GCM in local daemon vault" | `settings-ai.html` |
| `drift_settings_ai_audit_export` | Audit Logs / Export Config (JSON) | `settings-ai.html` |
| `drift_settings_ai_failover_router` | Failover strategy / fallback router to local vLLM | `settings-ai.html` |
| `drift_settings_ai_fake_model_ids` | claude-3-7-sonnet-20250219, gpt-4o, qwen-2.5-coder | `settings-ai.html` |
| `drift_settings_ai_telemetry` | Upstream Telemetry (requests/error rate/latency, uptime, gateway port) | `settings-ai.html` |
| `drift_shell_version_chips` | "v2.4.0-edge • PID 4921", "Daemon v2.4.0", "CORE v2.4.0-rc1", "WebClone Core", "PID 4921 DAEMON SYNC" | mọi mockup (header/sidebar trên) |
| `drift_shell_workspace_switcher` | "Project Alpha" + chọn workspace | `new-clone.html`, `history*.html` |
| `drift_shell_notification_bell` | chuông thông báo + chấm cam | mọi mockup (header phải) |
| `drift_shell_terminal_cli` | icon terminal, nút "Terminal CLI" | mọi mockup |
| `drift_shell_tune_icon` | icon `tune` ở header | mọi mockup |
| `drift_shell_avatars` | avatar "DX" / "WC" / "CL" | mọi mockup (header phải) |
| `drift_shell_docs_links` | "Docs", "API Proxy Docs" | header, sidebar dưới, footer settings |
| `drift_shell_task_ids` | "Task #8942", "#8942-PRICING", "Diff QA #8942", crumb "Pipelines" | `sitemap.html`, `progress.html`, `qa-preview.html` |
| `drift_history_page_type_badges` | badge thumbnail DOM / SPA / AUTH / DOCS / HTML / ERR | `history*.html` |
| `drift_history_target_wording` | "Target: DOM + CSS Assets", "Target: Full SPAs • SSR hydration dump", "HTML+Tailwind export • 18.4MB bundle • Zero diff errors", "ready • bundle exported" | `history*.html` |
| `drift_history_copy_icon` | icon copy/docs trên hàng completed | `history.html` |
| `drift_new_clone_task_config_chips` | "TASK CONFIG 0X88F", "READY", "DOM v3 Parser • Headless Chromium" | `new-clone.html` |
| `drift_new_clone_polite_rate_badge` | "Polite rate limiting active", hint "limit/hops/workers", hậu tố "PGS/LVL/THRD" | `new-clone.html` |
| `drift_new_clone_fidelity_badge` | "HIGH FIDELITY" | `new-clone.html` |
| `drift_new_clone_budget_helper_copy` | "Allocated for AST layout synthesis, multi-pass stylesheet reconciliation, and icon vectorization.", "Target AST dialect" | `new-clone.html` |
| `drift_sitemap_stage_chip` | "Stage 3: AST Scoping" | `sitemap.html` |
| `drift_sitemap_har_import` | "Inject Cookies (.har)" (bản hợp lệ = cookie/storageState JSON) | `sitemap.html` |
| `drift_settings_ai_version_badges` | "v2.4-gateway", "ROUTER ACTIVE", "MATRIX v1.2", "GATEWAY" | `settings-ai.html` |
| `drift_settings_ai_role_badges` | "High Precision", "Low Latency", "Token Extractor" + mô tả vai trò sai | `settings-ai.html` |
| `drift_settings_ai_extra_kinds` | badge "VLLM / OAI", "OLLAMA" | `settings-ai.html` |
| `drift_settings_ai_config_id_line` | "ID: prov_anthropic_v1 // status: 200 OK" | `settings-ai.html` |
| `drift_settings_ai_model_cache_age` | "Cached 4 mins ago", "Sync: OK" | `settings-ai.html` |
| `drift_progress_worker_tags` | "[worker#01]", "Thread #04", "stdout & ast-worker.log PID 4921" | `progress.html` |
| `drift_qa_preview_pixel_qa_badge` | "Pixel QA 1 Diff" | `qa-preview.html` |
| `drift_qa_preview_source_ref` | "card-hero.tsx:42" (output là HTML thuần) | `qa-preview.html` |
| `drift_qa_preview_synthesis_wording` | "SYNTHESIS COVERAGE CHECKLIST", "verified", "untriggered" | `qa-preview.html` |
| `drift_code_viewer_build_successful` | "Build Successful" | `code-viewer.html` |
| `drift_code_viewer_export_package` | nút "Export Package" (trùng Export ZIP) | `code-viewer.html` |
| `drift_code_viewer_encoding_label` | "HTML5 / UTF-8" | `code-viewer.html` |

## Errata / quyết định khi triển khai (2026-09-26)

Các sửa spec parity (`2026-09-24-sp1-ui-stitch-parity-design.md`) theo ruling controller trong `progress.md`, ghi lại ở đây vì graph đọc file này:

- **P6** (§3.6): pane so sánh lấp đầy vùng ở 1440 — sidebar 224px + rail 380px làm "≥500px mỗi pane ở 1440" bất khả thi; tiêu chí đạt là ≥500px ở 1920 (không phải 1440).
- **P7** (§1.5): map alias icon — `IconName` giữ tên spec, file SVG dùng: `expand_more→keyboard_arrow_down`, `phone_iphone→mobile`, `auto_fix_high→wand_stars`, `generating_tokens→token` (4 tên không có file trùng khớp trong gói `@material-symbols/svg-400`).
- **P24** (§3.4 `ui_sitemap_page_header`): chip origin dùng icon `language` thay vì `public` của mockup (`public` không có trong subset 72 icon cố định).
- **P10** (§3.8 `ui_editor_toolbar`): `?page=` đọc phía server (không phải client), truyền xuống làm prop; id không hợp lệ → dùng trang đầu tiên.
- **P12** (§3.2/§3.5 `RelTime`): chữ tương đối dùng `Intl.RelativeTimeFormat("vi", { numeric: "auto" })` (không tự viết wording tiếng Việt).
- **P20** (§3.3 `/new`): tiêu đề/subtitle/divider nằm trong card form (theo mockup), không phải `PageHeader` full-width toàn trang như các màn khác.
- **P23** (§3.4 `ui_sitemap_start_clone`, `ui_sitemap_action_bar`): nút Bắt đầu clone và thanh action bar theo đúng mockup (`font-label-md`, `px-4 py-1.5`, thanh cao `h-14`), không phải "primary lớn" như chữ spec.
- **P25** (§3.6 toolbar): khi slider Chồng mờ/Trượt so sánh hiện, nó chỉ hiện "<n>%" (nhãn đầy đủ trong `aria-label`) và các nút chế độ so sánh bỏ icon, để giữ toolbar 1 hàng ở 1440.
- **P22** (áp dụng mọi màn): PNG Stitch là ảnh chụp 2x của layout ~1280px — kích thước lấy từ class trong HTML mockup, không đo bằng pixel PNG.
- **§4.7 (số query danh sách lịch sử):** route `/api/projects` GET chạy tối đa **4** câu SQL cố định mỗi request, đúng chữ spec (không phụ thuộc số dòng): `counts`, `rows`, `agg` (theo phase), `errs` (lastError); `total` suy ra từ `counts` theo `group` (không có query `total` riêng).
- **Subtitle 1 trang (`ui_history_row_subtitle`):** số trang chỉ hiện ở chế độ crawl: `"Crawl · <n> trang · bắt đầu <RelTime>"`; dự án `mode=single` hiện `"1 trang · bắt đầu <RelTime>"` (không lặp "1 trang · 1 trang" như format spec §3.2 gốc). Draft chưa chọn trang giữ `"<mode> · chưa chọn trang · tạo <RelTime>"`.
- **D1 (tự host icon):** Material Symbols Outlined tự host dưới dạng SVG subset đã commit `src/app/_ui/icons.gen.ts`, sinh bởi `scripts/gen-icons.mjs` (đọc `@material-symbols/svg-400`); không dùng icon font hay CDN lúc chạy.

## Hardening sau lần chạy thật (2026-09-26)

Spec: `docs/superpowers/specs/2026-09-26-sp1-realrun-hardening-design.md` (ghi đè spec gốc khi mâu thuẫn). 6 `ui_*` mới ở bảng trên (`ui_new_headed_toggle`, `ui_new_threshold_warning`, `ui_sitemap_locked_note`, `ui_progress_reason_banner`, `ui_progress_error_panel`, `ui_progress_download_log`) không có trong mockup Stitch. Ruling khi triển khai (`.superpowers/sdd/2026-09-26-sp1-realrun-hardening/progress.md`):

- **Tạm dừng = dừng ngay** (ghi đè spec gốc §4): huỷ AI + đóng browser, task `running` → `pending`; pause giữa lúc ghi fix để lại task fix `pending` — Tiếp tục cho thêm tối đa 3 vòng mỗi section (giống khôi phục sau crash).
- **Lỗi AI tạm thời trong fix** (không phải breaker mở): section đó đỏ, project không `failed`.
- **Sửa tay thắng**: Lưu/Gộp layout trong Editor khi project chưa `completed` đóng mọi task fix `pending`/`failed` (`done`, "Đã sửa tay trong Editor — bỏ vòng sửa AI.").
- **Chạy lại QA** bấm lại khi đang chờ → 409 `BAD_STATE` ("đang chạy"), không phải `PROJECT_BUSY`.
- **Preview fix-card**: section bị dừng AI hiện "Dừng sửa: <mã>." (budget: "Dừng sửa: hết ngân sách token.").
- **`run.log`**: dòng stack tiếp theo thụt tab (mỗi mục vẫn bắt đầu `ISO LEVEL`).
- **Section rác**: lọc ở mọi bước unwrap (trước kiểm tra một-con), rỗng thì dùng danh sách chưa lọc; `display:contents` không tính là rác; root cỡ 0 không chấm QA.
