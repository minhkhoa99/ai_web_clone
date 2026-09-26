// Setup file: each e2e test file (its own module graph) gets its own sqlite file under the run's scratch dir, so
// in-process files running in parallel never contend for one db's write lock. Runs before the file imports config.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { inject } from "vitest";

process.env.DB_PATH = join(inject("nextBuildDir"), "db", `${randomUUID()}.db`);
