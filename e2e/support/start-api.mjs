// start-api.mjs — launch the Go server for E2E against a fresh database.
//
// Playwright's webServer runs this from the repo root. It removes any previous
// SQLite file so each suite run starts from a clean slate, then execs the server
// with the environment Playwright supplied (PORT, JWT_SECRET, DB_PATH, ...).

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const dbPath = process.env.DB_PATH || path.join(root, "e2e", ".tmp", "e2e.db");

mkdirSync(path.dirname(dbPath), { recursive: true });
for (const suffix of ["", "-shm", "-wal"]) {
  try {
    rmSync(dbPath + suffix);
  } catch {
    /* nothing to remove */
  }
}

const child = spawn("go", ["run", "./server"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

const shutdown = () => child.kill("SIGTERM");
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => process.exit(code ?? 0));
