import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { loadProject } from "../data";
import { EditorView } from "./editor-view";
import { VisualEditor } from "./visual/visual-editor";

// ?page=<pageId> (the preview's "Sửa trong editor") opens that page; an unknown id falls back to the first page.
// ?legacy=1: the GrapesJS editor ("Editor cũ", E3a R15) until E3b removes it.
export default async function EditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string | string[]; legacy?: string | string[] }> }) {
  const [{ id }, { page, legacy }] = await Promise.all([params, searchParams]);
  const project = loadProject(id);
  const initialPage = typeof page === "string" ? page : "";
  return (
    <>
      <PageHeader data-ui="ui_editor_page_header" crumbs={projectCrumbs(project.url, id, "Editor")} title="Editor" />
      {legacy === "1" ? <EditorView projectId={id} initialPage={initialPage} /> : <VisualEditor projectId={id} initialPage={initialPage} />}
    </>
  );
}
