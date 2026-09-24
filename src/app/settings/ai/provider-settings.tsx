"use client";
import { useEffect, useRef, useState, type FocusEvent, type FormEvent, type KeyboardEvent } from "react";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Field } from "@/app/_ui/Field";
import { Icon, type IconName } from "@/app/_ui/Icon";
import { IconButton } from "@/app/_ui/IconButton";
import { PageHeader } from "@/app/_ui/PageHeader";
import { PasswordInput } from "@/app/_ui/PasswordInput";
import { SearchInput } from "@/app/_ui/SearchInput";

type Kind = "anthropic" | "openai";
type Role = "vision" | "code" | "design";
type Provider = { id: string; name: string; kind: Kind; baseUrl: string; apiKey: string; roles: Partial<Record<Role, string>> };
// id set = editing a saved provider (an empty apiKey keeps the stored key; it is never filled back)
type Draft = { id?: string; title: string; kind: Kind; name: string; baseUrl: string; apiKey: string; roles: Partial<Record<Role, string>> };
type TestResult = { ok: boolean; text: string; latencyMs?: number };
type TestResponse = { models: number; latencyMs: number; httpStatus: number };

const KIND_LABEL: Record<Kind, string> = { anthropic: "Anthropic Compatible", openai: "OpenAI Compatible" };
const PROTOCOL: Record<Kind, string> = { anthropic: "Anthropic Messages API", openai: "OpenAI Chat Completions API" };
const URL_HINT: Record<Kind, string> = { anthropic: "https://api.anthropic.com/v1", openai: "https://api.openai.com/v1" };
const ROLES: { role: Role; icon: IconName; text: string }[] = [
  { role: "vision", icon: "visibility", text: "Đặt tên section (1 lần gọi mỗi trang, kèm ảnh thu nhỏ)." },
  { role: "code", icon: "code", text: "Vòng sửa section chưa đạt QA (patch IR, tối đa 3 vòng); nhận ảnh nếu cùng model với vision." },
  { role: "design", icon: "edit", text: "Dành cho SP3, SP1 không dùng." },
];

const okText = (r: TestResponse) => `Kết nối OK · ${r.latencyMs} ms · HTTP ${r.httpStatus} · ${r.models} model`;

async function runTest(body: unknown): Promise<TestResult> {
  try {
    const r = await api<TestResponse>("/api/providers/test", { body });
    return { ok: true, text: okText(r), latencyMs: r.latencyMs };
  } catch (e) {
    return { ok: false, text: errorText(e) }; // the server's code + message, which carries the upstream HTTP status
  }
}

