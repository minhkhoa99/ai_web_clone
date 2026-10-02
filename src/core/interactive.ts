// E2 §2: the interactive component model on IR v2 nodes. Pure (zod + plain data): no DOM, fs, Date or random.
import { z } from "zod";
import { AppError, Codes } from "./errors";
import type { IRNodeV2, IRV2 } from "./ir-v2";

export type Bp = "1440" | "768" | "375";
export type InteractiveKind = "carousel" | "tabs" | "accordion" | "modal" | "dropdown" | "menu" | "video";
export type Confidence = "config" | "observed" | "guessed" | "manual";
export type InteractiveSource = "swiper" | "slick" | "splide" | "scroll-snap" | "aria" | "details" | "native" | "generic" | "manual";
interface InteractiveBase { kind: InteractiveKind; source: InteractiveSource; confidence: Confidence }
export interface CarouselSpec extends InteractiveBase {
  kind: "carousel"; viewport: string; track: string; slides: string[]; active: number;
  autoplay: boolean; interval: number; loop: boolean; direction: "horizontal" | "vertical";
  transition: "slide" | "fade"; speed: number;
  slidesPerView: Partial<Record<Bp, number>>; gap: Partial<Record<Bp, number>>;
  arrows?: { prev?: string; next?: string }; pagination?: { container: string; kind: "bullets" | "fraction" };
}
export interface TabsSpec extends InteractiveBase { kind: "tabs"; tabs: { trigger: string; panel: string }[]; active: number }
export interface AccordionSpec extends InteractiveBase { kind: "accordion"; items: { trigger: string; panel: string; open: boolean }[]; multiple: boolean }
export interface ModalSpec extends InteractiveBase { kind: "modal"; triggers: string[]; dialog: string; closeOn: ("backdrop" | "esc" | "button")[]; closeButton?: string }
export interface DropdownSpec extends InteractiveBase { kind: "dropdown" | "menu"; trigger: string; panel: string; openOn: "click" | "hover" }
export interface VideoSpec extends InteractiveBase { kind: "video"; node: string; mode: "native" | "embed"; autoplay: boolean; muted: boolean; loop: boolean; controls: boolean; poster?: string }
export type InteractiveSpec = CarouselSpec | TabsSpec | AccordionSpec | ModalSpec | DropdownSpec | VideoSpec;
export type Role = "viewport" | "track" | "slide" | "prev" | "next" | "pagination" | "tab" | "panel" | "trigger" | "dialog" | "close" | "video";
export type Member = { root: string; spec: InteractiveSpec; role: Role };

export const INTERACTIVE_LIMITS = { perPage: 50, items: 100, cfgBytes: 16 * 1024 } as const;
export const EMBED_HOSTS = ["www.youtube-nocookie.com", "player.vimeo.com"] as const;

const invalid = (message: string): never => { throw new AppError(Codes.IR_PATCH_INVALID, message); };
const id = z.string().min(1).max(200);
const base = {
  source: z.enum(["swiper", "slick", "splide", "scroll-snap", "aria", "details", "native", "generic", "manual"]),
  confidence: z.enum(["config", "observed", "guessed", "manual"]),
};
const perBp = (value: z.ZodNumber) => z.strictObject({ "1440": value.optional(), "768": value.optional(), "375": value.optional() });
const list = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(INTERACTIVE_LIMITS.items);
const carousel = z.strictObject({
  kind: z.literal("carousel"), ...base, viewport: id, track: id, slides: list(id), active: z.number().int().min(0),
  autoplay: z.boolean(), interval: z.number().int().min(1000).max(60000), loop: z.boolean(),
  direction: z.enum(["horizontal", "vertical"]), transition: z.enum(["slide", "fade"]), speed: z.number().int().min(0).max(5000),
  slidesPerView: perBp(z.number().min(1).max(10).multipleOf(0.01)), gap: perBp(z.number().min(0).max(200)),
  arrows: z.strictObject({ prev: id.optional(), next: id.optional() }).optional(),
  pagination: z.strictObject({ container: id, kind: z.enum(["bullets", "fraction"]) }).optional(),
});
const tabs = z.strictObject({ kind: z.literal("tabs"), ...base, tabs: list(z.strictObject({ trigger: id, panel: id })), active: z.number().int().min(0) });
const accordion = z.strictObject({ kind: z.literal("accordion"), ...base, items: list(z.strictObject({ trigger: id, panel: id, open: z.boolean() })), multiple: z.boolean() });
const modal = z.strictObject({ kind: z.literal("modal"), ...base, triggers: list(id), dialog: id, closeOn: z.array(z.enum(["backdrop", "esc", "button"])).max(3), closeButton: id.optional() });
const dropdown = (kind: "dropdown" | "menu") => z.strictObject({ kind: z.literal(kind), ...base, trigger: id, panel: id, openOn: z.enum(["click", "hover"]) });
const video = z.strictObject({ kind: z.literal("video"), ...base, node: id, mode: z.enum(["native", "embed"]), autoplay: z.boolean(), muted: z.boolean(), loop: z.boolean(), controls: z.boolean(), poster: z.string().max(2000).optional() });
export const interactiveSchema = z.discriminatedUnion("kind", [carousel, tabs, accordion, modal, dropdown("dropdown"), dropdown("menu"), video]);

