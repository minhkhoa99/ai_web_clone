# AI Web Clone Tool — project rules for AI agents

Nguồn sự thật (đọc theo thứ tự):
1. `docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md` — spec SP1 (đã duyệt)
2. `docs/superpowers/plans/2026-09-23-sp1-clone-engine.md` — plan 27 task
3. `docs/superpowers/design/stitch-screens.md` — map route ↔ màn Stitch + các sửa bắt buộc
4. `rules.md` — lean + bounded + predictable

## Traceability graph (graphify) — bắt buộc tra trước khi làm

`graphify-out/graph.json` map: Feature (`feat_*`) ↔ Screen (`screen_*`) ↔ UI element (`ui_*`) ↔ Task (`task_T0..T26`) ↔ Module (`mod_*`) ↔ Spec section (`spec_s0..s14`) ↔ Rule (`rule_*`) ↔ Sub-project (`sp1/sp2/sp3`).

Trước khi implement / sửa task, feature hay màn nào:
- `/graphify explain task_T<n>` (hoặc `feat_*`, `screen_*`) → biết feature, màn, module, rule liên quan.
- `/graphify path "<feature>" "<screen>"` khi thêm UI cho feature.
- Chỉ làm những gì graph + spec có. Thứ không có → hỏi người dùng, không tự thêm.

Sau khi đổi spec/plan/design: `/graphify docs --update` để graph không lệch docs.

## Không được implement

- Node `drift_*`: thứ Stitch tự bịa (telemetry giả, nav thừa, model id cứng, engine giả, "Inject Auth", "Turnstile bypass", "Puppeteer Stealth", "Auto-reconcile CSS", "Approve & Deploy"...). Mockup chỉ là tham khảo bố cục.
- Bất cứ gì vi phạm `rule_no_captcha_bypass`: không giải CAPTCHA tự động, không giả fingerprint/stealth, không vượt anti-bot. Gặp login/CAPTCHA → `needs_auth`, người dùng tự xử lý trong cửa sổ Chrome.
- Tính năng SP2/SP3 (`sp2_*`, `sp3_*`, `feat_*_sp2`, `feat_design_sp3`, `screen_export_arch_sp2`) trong khi đang làm SP1 — chỉ chừa chỗ (field `origin`, node `Feature`), không build.

## Bất biến kỹ thuật (từ spec)

- Clone tất định: HTML sinh từ DOM + computed style đã chụp; AI chỉ đặt tên section + sửa section fail.
- QA gate: pixel diff theo section × breakpoint (375/768/1440), ngưỡng 95%, fix ≤3 vòng, inspector bắt buộc trước mỗi vòng, điểm tụt → revert.
- Mọi workload có giới hạn cứng (bảng §1 spec). Không `Promise.all` trên mảng không bounded.
- Checkpoint theo task nhỏ, ghi tmp → rename → mới mark `done`; không auto-resume khi khởi động.
- Secret mã hóa AES-256-GCM, không log, không gửi AI, không vào graph/output.
- `core/` không import `app/`; `ir`, `emit-html`, dedupe, `applyPatch` thuần.
