import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = fileURLToPath(new URL("./src", import.meta.url));
const tmp = join(tmpdir(), "ai-web-clone-test");

export default defineConfig({
  resolve: { alias: { "@": src } },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    env: {
      KEY_PATH: join(tmp, "secret.key"),
      DB_PATH: join(tmp, "sp1.db"),
      WORKSPACE_ROOT: join(tmp, "workspace"),
    },
  },
});
