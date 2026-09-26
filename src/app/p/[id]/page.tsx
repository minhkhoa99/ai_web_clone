import { projectConfigSchema } from "@/core/jobs-base";
import { config } from "@/core/config";
import { getDb } from "@/app/_server/db";
import { authUrl } from "@/app/_server/http";
import { needsCredentials } from "@/app/_server/credentials";
import { Disclosure } from "@/app/_ui/Disclosure";
import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { loadProject, readWorkspaceJson } from "./data";
import type { PageRef, TaskView } from "./page-states";
import { ProgressView } from "./progress-view";
import { SessionTools } from "./session-tools";

const MAX_TASKS = 2_000; // pages (<=100) x phases + fix tasks per failing section: far above any real run
const MAX_PAGES = 100; // spec §1 crawl ceiling

// A row written before the config schema grew a field, or otherwise malformed: falls back to the app's
// default budget instead of showing "NaN" (fix round 1 #9).
function tokenBudgetOf(configJson: string): number {
  try {
    const parsed = projectConfigSchema.safeParse(JSON.parse(configJson));
    return parsed.success ? parsed.data.tokenBudget : config.tokenBudget;
  } catch {
    return config.tokenBudget;
  }
}

export default async function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = loadProject(id);
  // node:sqlite rows have a null prototype, which can't cross into a client component: copy to plain objects
  const tasks = (
    getDb().prepare("SELECT phase,key,status,error_code AS errorCode FROM tasks WHERE project_id=? ORDER BY rowid LIMIT ?").all(id, MAX_TASKS) as TaskView[]
  ).map((t) => ({ ...t }));
  const pages = (await readWorkspaceJson<PageRef[]>(id, "pages.json", [])).slice(0, MAX_PAGES).map((p) => ({ pageId: p.pageId, url: p.url }));
  const auth = project.status === "needs_auth" ? await authUrl(getDb(), project) : null;
  return (
    <div className="progress-page">
      <PageHeader data-ui="ui_progress_page_header" crumbs={projectCrumbs(project.url, id, "Tiến độ")} title="Tiến độ clone" />
      <ProgressView
        projectId={id}
        url={project.url}
        initial={{
          status: project.status,
          progress: project.progress,
          tasks,
          authUrl: auth,
          needsCredentials: needsCredentials(getDb(), id),
          pages,
          tokensUsed: project.tokens_used,
          tokenBudget: tokenBudgetOf(project.config_json),
        }}
      />
      <Disclosure summary="Phiên đăng nhập" className="section-gap" data-ui="ui_progress_session_tools">
        <SessionTools projectId={id} />
      </Disclosure>
    </div>
  );
}
