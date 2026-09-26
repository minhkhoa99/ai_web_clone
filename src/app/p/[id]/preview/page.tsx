import type { ProjectConfig } from "@/core/jobs-base";
import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { loadProject } from "../data";
import { PreviewView } from "./preview-view";

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = loadProject(id);
  const { threshold } = JSON.parse(project.config_json) as ProjectConfig;
  return (
    <div className="qa-page">
      <PageHeader data-ui="ui_qa_preview_page_header" crumbs={projectCrumbs(project.url, id, "Preview & QA")} title="Preview & QA" />
      <PreviewView projectId={id} threshold={threshold} status={project.status} />
    </div>
  );
}
