import type { ProjectConfig } from "@/core/jobs-base";
import { loadProject } from "../data";
import { PreviewView } from "./preview-view";

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = loadProject(id);
  const { threshold } = JSON.parse(project.config_json) as ProjectConfig;
  return (
    <>
      <h1>Preview &amp; QA</h1>
      <PreviewView projectId={id} threshold={threshold} />
    </>
  );
}
