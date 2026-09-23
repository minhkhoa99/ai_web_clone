import Link from "next/link";
import type { ProjectConfig } from "@/core/jobs-base";
import { loadProject } from "../data";
import { PreviewView } from "./preview-view";

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = loadProject(id);
  const { threshold } = JSON.parse(project.config_json) as ProjectConfig;
  return (
    <>
      <div className="row spread">
        <h1>Preview &amp; QA</h1>
        <nav className="row" aria-label="Dự án">
          <Link href={`/p/${id}`}>Tiến độ</Link>
          <Link href={`/p/${id}/code`}>Code</Link>
        </nav>
      </div>
      <PreviewView projectId={id} threshold={threshold} />
    </>
  );
}
