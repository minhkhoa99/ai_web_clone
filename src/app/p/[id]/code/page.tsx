import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import Link from "next/link";
import { codeToHtml } from "shiki";
import { workspaceOf } from "@/app/_server/http";
import { loadProject } from "../data";
import { ExportPanel } from "./export-panel";

const MAX_FILES = 2_000; // tree shows at most this many out/ files
const MAX_VIEW_BYTES = 512 * 1024; // larger text files are not highlighted (shiki is O(n) but slow on huge input)
const LANG: Record<string, string> = { ".html": "html", ".css": "css", ".js": "javascript", ".json": "json", ".svg": "xml", ".txt": "text" };
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"]);

async function listOut(out: string): Promise<string[]> {
  const entries = await readdir(out, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(out, join(e.parentPath, e.name)).split(sep).join("/"))
    .sort()
    .slice(0, MAX_FILES);
}

// Only a file from the listing is ever read: the query string can't reach outside out/.
async function viewer(out: string, file: string, fileUrl: string) {
  const ext = extname(file).toLowerCase();
  const lang = LANG[ext];
  if (!lang) return IMAGE.has(ext) ? <img alt={file} src={fileUrl} style={{ maxWidth: "100%" }} /> : <p className="muted">Không xem được loại file này.</p>;
  const { size } = await stat(join(out, file));
  if (size > MAX_VIEW_BYTES) return <p className="muted">File quá lớn để xem ({Math.round(size / 1024)} KB).</p>;
  const html = await codeToHtml(await readFile(join(out, file), "utf8"), { lang, theme: "github-dark" });
  return <div dangerouslySetInnerHTML={{ __html: html }} />; // shiki escapes the source text
}

export default async function CodePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ file?: string | string[] }> }) {
  const [{ id }, { file }] = await Promise.all([params, searchParams]);
  loadProject(id);
  const out = join(workspaceOf(id), "out");
  const files = await listOut(out);
  const current = typeof file === "string" && files.includes(file) ? file : files.find((f) => f === "index.html") ?? files[0];
  const fileUrl = (f: string) => `/api/projects/${id}/files/out/${f.split("/").map(encodeURIComponent).join("/")}`;
  return (
    <>
      <div className="row spread">
        <h1>Mã nguồn</h1>
        <nav className="row" aria-label="Dự án">
          <Link href={`/p/${id}`}>Tiến độ</Link>
          <Link href={`/p/${id}/preview`}>Preview</Link>
        </nav>
      </div>
      <ExportPanel projectId={id} disabled={files.length === 0} />
      {files.length === 0 ? (
        <p className="muted">Chưa có output (out/) — chạy clone trước.</p>
      ) : (
        <div className="code-layout" style={{ marginTop: 16 }}>
          <nav className="card files" aria-label="Cây file">
            {files.map((f) => (
              <Link key={f} href={`?file=${encodeURIComponent(f)}`} aria-current={f === current ? "page" : undefined} style={{ paddingLeft: (f.split("/").length - 1) * 14 }}>
                {f.split("/").pop()}
                {f.includes("/") && <span className="muted"> ({f.slice(0, f.lastIndexOf("/"))})</span>}
              </Link>
            ))}
          </nav>
          <section className="viewer" aria-label={current}>
            <div className="pane-label mono" style={{ padding: "8px 12px" }}>
              {current}
            </div>
            {current && (await viewer(out, current, fileUrl(current)))}
          </section>
        </div>
      )}
    </>
  );
}
