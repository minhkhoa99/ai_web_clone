import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { ReactNode } from "react";
import { codeToHtml } from "shiki";
import { mapLimit } from "@/core/limit";
import { workspaceOf } from "@/app/_server/http";
import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { UrlChip } from "@/app/_ui/UrlChip";
import { fmtBytes } from "@/app/_ui/format";
import { loadProject } from "../data";
import { CodeFile } from "./code-file";
import { ExportPanel } from "./export-panel";
import { FileTree } from "./file-tree";

const MAX_FILES = 2_000; // tree shows at most this many out/ files
const STAT_CONCURRENCY = 8; // stat() calls in flight for the totals
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
async function viewer(out: string, file: string, fileUrl: string, size: number): Promise<{ node: ReactNode; lines: number | null }> {
  const ext = extname(file).toLowerCase();
  const lang = LANG[ext];
  if (!lang) return { node: IMAGE.has(ext) ? <img alt={file} src={fileUrl} className="code-image" /> : <p className="text-3 pad">Không xem được loại file này.</p>, lines: null };
  if (size > MAX_VIEW_BYTES) return { node: <p className="text-3 pad">File quá lớn để xem ({Math.round(size / 1024)} KB).</p>, lines: null };
  const source = await readFile(join(out, file), "utf8");
  // shiki emits one <span class="line"> per "\n" in the input, including a phantom empty one for a trailing
  // newline (present in almost every real file) — trim that one newline so the gutter matches `lines` exactly.
  const html = await codeToHtml(source.endsWith("\n") ? source.slice(0, -1) : source, { lang, theme: "github-dark" });
  const lines = source === "" ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  return { node: <div dangerouslySetInnerHTML={{ __html: html }} />, lines }; // shiki escapes the source text
}

export default async function CodePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ file?: string | string[] }> }) {
  const [{ id }, { file }] = await Promise.all([params, searchParams]);
  const project = loadProject(id);
  const out = join(workspaceOf(id), "out");
  const files = await listOut(out);
  // a file can vanish between the listing and the stat (edited/moved out from under us) — size 0, not a 500
  const sizes = await mapLimit(files, STAT_CONCURRENCY, async (f) =>
    stat(join(out, f))
      .then((s) => s.size)
      .catch(() => 0),
  );
  const total = sizes.reduce((a, b) => a + b, 0);
  const current = typeof file === "string" && files.includes(file) ? file : (files.find((f) => f === "index.html") ?? files[0]);
  const fileUrl = (f: string) => `/api/projects/${id}/files/out/${f.split("/").map(encodeURIComponent).join("/")}`;
  const header = (
    <PageHeader
      data-ui="ui_code_viewer_page_header"
      crumbs={projectCrumbs(project.url, id, "Mã nguồn")}
      title="Mã nguồn"
      meta={<UrlChip url={project.url} />}
      actions={<ExportPanel projectId={id} disabled={files.length === 0} />}
    />
  );
  if (current === undefined)
    return (
      <>
        {header}
        <p className="text-3">Chưa có output (out/) — chạy clone trước.</p>
      </>
    );
  const size = sizes[files.indexOf(current)] ?? 0;
  const view = await viewer(out, current, fileUrl(current), size);
  const ext = extname(current).toLowerCase();
  return (
    <>
      {header}
      <div className="code-grid">
        <FileTree files={files} current={current} />
        <section className="panel code-main" aria-label={current}>
          <CodeFile key={current} projectId={id} file={current} size={fmtBytes(size)} lines={view.lines} copyable={LANG[ext] !== undefined} initialWrap={ext === ".html"}>
            {view.node}
          </CodeFile>
          <footer className="code-foot t-label-sm" data-ui="ui_code_viewer_build_status">
            {files.length} file · {fmtBytes(total)}
          </footer>
        </section>
      </div>
    </>
  );
}
