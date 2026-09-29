// Element / attribute names allowed in AI- and editor-authored markup (fix loop, editor adapter).
// Dependency-free apart from zod: safe to import from pure modules.
import { z } from "zod";

// plain element names outside the denylist
const DENIED_TAGS = new Set(["script", "style", "iframe", "object", "embed", "base", "meta", "link", "#section"]);
export const tagSchema = z
  .string()
  .regex(/^(#text|[a-z][a-z0-9-]*)$/)
  .refine((t) => !DENIED_TAGS.has(t), "tag not allowed");
// no event-handler attrs
export const attrsSchema = z.record(
  z
    .string()
    .regex(/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/)
    .refine((n) => !/^on/i.test(n), "event handler attrs not allowed"),
  z.string(),
);

// Browsers strip whitespace/control chars before reading the scheme ("java\tscript:" still runs).
const isJavascriptUrl = (value: string) => value.replace(/[\u0000-\u0020]/g, "").toLowerCase().startsWith("javascript:");
const SVG_ANIMATION = new Set(["animate", "set"]);
const ANIMATION_VALUES = new Set(["values", "to", "from", "by"]);

// A javascript: URL in any attribute, or inside an SVG <animate>/<set> value list ("a;javascript:…"): those can
// animate an href into a script URL.
export function isScriptValue(tag: string, name: string, value: string): boolean {
  if (isJavascriptUrl(value)) return true;
  return SVG_ANIMATION.has(tag.toLowerCase()) && ANIMATION_VALUES.has(name.toLowerCase()) && value.split(";").some(isJavascriptUrl);
}

// A CSS declaration that cannot break out of its rule.
export const CSS_PROP = /^-?[a-z][a-z0-9-]*$/;
const CSS_BREAKOUT = /[{};<]/;
export const isSafeCss = (prop: string, value: unknown): value is string =>
  CSS_PROP.test(prop) && typeof value === "string" && value !== "" && !CSS_BREAKOUT.test(value);

// Attributes an editor command may write: attrsSchema, nothing the emitter drops (class/srcdoc/script URLs),
// no inline style (styles are the source of truth) and no __proto__ key.
const COMMAND_DENIED_ATTRS = new Set(["class", "srcdoc", "style", "__proto__"]);
export const isSafeAttr = (tag: string, name: string, value: unknown): value is string =>
  typeof value === "string" && !COMMAND_DENIED_ATTRS.has(name.toLowerCase()) &&
  attrsSchema.safeParse({ [name]: value }).success && !isScriptValue(tag, name, value);
