import type { Page } from "playwright";
import { AppError, Codes } from "./errors";
import { snapshotInPage } from "./capture-eval";

export type CaptureNode = {
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  bbox: [number, number, number, number];
  style: Record<string, string>;
  pseudo?: { before?: Record<string, string>; after?: Record<string, string> };
  hidden?: boolean;
  children: CaptureNode[];
};

const MAX_NODES = 20_000;

// One page.evaluate walks the whole tree; styles are diffed against per-tag defaults.
export async function snapshotDom(page: Page): Promise<CaptureNode> {
  const result = await page.evaluate(snapshotInPage, MAX_NODES).catch((err: unknown) => {
    throw new AppError(Codes.BROWSER_CRASH, `DOM snapshot failed: ${String(err)}`, { url: page.url(), cause: err });
  });
  if ("limitExceeded" in result) {
    throw new AppError(Codes.NODE_LIMIT, `DOM exceeds ${MAX_NODES} nodes`, { url: page.url(), limit: MAX_NODES });
  }
  return result.root;
}
