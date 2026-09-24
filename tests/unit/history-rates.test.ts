import { expect, test } from "vitest";
import { openDb } from "@/core/db";
import { DEFAULT_FIX_RATE, DEFAULT_SECTIONS_PER_PAGE } from "@/core/estimate";
import { historyRates } from "@/app/p/[id]/data";

test("historyRates: defaults below 20 samples; measured ratios from completed projects once there are enough", () => {
  const db = openDb(":memory:");
  expect(historyRates(db)).toEqual({ sectionsPerPage: DEFAULT_SECTIONS_PER_PAGE, fixRate: DEFAULT_FIX_RATE });
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES('p','http://x/','crawl','{}','completed')").run();
  const node = db.prepare("INSERT INTO nodes(id,project_id,type,key,data_json) VALUES(?,?,?,?,'{}')");
  for (let i = 0; i < 20; i++) node.run(`page${i}`, "p", "Page", `/${i}`);
  for (let i = 0; i < 100; i++) node.run(`sec${i}`, "p", "Section", `s${i}`);
  const task = db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'fix',?,'done')");
  for (let i = 0; i < 10; i++) task.run(`t${i}`, "p", `page0:sec${i}`);
  expect(historyRates(db)).toEqual({ sectionsPerPage: 5, fixRate: 0.1 });
});