export function ProviderSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({}); // this session only, never stored
  const [formTest, setFormTest] = useState<TestResult | "running" | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const testToken = useRef(0); // bumped on every form-test start / draft switch: a stale in-flight test never overwrites a newer one

  const load = () =>
    api<{ providers: Provider[] }>("/api/providers").then(
      (r) => setProviders(r.providers),
      (e: unknown) => setMsg(errorText(e)),
    );
  useEffect(() => void load(), []);

  const openForm = (kind: Kind) => {
    testToken.current++;
    setDraft({ kind, title: `Thêm ${KIND_LABEL[kind]}`, name: "", baseUrl: "", apiKey: "", roles: {} });
    setModels([]);
    setFormTest(null);
    setMsg("");
  };

  const editForm = (p: Provider) => {
    testToken.current++;
    setDraft({ id: p.id, title: `Sửa: ${p.name}`, kind: p.kind, name: p.name, baseUrl: p.baseUrl, apiKey: "", roles: p.roles });
    setModels([...new Set(Object.values(p.roles).filter((m): m is string => !!m))]); // current choices stay selectable
    setFormTest(null);
    setMsg("");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const closeForm = () => {
    testToken.current++;
    setDraft(null);
  };

  // editing without a new key: the saved provider (its key decrypted server-side); otherwise the typed values (D7)
  const bodyOf = (d: Draft) => (d.id && !d.apiKey ? { providerId: d.id } : { kind: d.kind, baseUrl: d.baseUrl, apiKey: d.apiKey });

  const fetchModels = () =>
    run(async () => {
      if (!draft) return;
      const r = await api<{ models: string[] }>("/api/providers/models", { body: bodyOf(draft) });
      setModels(r.models);
    });

  const testForm = async () => {
    if (!draft) return;
    const token = ++testToken.current;
    setFormTest("running");
    const body = bodyOf(draft);
    const saved = "providerId" in body ? body.providerId : null; // the row's dot/latency only reflect the saved provider
    const r = await runTest(body);
    if (testToken.current !== token) return; // the draft changed (or another test started) while this one was in flight
    setFormTest(r);
    if (saved) setTests((t) => ({ ...t, [saved]: r }));
  };

  const testRow = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "running" }));
    const r = await runTest({ providerId: id });
    setTests((t) => ({ ...t, [id]: r }));
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!draft) return;
      const roles = Object.fromEntries(Object.entries(draft.roles).filter(([, m]) => m));
      const { id, kind, apiKey, name, baseUrl } = draft;
      if (id) await api(`/api/providers/${id}`, { method: "PATCH", body: { name, baseUrl, roles, ...(apiKey ? { apiKey } : {}) } });
      else await api("/api/providers", { body: { name, baseUrl, kind, apiKey, roles } });
      closeForm();
      await load();
    });
  };

  const remove = (p: Provider) => {
    if (!confirm(`Xóa provider ${p.name}?`)) return;
    void run(async () => {
      await api(`/api/providers/${p.id}`, { method: "DELETE" });
      if (draft?.id === p.id) closeForm();
      await load();
    });
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const q = filter.trim().toLowerCase();
  const shown = q ? providers.filter((p) => [p.name, p.baseUrl, ...Object.values(p.roles)].some((v) => v?.toLowerCase().includes(q))) : providers;

  return (
    <>
      <PageHeader
        data-ui="ui_settings_ai_page_header"
        crumbs={[{ label: "Cài đặt" }, { label: "AI Gateway & Provider" }]}
        title="AI Gateway & Provider"
        subtitle="Thêm endpoint tương thích Anthropic hoặc OpenAI, lấy danh sách model, Test kết nối và gán model cho từng vai trò."
        actions={
          <div className="row" data-ui="ui_settings_ai_add_provider_buttons">
            <Button className="btn-outline-warn" icon="hub" onClick={() => openForm("anthropic")}>
              Add Anthropic Compatible
            </Button>
            <Button variant="primary" icon="add_circle" onClick={() => openForm("openai")}>
              Add OpenAI Compatible
            </Button>
          </div>
        }
      />
      {msg && (
        <Banner tone="danger" icon="error">
          {msg}
        </Banner>
      )}
      <div className="settings-grid">
        <Card
          data-ui="ui_settings_ai_endpoint_list"
          title={
            <>
              Endpoint đã cấu hình <Badge>{providers.length}</Badge>
            </>
          }
        >
          <SearchInput data-ui="ui_settings_ai_endpoint_filter" label="Lọc endpoint" placeholder="Lọc theo tên hoặc base URL…" value={filter} onChange={setFilter} />
          {providers.length === 0 && <p className="text-3">Chưa có provider nào.</p>}
          {providers.length > 0 && shown.length === 0 && <p className="text-3">Không có endpoint khớp.</p>}
          <ul className="endpoint-list">
            {shown.map((p) => {
              const t = tests[p.id];
              const tone = t === undefined || t === "running" ? "neutral" : t.ok ? "success" : "danger";
              const latency = t === undefined ? "chưa test" : t === "running" ? "Đang test…" : t.ok ? `${t.latencyMs} ms` : "lỗi";
              return (
                <li key={p.id} className={`endpoint-row${draft?.id === p.id ? " is-open" : ""}`} data-ui="ui_settings_ai_endpoint_row">
                  <button type="button" className="endpoint-main" onClick={() => editForm(p)}>
                    <span className={`dot tone-${tone}`} aria-hidden="true" />
                    <span className="endpoint-body">
                      <span className="endpoint-line1">
                        <span className="endpoint-name">{p.name}</span>
                        <Badge tone={p.kind === "anthropic" ? "warn" : "success"}>{p.kind.toUpperCase()}</Badge>
                      </span>
                      <span className="endpoint-line2 mono text-3" title={t !== undefined && t !== "running" ? t.text : undefined}>
                        {latency} · {p.apiKey}
                      </span>
                    </span>
                  </button>
                  <IconButton icon="bolt" label="Test" tone="success" disabled={t === "running"} onClick={() => void testRow(p.id)} />
                  <RowMenu onEdit={() => editForm(p)} onDelete={() => remove(p)} />
                </li>
              );
            })}
          </ul>
        </Card>

        <Card data-ui="ui_settings_ai_config_panel" title={draft ? draft.title : "Cấu hình provider"}>
          {!draft ? (
            <p className="text-3">Chọn một endpoint để sửa, hoặc thêm mới.</p>
          ) : (
            <form className="stack" aria-label="Cấu hình provider" onSubmit={save}>
              <div className="field-row-2">
                <Field label="Tên hiển thị" data-ui="ui_settings_ai_display_name">
                  <input required maxLength={100} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
                </Field>
                <div className="field-x" data-ui="ui_settings_ai_protocol">
                  <span className="field-label">Chuẩn API</span>
                  <span className="readonly-value">
                    <Icon name="lock" />
                    {PROTOCOL[draft.kind]}
                    <span className="t-label-sm text-3">cố định</span>
                  </span>
                </div>
              </div>
              <Field label="Base URL" hintEnd={`Mặc định: ${URL_HINT[draft.kind]}`} data-ui="ui_settings_ai_base_url">
                <input required type="url" className="mono" placeholder={URL_HINT[draft.kind]} value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
              </Field>
              <PasswordInput
                data-ui="ui_settings_ai_api_key"
                label="API key"
                hint="Key được mã hóa khi lưu và không bao giờ hiển thị lại."
                required={!draft.id}
                placeholder={draft.id ? "để trống = giữ key cũ" : undefined}
                value={draft.apiKey}
                onChange={(e) => set({ apiKey: e.target.value })}
              />
              <div className="row inset-row" data-ui="ui_settings_ai_fetch_models">
                <Button icon="refresh" disabled={busy || !draft.baseUrl || (!draft.apiKey && !draft.id)} onClick={() => void fetchModels()}>
                  Fetch models
                </Button>
                <span className="t-label-md text-2">{models.length ? `${models.length} model` : "Chưa có danh sách model"}</span>
              </div>
              <div className="row" data-ui="ui_settings_ai_test_endpoint">
                <Button className="btn-outline-success" icon="bolt" disabled={formTest === "running" || !draft.baseUrl || (!draft.apiKey && !draft.id)} onClick={() => void testForm()}>
                  {formTest === "running" ? "Đang test…" : "Test kết nối"}
                </Button>
                {formTest && formTest !== "running" && (
                  <span role="status" className={`test-result tint tone-${formTest.ok ? "success" : "danger"}`}>
                    <Icon name={formTest.ok ? "check_circle" : "error"} size={16} />
                    {formTest.text}
                  </span>
                )}
              </div>
              <fieldset className="role-matrix" data-ui="ui_settings_ai_role_matrix">
                <legend className="t-headline-sm">Vai trò model</legend>
                {ROLES.map((r) => (
                  <div className="role-row" key={r.role}>
                    <span className="role-icon">
                      <Icon name={r.icon} size={20} />
                    </span>
                    <div className="role-text">
                      <span className="mono">{r.role}</span> — <span className="t-body-sm text-2">{r.text}</span>
                    </div>
                    <select aria-label={`Model cho vai trò ${r.role}`} disabled={!models.length} value={draft.roles[r.role] ?? ""} onChange={(e) => set({ roles: { ...draft.roles, [r.role]: e.target.value } })}>
                      <option value="">(không gán)</option>
                      {models.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                ))}
                <p className="t-body-sm text-3">Khi chạy: dùng provider của dự án nếu nó phục vụ vai trò, nếu không dùng provider lưu gần nhất có vai trò đó.</p>
              </fieldset>
              <div className="form-actions" data-ui="ui_settings_ai_save_provider">
                <Button onClick={closeForm}>Hủy thay đổi</Button>
                <Button type="submit" variant="primary" icon="save" disabled={busy}>
                  Lưu provider
                </Button>
              </div>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}

// Kebab menu: role=menu. Esc closes and returns focus to the trigger; an outside click or tabbing out
// also closes it but leaves focus where the user put it (never steals it back mid-click/mid-tab). ↑/↓ move between items.
function RowMenu({ onEdit, onDelete }: { onEdit(): void; onDelete(): void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") return close();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); // Tab past the last item (or Shift+Tab before the first) leaves the menu
  };
  const pick = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <span className="menu-anchor" data-ui="ui_settings_ai_row_menu">
      <IconButton ref={button} icon="more_vert" label="Thao tác" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div ref={box} role="menu" className="menu" onKeyDown={onKey} onBlur={onBlur}>
          <button type="button" role="menuitem" onClick={pick(onEdit)}>
            Sửa
          </button>
          <button type="button" role="menuitem" className="danger" onClick={pick(onDelete)}>
            Xóa
          </button>
        </div>
      )}
    </span>
  );
}
