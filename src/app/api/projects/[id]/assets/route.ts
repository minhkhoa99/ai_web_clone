import { MAX_FILE_BYTES } from "@/core/assets";
import { storeUpload } from "@/core/upload";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, multipartBody, requireProject, workspaceOf, type IdCtx } from "@/app/_server/http";
import { exclusiveEdit, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = MAX_FILE_BYTES + 64 * 1024; // the file + multipart framing

// E3 §5: one image (field `file`) -> assets/<sha>.<ext> + the uploads map; { key (asset map key), url (files route) }.
// The client's name / content-type are never trusted: storeUpload checks extension + magic bytes, the path is the hash.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    const files = (await multipartBody(req, MAX_BODY)).getAll("file");
    const file = files[0];
    if (files.length !== 1 || typeof file === "string" || !file) throw new ApiError(400, "VALIDATION", "send exactly one file in the `file` field");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { key, file: rel } = await exclusiveEdit(db, id, () => storeUpload(workspaceOf(id), file.name, bytes));
    return Response.json({ key, url: `/api/projects/${encodeURIComponent(id)}/files/${rel}` });
  }, { body: "multipart" });
}
