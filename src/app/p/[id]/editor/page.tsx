import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { loadProject } from "../data";
import { VisualEditor } from "./visual/visual-editor";

// ?page=<pageId> (the preview's "Sửa trong editor") opens that page; an unknown id falls back to the first page.
// The old ?legacy=1 is ignored: it opens this editor too (E3b R15).
export default async function EditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string | string[] }> }) {
  const [{ id }, { page }] = await Promise.all([params, searchParams]);
  const project = loadProject(id);
  const initialPage = typeof page === "string" ? page : "";
  return (
    <>
      <PageHeader data-ui="ui_editor_page_header" crumbs={projectCrumbs(project.url, id, "Editor")} title="Editor" />
      <VisualEditor projectId={id} initialPage={initialPage} />
    </>
  );
}
