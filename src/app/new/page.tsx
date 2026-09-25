import { projectConfigSchema, type ProjectConfig } from "@/core/jobs-base";
import { getDb } from "@/app/_server/db";
import { PageHeader } from "@/app/_ui/PageHeader";
import { NewCloneForm } from "./new-clone-form";

// "Clone lại" (?from=<id>) prefills URL, mode and config from that project; credentials are never prefilled.
function initialFrom(id: string | undefined): { url: string; mode: "single" | "crawl"; config: ProjectConfig } | undefined {
  if (!id) return undefined;
  const row = getDb().prepare("SELECT url,mode,config_json FROM projects WHERE id=?").get(id) as
    | { url: string; mode: "single" | "crawl"; config_json: string }
    | undefined;
  if (!row) return undefined;
  const config = projectConfigSchema.safeParse(JSON.parse(row.config_json));
  return config.success ? { url: row.url, mode: row.mode, config: config.data } : undefined;
}

export default async function NewPage({ searchParams }: { searchParams: Promise<{ from?: string | string[] }> }) {
  const { from } = await searchParams;
  return (
    <>
      <PageHeader
        data-ui="ui_new_clone_page_header"
        crumbs={[{ label: "Clone mới" }]}
        title="Cấu hình clone mới"
        subtitle="Nhập URL, chọn chế độ, cách đăng nhập, ngưỡng QA và ngân sách token."
      />
      <NewCloneForm initial={initialFrom(typeof from === "string" ? from : undefined)} />
    </>
  );
}
