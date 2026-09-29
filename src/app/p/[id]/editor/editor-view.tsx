"use client";
import "grapesjs/dist/css/grapes.min.css";
import type { Editor } from "grapesjs";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { GrapesProject } from "@/core/grapes-adapter";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Field } from "@/app/_ui/Field";
import { ICONS, type IconName } from "@/app/_ui/icons.gen";
import { IconButton } from "@/app/_ui/IconButton";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";

const DEVICES = ["1440", "768", "375"] as const;
type Device = (typeof DEVICES)[number];
// A style edit at a device targets that breakpoint: the emitter's media (1440 = base; 768 = ≤1439.98px; 375 = ≤767.98px).
const WIDTH_MEDIA: Record<Device, string> = { "1440": "", "768": "1439.98px", "375": "767.98px" };
type EditorData = GrapesProject & { revision: number; canUndo: boolean; canRedo: boolean };
type Saved = { revision: number; ops?: number; skipped?: string[] };
const DEFAULT_EFFECT_MS = 600;

// GrapesJS panel buttons render Font Awesome classNames with no FA loaded (correctly — no icon CDN);
// give the 4 panels we keep a real Material Symbols SVG + title instead (button.label accepts HTML).
const svgLabel = (name: IconName) => `<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><path d="${ICONS[name]}"/></svg>`;
const GJS_VIEWS_BUTTONS: { id: string; icon: IconName; title: string; active?: boolean }[] = [
  { id: "open-sm", icon: "edit", title: "Kiểu dáng", active: true },
  { id: "open-layers", icon: "layers", title: "Lớp" },
  { id: "open-blocks", icon: "view_column_2", title: "Khối" },
  { id: "open-tm", icon: "settings", title: "Thuộc tính" },
];

