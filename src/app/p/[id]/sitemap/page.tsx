import Link from "next/link";
import type { CrawlPage } from "@/core/crawl";
import { getDb } from "@/app/_server/db";
import { StatusPill } from "@/app/_ui/StatusPill";
import { loadProject, readWorkspaceJson } from "../data";
import { SessionTools } from "../session-tools";
import { SitemapPicker, type SitemapPage } from "./sitemap-picker";

// Capture time per URL, known once a capture task finished (pages.json maps pageId -> url).
async function captureDates(projectId: string): Promise<Map<string, number>> {
  const refs = await readWorkspaceJson<{ pageId: string; url: string }[]>(projectId, "pages.json", []);
  if (refs.length === 0) return new Map();
  const done = getDb()
    .prepare("SELECT key,updated_at FROM tasks WHERE project_id=? AND phase='capture' AND status='done'")
    .all(projectId) as { key: string; updated_at: number }[];
  const at = new Map(done.map((t) => [t.key, t.updated_at]));
  return new Map(refs.flatMap((r) => (at.has(r.pageId) ? [[r.url, at.get(r.pageId)!] as const] : [])));
}

export default async function SitemapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = loadProject(id);
  const [discovered, dates] = await Promise.all([readWorkspaceJson<CrawlPage[] | null>(id, "discover.json", null), captureDates(id)]);
  const pages: SitemapPage[] = (discovered ?? []).map((p) => ({ ...p, capturedAt: dates.get(p.url) ?? null }));
  return (
    <>
      <div className="row spread">
        <h1>Chọn trang để clone</h1>
        <div className="row">
          <StatusPill status={project.status} />
          {project.status !== "draft" && <Link href={`/p/${id}`}>Xem tiến độ</Link>}
        </div>
      </div>
      <p className="mono muted">{project.url}</p>
      <SitemapPicker projectId={id} pages={pages} crawled={discovered !== null} draft={project.status === "draft"} />
      <SessionTools projectId={id} />
    </>
  );
}
