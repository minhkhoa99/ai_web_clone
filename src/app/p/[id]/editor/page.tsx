"use client";
import "grapesjs/dist/css/grapes.min.css";
import type { Editor } from "grapesjs";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { GrapesProject } from "@/core/grapes-adapter";
import { api, errorText } from "@/app/_ui/api";

const DEVICES = ["1440", "768", "375"] as const;
const DEFAULT_EFFECT_MS = 600;

// GrapesJS over one page of the IR (spec §10). Save sends the editor's JSON to the adapter, which patches the IR and
// re-emits out/; layout sections are shared, so editing one on any page edits it everywhere.
export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const [pageId, setPageId] = useState(""); // "" = the API's default (first page)
  const [version, setVersion] = useState(0); // bumped after a save / merge: reload the IR into a fresh editor
  const [project, setProject] = useState<GrapesProject | null>(null);
  const [device, setDevice] = useState<string>(DEVICES[0]);
  const [picked, setPicked] = useState<string[]>([]); // click order: the first becomes the layout
  const [effect, setEffect] = useState("sp1-fade-in");
  const [effectMs, setEffectMs] = useState(DEFAULT_EFFECT_MS);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    let editor: Editor | undefined;
    let cancelled = false;
    (async () => {
      const [data, { default: grapesjs }] = await Promise.all([
        api<GrapesProject>(`/api/projects/${id}/editor${pageId ? `?page=${encodeURIComponent(pageId)}` : ""}`),
        import("grapesjs"),
      ]);
      if (cancelled || !holder.current) return;
      const pathOf = new Map(data.pages.map((p) => [p.id, p.path]));
      editor = grapesjs.init({
        container: holder.current,
        height: "76vh",
        storageManager: false, // the IR on the server is the only store
        protectedCss: data.styles,
        selectorManager: { componentFirst: true }, // style edits target the component, not a shared class
        // widthMedia "": a style edit applies at every breakpoint (the IR patch sets the base style)
        deviceManager: { devices: DEVICES.map((w) => ({ id: w, name: `${w}px`, width: `${w}px`, widthMedia: "" })) },
        blockManager: {
          blocks: data.sections.map((s) => ({ id: s.id, label: s.name, category: pathOf.get(s.pageId) ?? s.pageId, content: s.component })),
        },
      });
      // relative urls in the page resolve like on the source page: <base> before the body renders
      editor.on("canvas:frame:load:head", ({ window }: { window: Window }) => {
        if (!data.baseUrl) return;
        const base = window.document.createElement("base");
        base.href = data.baseUrl;
        window.document.head.prepend(base);
      });
      editor.setComponents(data.components);
      editor.getWrapper()?.addClass(data.bodyClasses);
      editor.UndoManager.clear(); // loading the page is not an undoable edit
      editor.setDevice(DEVICES[0]);
      editorRef.current = editor;
      setDevice(DEVICES[0]);
      setProject(data);
    })().catch((e: unknown) => setMsg(errorText(e)));
    return () => {
      cancelled = true;
      editor?.destroy();
      editorRef.current = null;
    };
  }, [id, pageId, version]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(label);
    try {
      setMsg(await fn());
      setVersion((v) => v + 1);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run("Đang lưu…", async () => {
      const editor = editorRef.current;
      if (!editor || !project) return "Editor chưa sẵn sàng.";
      // a text still being edited is only synced into the model when rich-text editing ends
      const view = editor.getEditing()?.getView() as { disableEditing?: () => Promise<void> } | undefined;
      await view?.disableEditing?.();
      const body = { pageId: project.pageId, project: { components: editor.getComponents(), styles: editor.Css.getAll() } };
      const res = await api<{ ops: number }>(`/api/projects/${id}/editor/save`, { body });
      return `Đã lưu: ${res.ops} thay đổi`;
    });

  const mergeLayout = () =>
    run("Đang gộp…", async () => {
      await api(`/api/projects/${id}/editor/promote-layout`, { body: { sectionIds: picked } });
      setPicked([]);
      return "Đã gộp thành layout chung";
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
    <>
      <div className="row spread">
        <h1>Editor</h1>
        <nav className="row" aria-label="Dự án">
          <Link href={`/p/${id}`}>Tiến độ</Link>
          <Link href={`/p/${id}/preview`}>Preview</Link>
          <Link href={`/p/${id}/code`}>Code</Link>
        </nav>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="field">
          Trang
          <select value={project?.pageId ?? ""} onChange={(e) => setPageId(e.target.value)} disabled={busy}>
            {project?.pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.path}
              </option>
            ))}
          </select>
        </label>
        <div className="row" role="group" aria-label="Thiết bị">
          {DEVICES.map((w) => (
            <button
              key={w}
              className="btn"
              aria-pressed={device === w}
              onClick={() => {
                editorRef.current?.setDevice(w);
                setDevice(w);
              }}
            >
              {w}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => editorRef.current?.UndoManager.undo()}>
          Hoàn tác
        </button>
        <button className="btn" onClick={() => editorRef.current?.UndoManager.redo()}>
          Làm lại
        </button>
        <button className="btn primary" onClick={save} disabled={busy || !project}>
          Lưu
        </button>
        <span role="status" className="muted">
          {msg}
        </span>
      </div>
      <div className="editor-layout">
        <div ref={holder} />
        <aside className="stack">
          <section className="card stack">
            <h2>Hiệu ứng</h2>
            <label className="field">
              Keyframes
              <select value={effect} onChange={(e) => setEffect(e.target.value)}>
                {project?.effects.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Thời lượng (ms)
              <input type="number" min={100} max={10_000} step={100} value={effectMs} onChange={(e) => setEffectMs(Number(e.target.value) || DEFAULT_EFFECT_MS)} />
            </label>
            <button className="btn" onClick={applyEffect} disabled={!project}>
              Áp cho phần tử đang chọn
            </button>
          </section>
          <section className="card stack">
            <h2>Section</h2>
            <p className="muted">Chọn section ở các trang khác nhau; section chọn đầu tiên thành layout chung.</p>
            <ul className="plain stack">
              {project?.sections.map((s) => (
                <li key={s.id}>
                  <label className="row">
                    <input type="checkbox" checked={picked.includes(s.id)} onChange={() => togglePick(s.id)} />
                    {s.name} <span className="muted">{pathOf.get(s.pageId)}</span>
                    {s.layoutId && <span className="tag">Layout chung</span>}
                  </label>
                </li>
              ))}
            </ul>
            <button className="btn" onClick={mergeLayout} disabled={busy || picked.length < 2}>
              Gộp thành layout
            </button>
          </section>
        </aside>
      </div>
    </>
  );
}
