import type { CrawlPage } from "@/core/crawl";
import type { ProjectConfig } from "@/core/jobs-base";
import { getDb } from "@/app/_server/db";
import { Button } from "@/app/_ui/Button";
import { Disclosure } from "@/app/_ui/Disclosure";
import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { StatusPill } from "@/app/_ui/StatusPill";
import { UrlChip } from "@/app/_ui/UrlChip";
import { historyRates, loadProject, readWorkspaceJson } from "../data";
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

export default async function SitemapScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = loadProject(id);
  const cfg = JSON.parse(project.config_json) as ProjectConfig;
  const [discovered, dates] = await Promise.all([readWorkspaceJson<CrawlPage[] | null>(id, "discover.json", null), captureDates(id)]);
  const pages: SitemapPage[] = (discovered ?? []).map((p) => ({ ...p, capturedAt: dates.get(p.url) ?? null }));
  const captured = pages.filter((p) => p.capturedAt !== null).length;
  return (
    <>
      <PageHeader
        data-ui="ui_sitemap_page_header"
        crumbs={projectCrumbs(project.url, id, "Sitemap")}
        title="Chọn trang để clone"
        meta={<StatusPill status={project.status} />}
        actions={
          <>
            <UrlChip
              url={new URL(project.url).origin}
              openable
              extra={
                <span className="t-label-sm text-3 chip-extra">
                  {pages.length} trang · {captured} đã chụp
                </span>
              }
            />
            {project.status !== "draft" && (
              <Button href={`/p/${id}`} icon="timeline">
                Xem tiến độ
              </Button>
            )}
          </>
        }
      />
      <SitemapPicker
        projectId={id}
        pages={pages}
        crawled={discovered !== null}
        draft={project.status === "draft"}
        rates={historyRates()}
        tokenBudget={cfg.tokenBudget}
        concurrency={cfg.concurrency}
        delayMs={cfg.delayMs}
        now={Math.floor(Date.now() / 1000)}
      />
      <Disclosure summary="Phiên đăng nhập" className="section-gap" data-ui="ui_sitemap_session_tools">
        <SessionTools projectId={id} />
      </Disclosure>
    </>
  );
}
