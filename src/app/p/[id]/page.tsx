import { getDb } from "@/app/_server/db";
import { authUrl } from "@/app/_server/http";
import { needsCredentials } from "@/app/_server/credentials";
import { loadProject } from "./data";
import { ProgressView, type TaskView } from "./progress-view";
import { SessionTools } from "./session-tools";

const MAX_TASKS = 2_000; // pages (<=100) x phases + fix tasks per failing section: far above any real run

export default async function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = loadProject(id);
  // node:sqlite rows have a null prototype, which can't cross into a client component: copy to plain objects
  const tasks = (
    getDb().prepare("SELECT phase,key,status,error_code AS errorCode FROM tasks WHERE project_id=? ORDER BY rowid LIMIT ?").all(id, MAX_TASKS) as TaskView[]
  ).map((t) => ({ ...t }));
  const auth = project.status === "needs_auth" ? await authUrl(getDb(), project) : null;
  return (
    <>
      <h1>Tiến độ clone</h1>
      <ProgressView projectId={id} url={project.url} initial={{ status: project.status, progress: project.progress, tasks, authUrl: auth, needsCredentials: needsCredentials(getDb(), id) }} />
      <SessionTools projectId={id} />
    </>
  );
}