// GrapesJS over one page of the document (spec §10, E1 §2-3). Lưu sends the editor's JSON with the revision it loaded;
// the server diffs it into editor commands (one History step) and re-emits out/. Hoàn tác / Làm lại are the server's
// History (shared by every tab), not GrapesJS' UndoManager. After each change the editor reloads from the server.
// Layout sections are shared, so editing one on any page edits it everywhere.
export function EditorView({ projectId: id, initialPage }: { projectId: string; initialPage: string }) {
  const [pageId, setPageId] = useState(initialPage); // "" = the API's default (first page)
  const [version, setVersion] = useState(0); // bumped after a save / merge: reload the IR into a fresh editor
  const [project, setProject] = useState<EditorData | null>(null);
  const [device, setDevice] = useState<Device>(DEVICES[0]);
  const [picked, setPicked] = useState<string[]>([]); // click order: the first becomes the layout
  const [effect, setEffect] = useState("sp1-fade-in");
  const [effectMs, setEffectMs] = useState(DEFAULT_EFFECT_MS);
  const [msg, setMsg] = useState("");
  const [stale, setStale] = useState(false); // a 409 named a newer revision: offer "Tải lại"
  const [saved, setSaved] = useState(false); // qa.json is stale from now on: offer the preview (Chạy lại QA)
  const [busy, setBusy] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    let editor: Editor | undefined;
    let cancelled = false;
    (async () => {
      const [data, { default: grapesjs }] = await Promise.all([
        api<EditorData>(`/api/projects/${id}/editor${pageId ? `?page=${encodeURIComponent(pageId)}` : ""}`),
        import("grapesjs"),
      ]);
      if (cancelled || !holder.current) return;
      const pathOf = new Map(data.pages.map((p) => [p.id, p.path]));
      editor = grapesjs.init({
        container: holder.current,
        height: "72vh",
        storageManager: false, // the IR on the server is the only store
        protectedCss: data.styles,
        // style edits target the component, not a shared class; only the states the IR has
        selectorManager: { componentFirst: true, states: [{ name: "hover" }, { name: "focus" }, { name: "active" }] },
        deviceManager: { devices: DEVICES.map((w) => ({ id: w, name: `${w}px`, width: `${w}px`, widthMedia: WIDTH_MEDIA[w] })) },
        blockManager: {
          blocks: data.sections.map((s) => ({ id: s.id, label: s.name, category: pathOf.get(s.pageId) ?? s.pageId, content: s.component })),
        },
        showDevices: false, // our own SegmentedControl "Thiết bị" is the single device selector
        panels: {
          // drop the default 'commands'/'options' panels (sw-visibility, code view, fullscreen, preview: all
          // redundant with our own screens); keep 'views' (Style/Layer/Block/Trait Manager) with real icons.
          defaults: [
            {
              id: "views",
              buttons: GJS_VIEWS_BUTTONS.map((b) => ({
                id: b.id,
                command: b.id,
                active: b.active,
                togglable: false,
                label: svgLabel(b.icon),
                attributes: { title: b.title, "aria-label": b.title },
              })),
            },
          ],
        },
      });
      // the canvas resolves urls like the emitted page (local assets in out/): <base> before the body renders
      const baseHref = new URL(`/api/projects/${id}/files/out/${encodeURIComponent(data.pageFile)}`, window.location.href).href;
      editor.on("canvas:frame:load:head", ({ window: frame }: { window: Window }) => {
        const base = frame.document.createElement("base");
        base.href = baseHref;
        frame.document.head.prepend(base);
      });
      editor.setComponents(data.components);
      editor.getWrapper()?.addClass(data.bodyClasses);
      editor.UndoManager.clear(); // loading the page is not an edit: from here on hasUndo() = unsaved changes
      editor.setDevice(DEVICES[0]);
      editorRef.current = editor;
      setDevice(DEVICES[0]);
      setProject(data);
    })().catch((e: unknown) => {
      // a stale or mistyped ?page= falls back to the default page instead of failing the editor
      if (pageId !== "" && pageId === initialPage && errorText(e).startsWith("NOT_FOUND")) return setPageId("");
      setMsg(errorText(e));
    });
    return () => {
      cancelled = true;
      editor?.destroy();
      editorRef.current = null;
    };
  }, [id, pageId, version, initialPage]);

  // One server change, then one reload from the server document. A 409 naming a revision: another tab (or job) changed
  // the project: never overwrite, ask for a reload.
  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(label);
    setStale(false);
    try {
      setMsg(await fn());
      setSaved(true);
      setVersion((v) => v + 1);
    } catch (e) {
      const { code, revision } = e as { code?: string; revision?: number };
      const moved = typeof revision === "number" && (code === "STALE_REVISION" || code === "PROJECT_BUSY");
      setStale(moved);
      setMsg(moved ? `Dự án đã thay đổi ở nơi khác (revision ${revision}). Tải lại để tiếp tục.` : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // A text still being edited is only synced into the model when rich-text editing ends.
  const flushEditing = async () => {
    const view = editorRef.current?.getEditing()?.getView() as { disableEditing?: () => Promise<void> } | undefined;
    await view?.disableEditing?.();
  };
  // The reload after a server change would drop canvas edits not saved yet (text, styles, the Layers eye: all in the
  // UndoManager, cleared at load).
  const requireSaved = async () => {
    await flushEditing();
    if (editorRef.current?.UndoManager.hasUndo()) throw new Error("Có thay đổi chưa lưu — Lưu trước khi Hoàn tác / Làm lại / Gộp layout.");
  };

  const save = () =>
    run("Đang lưu…", async () => {
      const editor = editorRef.current;
      if (!editor || !project) return "Editor chưa sẵn sàng.";
      await flushEditing();
      const body = { baseRevision: project.revision, pageId: project.pageId, project: { components: editor.getComponents(), styles: editor.Css.getAll() } };
      const res = await api<Saved>(`/api/projects/${id}/editor/save`, { body });
      const skipped = res.skipped?.length ? ` · ${res.skipped.length} thay đổi không lưu được (chưa hỗ trợ hoặc không an toàn): ${res.skipped.slice(0, 3).join(", ")}` : "";
      return `Đã lưu: ${res.ops ?? 0} thay đổi — điểm QA cần chạy lại${skipped}`;
    });

  const mergeLayout = () =>
    run("Đang gộp…", async () => {
      await requireSaved();
      await api<Saved>(`/api/projects/${id}/editor/promote-layout`, { body: { baseRevision: project?.revision, sectionIds: picked } });
      setPicked([]);
      return "Đã gộp thành layout chung";
    });

  const history = (op: "undo" | "redo") =>
    run(op === "undo" ? "Đang hoàn tác…" : "Đang làm lại…", async () => {
      if (!project) return "Editor chưa sẵn sàng.";
      await requireSaved();
      await api<Saved>(`/api/projects/${id}/editor/${op}`, { body: { baseRevision: project.revision } });
      return `${op === "undo" ? "Đã hoàn tác" : "Đã làm lại"} — điểm QA cần chạy lại`;
    });

  const applyEffect = () => {
    const selected = editorRef.current?.getSelected();
    if (!selected) return setMsg("Chọn một phần tử trên canvas trước.");
    selected.addStyle({ animation: `${effect} ${effectMs}ms ease-out both` });
    setMsg(`Đã áp ${effect} — nhớ Lưu`);
  };

  const togglePick = (sectionId: string) => setPicked((p) => (p.includes(sectionId) ? p.filter((x) => x !== sectionId) : [...p, sectionId]));
  const pathOf = new Map(project?.pages.map((p) => [p.id, p.path]));

  return (
    <div className="stack">
      <div className="editor-toolbar" data-ui="ui_editor_toolbar">
        <label className="inline-field">
          <span className="field-label">Trang</span>
          <select value={project?.pageId ?? ""} onChange={(e) => setPageId(e.target.value)} disabled={busy}>
            {project?.pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.path}
              </option>
            ))}
          </select>
        </label>
        <SegmentedControl<Device>
          label="Thiết bị"
          value={device}
          onChange={(w) => {
            editorRef.current?.setDevice(w);
            setDevice(w);
          }}
          options={DEVICES.map((w) => ({ value: w, label: w }))}
        />
        <IconButton icon="undo" label="Hoàn tác" onClick={() => void history("undo")} disabled={busy || !project?.canUndo} />
        <IconButton icon="redo" label="Làm lại" onClick={() => void history("redo")} disabled={busy || !project?.canRedo} />
        <Button variant="primary" icon="save" onClick={() => void save()} disabled={busy || !project}>
          Lưu
        </Button>
        <span role="status" className="t-label-md text-2">
          {msg}
        </span>
        {stale && (
          <Button
            icon="refresh"
            onClick={() => {
              setStale(false);
              setMsg("");
              setVersion((v) => v + 1);
            }}
          >
            Tải lại
          </Button>
        )}
        {saved && <Link href={`/p/${id}/preview`}>Mở Preview</Link>}
      </div>
      <div className="editor-grid">
        <div className="editor-shell panel" data-ui="ui_editor_canvas_chrome">
          <div ref={holder} />
        </div>
        <aside className="stack">
          <Card title="Hiệu ứng" data-ui="ui_editor_effects_panel">
            <Field label="Keyframes">
              <select value={effect} onChange={(e) => setEffect(e.target.value)}>
                {project?.effects.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </Field>
            <Field label="Thời lượng (ms)">
              <input type="number" min={100} max={10_000} step={100} value={effectMs} onChange={(e) => setEffectMs(Number(e.target.value) || DEFAULT_EFFECT_MS)} />
            </Field>
            <Button onClick={applyEffect} disabled={!project}>
              Áp cho phần tử đang chọn
            </Button>
          </Card>
          <Card title="Section" data-ui="ui_editor_sections_panel">
            <p className="t-body-sm text-2">Chọn section ở các trang khác nhau; section chọn đầu tiên thành layout chung.</p>
            <ul className="editor-sections">
              {project?.sections.map((s) => (
                <li key={s.id}>
                  <label className="check">
                    <input type="checkbox" checked={picked.includes(s.id)} onChange={() => togglePick(s.id)} />
                    <span className="mono">{s.name}</span> <span className="text-3">{pathOf.get(s.pageId)}</span>
                    {s.layoutId && <Badge tone="primary">Layout chung</Badge>}
                  </label>
                </li>
              ))}
            </ul>
            <Button onClick={() => void mergeLayout()} disabled={busy || picked.length < 2}>
              Gộp thành layout
            </Button>
          </Card>
        </aside>
      </div>
    </div>
  );
}
