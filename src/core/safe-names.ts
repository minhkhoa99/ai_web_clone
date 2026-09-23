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
