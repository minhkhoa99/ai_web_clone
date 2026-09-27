import type { Interaction } from "./interactions";
import type { StyleSet } from "./dedupe";

export type LegacyIRNode = {
  id: string;
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  cls: string[];
  hidden?: boolean;
  states?: { hover?: string; focus?: string; active?: string };
  behavior?: string;
  children: LegacyIRNode[];
};
export type LegacySection = {
  id: string;
  pageId: string;
  name: string;
  role: string;
  hash: string;
  origin: "capture" | "ai";
  root: LegacyIRNode;
  layoutId?: string;
};
export type LegacyPage = { id: string; path: string; title: string; meta: Record<string, string>; sectionIds: string[]; shell: LegacyIRNode };
export type LegacyLayout = { id: string; hash: string; sectionId: string; pageIds: string[] };
export type LegacyComponent = { id: string; hash: string; instanceIds: string[] };
export type LegacyIR = {
  pages: LegacyPage[];
  sections: LegacySection[];
  layouts: LegacyLayout[];
  components: LegacyComponent[];
  classes: Record<string, StyleSet>;
  tokens: Record<string, string>;
  cssom: { keyframes: string[]; fontFace: string[]; vars: Record<string, string> };
  interactions: (Interaction & { pageId: string })[];
};
