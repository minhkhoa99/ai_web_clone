import { subscribe } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED = 1_000; // a client this far behind is gone or stuck: close instead of buffering forever

// SSE: the current status first (a late subscriber starts in sync), then every job event, plus a heartbeat comment.
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { status } = requireProject(getDb(), id);
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
        const unsubscribe = subscribe(id, (e) => send(`data: ${JSON.stringify(e)}\n\n`));
        const heartbeat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
        cleanup = () => {
          unsubscribe();
          clearInterval(heartbeat);
          req.signal.removeEventListener("abort", close);
        };
        req.signal.addEventListener("abort", close);
        send(`data: ${JSON.stringify({ type: "status", status })}\n\n`);
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
  });
}
