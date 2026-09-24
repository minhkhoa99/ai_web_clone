"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "@/app/_ui/api";

type Kind = "anthropic" | "openai";
type Role = "vision" | "code" | "design";
type Provider = { id: string; name: string; kind: Kind; baseUrl: string; apiKey: string; roles: Partial<Record<Role, string>> };
// id set = editing a saved provider (an empty apiKey keeps the stored key)
type Draft = { id?: string; kind: Kind; name: string; baseUrl: string; apiKey: string; roles: Partial<Record<Role, string>> };

const ROLES: Role[] = ["vision", "code", "design"];
const KIND_LABEL: Record<Kind, string> = { anthropic: "Anthropic Compatible", openai: "OpenAI Compatible" };
const URL_HINT: Record<Kind, string> = { anthropic: "https://api.anthropic.com/v1", openai: "https://api.openai.com/v1" };

export function ProviderSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ providers: Provider[] }>("/api/providers").then(
      (r) => setProviders(r.providers),
      (e: unknown) => setMsg(errorText(e)),
    );
  useEffect(() => void load(), []);

  const openForm = (kind: Kind) => {
    setDraft({ kind, name: "", baseUrl: "", apiKey: "", roles: {} });
    setModels([]);
    setMsg("");
  };

  const editForm = (p: Provider) => {
    setDraft({ id: p.id, kind: p.kind, name: p.name, baseUrl: p.baseUrl, apiKey: "", roles: p.roles });
    setModels([...new Set(Object.values(p.roles).filter((m): m is string => !!m))]); // current choices stay selectable
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

  const fetchModels = () =>
    run(async () => {
      if (!draft) return;
      // editing without a new key: the saved provider's key (and saved base URL) is used server-side
      const body = draft.id && !draft.apiKey ? { providerId: draft.id } : { kind: draft.kind, baseUrl: draft.baseUrl, apiKey: draft.apiKey };
      const r = await api<{ models: string[] }>("/api/providers/models", { body });
      setModels(r.models);
    });

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!draft) return;
      const roles = Object.fromEntries(Object.entries(draft.roles).filter(([, m]) => m));
      const { id, kind, apiKey, ...rest } = draft;
      if (id) await api(`/api/providers/${id}`, { method: "PATCH", body: { ...rest, roles, ...(apiKey ? { apiKey } : {}) } });
      else await api("/api/providers", { body: { ...rest, kind, apiKey, roles } });
      setDraft(null);
      await load();
    });
  };

  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "Đang test…" }));
    try {
      const r = await api<{ models: number }>("/api/providers/test", { body: { providerId: id } });
      setTests((t) => ({ ...t, [id]: `OK — ${r.models} model` }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: errorText(e) }));
    }
  };

  const remove = (p: Provider) => {
    if (!confirm(`Xóa provider ${p.name}?`)) return;
    void run(async () => {
      await api(`/api/providers/${p.id}`, { method: "DELETE" });
      if (draft?.id === p.id) setDraft(null);
      await load();
    });
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <div className="stack">
      <div className="row">
        <button className="btn primary" onClick={() => openForm("anthropic")}>
          Add Anthropic Compatible
        </button>
        <button className="btn primary" onClick={() => openForm("openai")}>
          Add OpenAI Compatible
        </button>
      </div>
      {msg && <p className="alert" role="alert">{msg}</p>}

      {draft && (
        <form className="card stack" onSubmit={save}>
          <h2>
            {draft.id ? "Sửa" : "Thêm"} {KIND_LABEL[draft.kind]}
          </h2>
          <div className="grid-3">
            <label className="field">
              Tên
              <input required maxLength={100} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="field">
              Base URL
              <input required type="url" placeholder={URL_HINT[draft.kind]} value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
            </label>
            <label className="field">
              API key
              <input
                required={!draft.id}
                type="password"
                autoComplete="off"
                placeholder={draft.id ? "để trống = giữ key cũ" : undefined}
                value={draft.apiKey}
                onChange={(e) => set({ apiKey: e.target.value })}
              />
            </label>
          </div>
          <div className="row">
            <button type="button" className="btn" disabled={busy || !draft.baseUrl || (!draft.apiKey && !draft.id)} onClick={() => void fetchModels()}>
              Fetch models
            </button>
            <span className="muted">{models.length ? `${models.length} model` : "Chưa có danh sách model"}</span>
          </div>
          <div className="grid-3">
            {ROLES.map((role) => (
              <label key={role} className="field">
                Model cho vai trò {role}
                <select disabled={!models.length} value={draft.roles[role] ?? ""} onChange={(e) => set({ roles: { ...draft.roles, [role]: e.target.value } })}>
                  <option value="">(không gán)</option>
                  {models.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy}>
              Lưu
            </button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Hủy
            </button>
          </div>
        </form>
      )}

      <section className="card">
        <h2>Provider</h2>
        {providers.length === 0 && <p className="muted">Chưa có provider nào.</p>}
        <ul className="plain stack">
          {providers.map((p) => (
            <li key={p.id} className="row spread">
              <div>
                <strong>{p.name}</strong> <span className="muted">{KIND_LABEL[p.kind]}</span>
                <div className="mono muted">
                  {p.baseUrl} · {p.apiKey}
                </div>
                <div className="muted">{ROLES.map((r) => `${r}: ${p.roles[r] ?? "—"}`).join(" · ")}</div>
              </div>
              <div className="row">
                <span className="muted" role="status">{tests[p.id]}</span>
                <button className="btn" onClick={() => void test(p.id)}>
                  Test
                </button>
                <button className="btn" disabled={busy} onClick={() => editForm(p)}>
                  Sửa
                </button>
                <button className="btn danger" disabled={busy} onClick={() => remove(p)}>
                  Xóa
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
