// Inspector ops (spec §9 fix loop): mandatory pre-round checks for the
// orchestrator, and bounded tool-calls the AI can make during a fix round.
// Every op is bounded (char/prop caps, 2s action timeout) and turns a raw
// Playwright failure into a clean AppError carrying the offending input.
import type { Page } from "playwright";
import { z } from "zod";
import { AppError, Codes } from "./errors";
import { blockNavigationAway } from "./browser";
import type { ToolDef } from "./gateway";

const MAX_A11Y_CHARS = 4000;
const MAX_STYLE_PROPS = 50;
const OP_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_CALLS = 5;
const MAX_TOOL_SHOT_PX = 800; // a tool screenshot is at most 800x800 CSS px (token bound)

function opFailed(what: string, context: Record<string, unknown>, cause: unknown): AppError {
  return new AppError(Codes.INSPECTOR_OP_FAILED, `${what} failed: ${String(cause)}`, { ...context, cause });
}

export async function snapshotA11y(page: Page, selector: string): Promise<string> {
  try {
    const snapshot = await page.locator(selector).first().ariaSnapshot({ timeout: OP_TIMEOUT_MS });
    return snapshot.slice(0, MAX_A11Y_CHARS);
  } catch (err) {
    throw opFailed("snapshotA11y", { selector }, err);
  }
}

export async function screenshotSection(page: Page, bbox: [number, number, number, number]): Promise<Buffer> {
  const [x, y, w, h] = bbox;
  const clip = { x, y, width: Math.max(1, w), height: Math.max(1, h) };
  try {
    return await page.screenshot({ clip, fullPage: true, animations: "disabled", caret: "hide" });
  } catch (err) {
    throw opFailed("screenshotSection", { bbox }, err);
  }
}

export async function hover(page: Page, selector: string): Promise<void> {
  try {
    await page.hover(selector, { timeout: OP_TIMEOUT_MS });
  } catch (err) {
    throw opFailed("hover", { selector }, err);
  }
}

export async function click(page: Page, selector: string): Promise<void> {
  const unblock = await blockNavigationAway(page, page.url());
  try {
    await page.click(selector, { timeout: OP_TIMEOUT_MS });
  } catch (err) {
    throw opFailed("click", { selector }, err);
  } finally {
    await unblock();
  }
}

// Reads computed style values for the given props (capped at MAX_STYLE_PROPS).
// No closure capture: passed straight to locator.evaluate as a page-context function.
function readComputedStyleInPage(el: Element, props: string[]): Record<string, string> {
  const computed = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const prop of props) out[prop] = computed.getPropertyValue(prop);
  return out;
}

export async function readStyle(page: Page, selector: string, props: string[]): Promise<Record<string, string>> {
  const capped = props.slice(0, MAX_STYLE_PROPS);
  try {
    return await page.locator(selector).first().evaluate(readComputedStyleInPage, capped, { timeout: OP_TIMEOUT_MS });
  } catch (err) {
    throw opFailed("readStyle", { selector }, err);
  }
}

// ---- bounded tool wrapper for AI tool-calls ----

const targetSchema = z.enum(["orig", "clone"]);
const targetParam = { type: "string", enum: ["orig", "clone"] };

const selectorArgs = z.object({ target: targetSchema, selector: z.string().min(1) });
const bboxArgs = z.object({ target: targetSchema, bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]) });
const styleArgs = z.object({ target: targetSchema, selector: z.string().min(1), props: z.array(z.string()).min(1) });

interface ToolSpec {
  description: string;
  parameters: Record<string, unknown>;
  schema: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { message: string } } };
  // attach: hands a base64 PNG to the caller, who sends it as an image of the next AI call (never as result text)
  run(page: Page, args: never, attach: (png: string) => void): Promise<unknown>;
}

