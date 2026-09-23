import { expect, test } from "vitest";
import { encrypt, decrypt } from "@/core/crypto";

test("roundtrip", () => {
  const s = "sk-secret-123";
  const blob = encrypt(s);
  expect(blob).not.toContain(s);
  expect(decrypt(blob)).toBe(s);
});

test("tamper detected", () => {
  const blob = encrypt("x");
  const bad = Buffer.from(blob, "base64");
  bad[bad.length - 1]! ^= 0xff;
  expect(() => decrypt(bad.toString("base64"))).toThrow();
});
