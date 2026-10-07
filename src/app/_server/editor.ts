// E3 §5 route helpers: the canvas URLs of a request and a step's result plus the page sections it changed.
import type { DatabaseSync } from "node:sqlite";
import { affectedOf, type Affected } from "@/core/editor-canvas";
import type { CanvasUrls } from "@/core/emit-html";
import type { DocumentStore, EditResult } from "@/core/ir-store";
import { editorEmit } from "@/core/jobs";
import { ApiError } from "./http";
import { isLoopbackHost } from "./loopback";

// encodeURIComponent leaves !'()* bare; ' would end a CSP source, so every URL part is fully percent-encoded
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Absolute (the srcdoc frame has no URL of its own). The runtime URL lands unescaped in the canvas CSP (canvasCsp):
// the Host is re-checked here (bare loopback host[:port], no path/userinfo/space/`;`) and every other part encoded.
export function canvasUrlsFor(req: Request, projectId: string): (file: string) => CanvasUrls {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!isLoopbackHost(host)) throw new ApiError(403, "FORBIDDEN", "requests must target a loopback host");
  const files = `http://${host}/api/projects/${enc(projectId)}/files`;
  return (file) => ({ base: `${files}/out/${enc(file)}`, runtime: `${files}/out/js/runtime.js?edit=1` });
}

// Runs under exclusiveEdit: nothing else writes the document between the read before and the read after the step.
// A failed step (stale, invalid, materialize) throws before `affected` is computed. Once the step committed, a
// failure computing `affected` is no error: the client gets the committed result and reloads the page.
export async function withAffected(db: DatabaseSync, projectId: string, store: DocumentStore, pageId: string | undefined, step: () => Promise<EditResult>): Promise<EditResult & { affected?: Affected }> {
  if (pageId === undefined) return step();
  const before = await store.readDocument(projectId);
  const result = await step();
  try {
    const [after, emit] = await Promise.all([store.readDocument(projectId), editorEmit(db, projectId)]);
    return { ...result, affected: affectedOf(before, after, pageId, emit) };
  } catch (e) {
    console.error("editor: affected failed after commit", e); // server-side only; core error messages carry no secrets
    return { ...result, affected: { sections: [], css: "", shellChanged: true, interactives: [] } };
  }
}
