import { expect, test } from "vitest";
import { fmtBytes, fmtDuration, fmtInt, fmtMinutes, fmtPct, fmtTokens } from "@/app/_ui/format";
import { clock } from "@/app/_ui/LogView";
import { relative } from "@/app/_ui/RelTime";

test("format.ts (vi-VN)", () => {
  expect(fmtInt(2_000_000)).toBe("2.000.000");
  expect(fmtPct(0.962)).toBe("96,2%");
  expect(fmtPct(0.95, 0)).toBe("95%");
  expect([fmtTokens(1_200_000), fmtTokens(2_000_000), fmtTokens(140_000), fmtTokens(861_000), fmtTokens(950)]).toEqual(["1,2M", "2M", "140k", "861k", "950"]);
  expect([fmtBytes(512), fmtBytes(19_046), fmtBytes(3 * 1024 * 1024)]).toEqual(["512 B", "18,6 KB", "3,0 MB"]);
  expect([fmtDuration(252_000), fmtDuration(0), fmtDuration(3_723_000)]).toEqual(["00:04:12", "00:00:00", "01:02:03"]);
  expect([fmtMinutes(45), fmtMinutes(360), fmtMinutes(1216.5)]).toEqual(["<1 phút", "~6 phút", "~20 phút"]);
});

test("relative time (vi) and log clock", () => {
  const now = Date.UTC(2026, 8, 24, 12, 0, 0);
  expect(relative(now - 12_000, now)).toBe("12 giây trước");
  expect(relative(now - 5 * 60_000, now)).toBe("5 phút trước");
  expect(relative(now - 86_400_000, now)).toBe("hôm qua");
  expect(clock(new Date(2026, 8, 24, 14, 22, 1, 104).getTime())).toBe("14:22:01.104");
});
