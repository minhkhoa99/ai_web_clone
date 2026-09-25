import { projectConfigSchema, type ProjectConfig } from "@/core/jobs-base";
import { getDb } from "@/app/_server/db";
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
  // P20: the title/subtitle/divider live inside the form card itself (as in the mockup), not the shared PageHeader.
  return <NewCloneForm initial={initialFrom(typeof from === "string" ? from : undefined)} />;
}
