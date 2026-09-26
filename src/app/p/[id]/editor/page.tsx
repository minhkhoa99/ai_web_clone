import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { loadProject } from "../data";
import { EditorView } from "./editor-view";

// ?page=<pageId> (the preview's "Sửa trong editor") opens that page; an unknown id falls back to the first page.
export default async function EditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string | string[] }> }) {
  const [{ id }, { page }] = await Promise.all([params, searchParams]);
  const project = loadProject(id);
  return (
    <>
      <PageHeader data-ui="ui_editor_page_header" crumbs={projectCrumbs(project.url, id, "Editor")} title="Editor" />
      <EditorView projectId={id} initialPage={typeof page === "string" ? page : ""} />
    </>
  );
}
