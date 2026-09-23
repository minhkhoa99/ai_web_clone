import { expect, test } from "vitest";
import { parseOps } from "@/core/qa-fix";

const allowed = new Set(["s:0", "s:0.1"]);
const reply = (ops: unknown[]) => JSON.stringify({ ops });
const node = (tag: string, attrs: Record<string, string> = {}, children: unknown[] = []) => ({ id: "s:0.1", tag, attrs, cls: [], children });
const rejects = (text: string) => expect(() => parseOps(text, allowed)).toThrow(expect.objectContaining({ code: "AI_BAD_RESPONSE" }));

test("valid ops (optionally fenced) parse; ids outside the section, bad JSON and bad shapes are AI_BAD_RESPONSE", () => {
  const ops = [
    { op: "setStyle", id: "s:0", style: { color: "red" } },
    { op: "replaceSubtree", id: "s:0.1", node: node("p", { "aria-label": "x", "data-k": "v" }, [{ id: "n1", tag: "#text", attrs: {}, text: "hi", cls: [], children: [] }]) },
  ];
  expect(parseOps(reply(ops), allowed)).toEqual(ops);
  expect(parseOps("```json\n" + reply(ops) + "\n```", allowed)).toEqual(ops);
  rejects(reply([{ op: "setText", id: "other:1", text: "x" }]));
  rejects("sure, here you go");
  rejects(reply([{ op: "setStyle", id: "s:0", style: { color: 1 } }]));
  rejects(reply(Array.from({ length: 51 }, () => ops[0])));
});

test("replaceSubtree/setAttr reject unsafe tags, event handlers and bad attr names", () => {
  for (const tag of ["script", "style", "iframe", "object", "embed", "base", "meta", "link", "#section", "Script", 'img src=x onerror="a"', "x>"]) {
    rejects(reply([{ op: "replaceSubtree", id: "s:0.1", node: node(tag) }]));
  }
  for (const name of ["onclick", "OnLoad", 'x"', "a b", "1a"]) {
    rejects(reply([{ op: "setAttr", id: "s:0", attrs: { [name]: "v" } }]));
    rejects(reply([{ op: "replaceSubtree", id: "s:0.1", node: node("div", { [name]: "v" }) }]));
  }
});

test("replaceSubtree deeper than 20 or larger than 500 nodes is rejected", () => {
  let deep = node("div");
  for (let i = 0; i < 20; i++) deep = node("div", {}, [deep]);
  rejects(reply([{ op: "replaceSubtree", id: "s:0.1", node: deep }]));
  rejects(reply([{ op: "replaceSubtree", id: "s:0.1", node: node("div", {}, Array.from({ length: 500 }, () => node("span"))) }]));
});