export function rolesOf(spec: InteractiveSpec): [string, Role][] {
  switch (spec.kind) {
    case "carousel": return [[spec.viewport, "viewport"], [spec.track, "track"], ...spec.slides.map((s): [string, Role] => [s, "slide"]),
      ...(spec.arrows?.prev ? [[spec.arrows.prev, "prev"] as [string, Role]] : []), ...(spec.arrows?.next ? [[spec.arrows.next, "next"] as [string, Role]] : []),
      ...(spec.pagination ? [[spec.pagination.container, "pagination"] as [string, Role]] : [])];
    case "tabs": return spec.tabs.flatMap((t): [string, Role][] => [[t.trigger, "tab"], [t.panel, "panel"]]);
    case "accordion": return spec.items.flatMap((t): [string, Role][] => [[t.trigger, "trigger"], [t.panel, "panel"]]);
    case "modal": return [...spec.triggers.map((t): [string, Role] => [t, "trigger"]), [spec.dialog, "dialog"], ...(spec.closeButton ? [[spec.closeButton, "close"] as [string, Role]] : [])];
    case "video": return [[spec.node, "video"]];
    default: return [[spec.trigger, "trigger"], [spec.panel, "panel"]];
  }
}

export function parseSpec(value: unknown): InteractiveSpec {
  const parsed = interactiveSchema.safeParse(value);
  if (!parsed.success) return invalid(`invalid interactive: ${parsed.error.message.slice(0, 300)}`);
  const spec = parsed.data as InteractiveSpec;
  const count = spec.kind === "carousel" ? spec.slides.length : spec.kind === "tabs" ? spec.tabs.length : undefined;
  if (count !== undefined && (spec as CarouselSpec | TabsSpec).active >= count) invalid(`active ${(spec as CarouselSpec).active} is out of range 0..${count - 1}`);
  if (spec.kind === "video" && spec.autoplay && !spec.muted) invalid("a video with autoplay must be muted");
  if (spec.kind === "modal" && spec.closeOn.includes("button") && !spec.closeButton) invalid("closeOn button needs a closeButton");
  const seen = new Set<string>();
  for (const [ref, role] of rolesOf(spec)) {
    if (role === "track" && ref === (spec as CarouselSpec).viewport) continue; // scroll-snap: the box is both
    if (seen.has(ref)) invalid(`duplicate node in interactive: ${ref}`);
    seen.add(ref);
  }
  return spec;
}

export function cfgOf(spec: InteractiveSpec): string {
  const { source: _source, confidence: _confidence, ...cfg } = spec as InteractiveSpec & { poster?: string };
  delete (cfg as { poster?: string }).poster; // a URL: written as the video's own attribute through the asset map
  return JSON.stringify(cfg);
}

const walk = (node: IRNodeV2, visit: (n: IRNodeV2) => void): void => { visit(node); node.children.forEach((c) => walk(c, visit)); };

// After load and after every command (E2 §2): schema, references inside the root (modal triggers and, R2, dropdown/menu
// panels: anywhere on the same page), slides are track children, <= 50 per page, cfg <= 16 KB, never on a component main.
export function checkInteractives(ir: IRV2): void {
  for (const c of ir.components) walk(c.root, (n) => { if (n.interactive) invalid(`component main node ${n.id} cannot hold an interactive`); });
  for (const page of ir.pages) {
    const onPage = new Set<string>(), parent = new Map<string, string>(), roots: IRNodeV2[] = [];
    for (const tree of [page.shell, ...ir.sections.filter((s) => s.pageId === page.id).map((s) => s.root)]) {
      walk(tree, (n) => { onPage.add(n.id); n.children.forEach((c) => parent.set(c.id, n.id)); if (n.interactive) roots.push(n); });
    }
    if (roots.length > INTERACTIVE_LIMITS.perPage) invalid(`page ${page.id} has ${roots.length} components (limit ${INTERACTIVE_LIMITS.perPage})`);
    for (const root of roots) {
      const spec = parseSpec(root.interactive);
      const inside = new Set<string>();
      walk(root, (n) => inside.add(n.id));
      for (const [ref, role] of rolesOf(spec)) {
        if (inside.has(ref)) continue;
        if (spec.kind === "modal" && role === "trigger" && onPage.has(ref)) continue;
        if ((spec.kind === "dropdown" || spec.kind === "menu") && role === "panel" && onPage.has(ref)) continue; // R2
        invalid(`${spec.kind} ${root.id}: ${role} ${ref} is outside the component (or not on page ${page.id})`);
      }
      if (spec.kind === "carousel") for (const s of spec.slides) if (parent.get(s) !== spec.track) invalid(`slide ${s} is not a child of track ${spec.track}`);
      if (new TextEncoder().encode(cfgOf(spec)).length > INTERACTIVE_LIMITS.cfgBytes) invalid(`data-c-cfg of ${root.id} exceeds 16 KB`);
    }
  }
}