const TOOL_SPECS: Record<string, ToolSpec> = {
  snapshotA11y: {
    description: "Accessibility (ARIA) snapshot of the element matching selector, truncated to 4000 chars.",
    parameters: {
      type: "object",
      properties: { target: targetParam, selector: { type: "string" } },
      required: ["target", "selector"],
    },
    schema: selectorArgs,
    run: (page, args: z.infer<typeof selectorArgs>) => snapshotA11y(page, args.selector),
  },
  screenshotSection: {
    description: `Screenshot of the given [x,y,w,h] bounding box (at most ${MAX_TOOL_SHOT_PX}x${MAX_TOOL_SHOT_PX}: larger boxes are clipped to their top-left part), attached as an image to the next message.`,
    parameters: {
      type: "object",
      properties: {
        target: targetParam,
        bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
      },
      required: ["target", "bbox"],
    },
    schema: bboxArgs,
    run: async (page, args: z.infer<typeof bboxArgs>, attach) => {
      const [x, y, w, h] = args.bbox;
      const clip: [number, number, number, number] = [x, y, Math.min(w, MAX_TOOL_SHOT_PX), Math.min(h, MAX_TOOL_SHOT_PX)];
      attach((await screenshotSection(page, clip)).toString("base64"));
      const clipped = w > MAX_TOOL_SHOT_PX || h > MAX_TOOL_SHOT_PX;
      return clipped ? `image attached (clipped to the top-left ${clip[2]}x${clip[3]} of the requested ${w}x${h})` : "image attached";
    },
  },
  hover: {
    description: "Hover the element matching selector.",
    parameters: {
      type: "object",
      properties: { target: targetParam, selector: { type: "string" } },
      required: ["target", "selector"],
    },
    schema: selectorArgs,
    run: async (page, args: z.infer<typeof selectorArgs>) => {
      await hover(page, args.selector);
      return null;
    },
  },
  click: {
    description: "Click the element matching selector; navigation away is blocked.",
    parameters: {
      type: "object",
      properties: { target: targetParam, selector: { type: "string" } },
      required: ["target", "selector"],
    },
    schema: selectorArgs,
    run: async (page, args: z.infer<typeof selectorArgs>) => {
      await click(page, args.selector);
      return null;
    },
  },
  readStyle: {
    description: "Computed style values for the given props (max 50) on the element matching selector.",
    parameters: {
      type: "object",
      properties: {
        target: targetParam,
        selector: { type: "string" },
        props: { type: "array", items: { type: "string" } },
      },
      required: ["target", "selector", "props"],
    },
    schema: styleArgs,
    run: (page, args: z.infer<typeof styleArgs>) => readStyle(page, args.selector, args.props),
  },
};

export function asTools(
  pages: { orig?: Page; clone: Page },
  opts: { maxCalls?: number } = {},
): { tools: ToolDef[]; call(name: string, args: unknown): Promise<unknown>; calls(): number; takeImages(): string[] } {
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  let count = 0;
  let images: string[] = []; // <= maxCalls screenshots, each <= 800x800

  const tools: ToolDef[] = Object.entries(TOOL_SPECS).map(([name, spec]) => ({
    name,
    description: spec.description,
    parameters: spec.parameters,
  }));

  async function call(name: string, args: unknown): Promise<unknown> {
    if (count >= maxCalls) {
      throw new AppError(Codes.AI_BAD_RESPONSE, `inspector tool call limit exceeded`, { limit: maxCalls });
    }
    count++;

    // own keys only: "constructor" / "__proto__" are not tools
    const spec = Object.hasOwn(TOOL_SPECS, name) ? TOOL_SPECS[name] : undefined;
    if (!spec) return { error: `unknown tool: ${name}` };

    const parsed = spec.schema.safeParse(args);
    if (!parsed.success) return { error: parsed.error?.message ?? "invalid tool arguments" };

    const target = (parsed.data as { target: "orig" | "clone" }).target;
    const page = target === "orig" ? pages.orig : pages.clone;
    if (!page) return { error: `target "${target}" not available` };

    try {
      return await spec.run(page, parsed.data as never, (png) => images.push(png));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // The screenshots attached since the last take (for the next AI call's `images`).
  const takeImages = () => {
    const taken = images;
    images = [];
    return taken;
  };
  return { tools, call, calls: () => count, takeImages };
}
