import { z } from "zod";
import { createProject, isWaiting } from "@/core/jobs";
import { createSchema } from "@/core/jobs-base";
import { getDb } from "@/app/_server/db";
import { handle } from "@/app/_server/http";
import { credentialsSchema, holdCredentials, needsCredentialsFrom } from "@/app/_server/session";

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

type LastError = { code: string | null; message: string; phase: string; key: string };
type Row = {
  id: string;
  url: string;
  mode: string;
  status: string;
  statusReason: string | null;
  progress: number;
  tokensUsed: number;
  createdAt: number;
  updatedAt: number;
  phase: string | null;
  thumbPage: string | null;
  config_json: string;
  auth_enc: string | null;
  loginStatus: string | null;
  loginErrorCode: string | null;
};

// History list: 20 per page, newest update first, `q` = URL substring, `phase` = first unfinished task's phase,
// `thumbPage` = first captured pageId, `needsCredentials` = resume must ask for a login first, `queued` = waiting in
// the job queue; per row `pageCount` (capture tasks; null = draft without a selection), `phaseDone/phaseTotal` of the
// current phase, `lastError` (failed | needs_auth only, message <= 500 chars, redacted when written); `counts` per
// group under the same `q` (`total` = the group's count). 4 fixed queries per request (no per-task query, no per-row query).
export function GET(req: Request) {
  return handle(req, () => {
    const { group, q, page } = listSchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    const qWhere = q ? "instr(url, ?) > 0" : "1";
    const where = [group === "completed" ? "status='completed'" : group === "incomplete" ? "status<>'completed'" : "1", qWhere].join(" AND ");
    const args = q ? [q] : [];
    const db = getDb();
    const counts = db
      .prepare(`SELECT COALESCE(SUM(status<>'completed'),0) incomplete, COALESCE(SUM(status='completed'),0) completed FROM projects WHERE ${qWhere}`)
      .get(...args) as { incomplete: number; completed: number };
    const total = group ? counts[group] : counts.incomplete + counts.completed;
    const rows = db
      .prepare(
        `SELECT id,url,mode,status,status_reason AS statusReason,progress,tokens_used AS tokensUsed,created_at AS createdAt,updated_at AS updatedAt,config_json,auth_enc,
           (SELECT phase FROM tasks t WHERE t.project_id=p.id AND t.status<>'done' ORDER BY rowid LIMIT 1) AS phase,
           (SELECT key FROM tasks t WHERE t.project_id=p.id AND t.phase='capture' AND t.status='done' ORDER BY rowid LIMIT 1) AS thumbPage,
           (SELECT status FROM tasks t WHERE t.project_id=p.id AND t.phase='login' ORDER BY rowid LIMIT 1) AS loginStatus,
           (SELECT error_code FROM tasks t WHERE t.project_id=p.id AND t.phase='login' ORDER BY rowid LIMIT 1) AS loginErrorCode
         FROM projects p WHERE ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Row[];
    const ids = rows.map((r) => r.id);
    const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
    const agg = ids.length
      ? (db.prepare(`SELECT project_id, phase, COUNT(*) total, SUM(status='done') done FROM tasks WHERE project_id IN (${marks(ids.length)}) GROUP BY project_id, phase`).all(...ids) as {
          project_id: string;
          phase: string;
          total: number;
          done: number;
        }[])
      : [];
    const errIds = rows.filter((r) => r.status === "failed" || r.status === "needs_auth").map((r) => r.id);
    const errs = errIds.length
      ? (db
          .prepare(
            `SELECT project_id, error_code, error_msg, phase, key FROM (
               SELECT project_id, error_code, substr(error_msg,1,500) error_msg, phase, key,
                      ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY updated_at DESC, rowid DESC) rn
               FROM tasks WHERE status IN ('failed','needs_auth') AND project_id IN (${marks(errIds.length)})) WHERE rn=1`,
          )
          .all(...errIds) as { project_id: string; error_code: string | null; error_msg: string | null; phase: string; key: string }[])
      : [];
    const byPhase = new Map(agg.map((a) => [`${a.project_id}:${a.phase}`, a]));
    const lastErrorOf = new Map<string, LastError>(errs.map((e) => [e.project_id, { code: e.error_code, message: e.error_msg ?? "", phase: e.phase, key: e.key }]));
    const projects = rows.map((p) => {
      const capture = byPhase.get(`${p.id}:capture`);
      const current = p.phase ? byPhase.get(`${p.id}:${p.phase}`) : undefined;
      const { config_json, auth_enc, loginStatus, loginErrorCode, ...pub } = p;
      return {
        ...pub,
        needsCredentials: needsCredentialsFrom(p.id, { config_json, auth_enc, loginStatus, loginErrorCode }),
        queued: isWaiting(p.id),
        pageCount: capture?.total ?? null,
        phaseDone: current?.done ?? null,
        phaseTotal: current?.total ?? null,
        lastError: lastErrorOf.get(p.id) ?? null,
      };
    });
    return Response.json({ projects, total, page, pageSize: PAGE_SIZE, counts });
  });
}
