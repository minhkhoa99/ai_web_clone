import { z } from "zod";
import { createProject } from "@/core/jobs";
import { createSchema } from "@/core/jobs-base";
import { getDb } from "@/app/_server/db";
import { handle } from "@/app/_server/http";
import { credentialsSchema, holdCredentials } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

// Credentials are split off here: held in RAM (or encrypted if remembered), never in config_json.
const bodySchema = createSchema.extend({ credentials: credentialsSchema.optional() }).strict();
const listSchema = z.object({
  group: z.enum(["incomplete", "completed"]).optional(),
  q: z.string().max(2048).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});

export function POST(req: Request) {
  return handle(req, async () => {
    const { credentials, ...input } = bodySchema.parse(await req.json());
    const db = getDb();
    const id = createProject(db, input);
    if (credentials) holdCredentials(db, id, credentials);
    return Response.json({ id }, { status: 201 });
  });
}

// History list: 20 per page, newest update first, `q` = URL substring, `phase` = first unfinished task's phase.
export function GET(req: Request) {
  return handle(req, () => {
    const { group, q, page } = listSchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    const where = [
      group === "completed" ? "status='completed'" : group === "incomplete" ? "status<>'completed'" : "1",
      q ? "instr(url, ?) > 0" : "1",
    ].join(" AND ");
    const args = q ? [q] : [];
    const db = getDb();
    const { total } = db.prepare(`SELECT COUNT(*) total FROM projects WHERE ${where}`).get(...args) as { total: number };
    const projects = db
      .prepare(
        `SELECT id,url,mode,status,progress,tokens_used AS tokensUsed,created_at AS createdAt,updated_at AS updatedAt,
           (SELECT phase FROM tasks t WHERE t.project_id=p.id AND t.status<>'done' ORDER BY rowid LIMIT 1) AS phase
         FROM projects p WHERE ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return Response.json({ projects, total, page, pageSize: PAGE_SIZE });
  });
}
