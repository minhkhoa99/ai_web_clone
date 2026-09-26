import { history } from "@/core/event-log";
import { isWaiting, subscribe } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED = 1_000; // a client this far behind is gone or stuck: close instead of buffering forever

// SSE (spec parity §4.2): the persisted event tail (<= 2000, for the log + run clock after a reload/restart), then the
// current status (+ its persisted reason, + whether it waits in the queue), then every live job event, plus a heartbeat
// comment. Snapshot, status and subscribe happen in one synchronous tick: no event is lost or sent twice.
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { status, status_reason: reason } = requireProject(getDb(), id);
    const enc = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed or cancelled by the reader
          }
        };
        const send = (chunk: string) => {
          if ((controller.desiredSize ?? 0) < -MAX_BUFFERED) return close();
          controller.enqueue(enc.encode(chunk));
        };
        send(`data: ${JSON.stringify({ type: "history", events: history(id) })}\n\n`);
        send(`data: ${JSON.stringify({ type: "status", status, ...(reason ? { reason } : {}), queued: isWaiting(id), at: Date.now() })}\n\n`);
        const unsubscribe = subscribe(id, (e) => send(`data: ${JSON.stringify(e)}\n\n`));
        const heartbeat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
        cleanup = () => {
          unsubscribe();
          clearInterval(heartbeat);
          req.signal.removeEventListener("abort", close);
        };
        req.signal.addEventListener("abort", close);
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
  });
}
