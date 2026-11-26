import { runner } from "node-pg-migrate";
import path from "path";
import pkg from "@next/env";
const { loadEnvConfig } = pkg;

loadEnvConfig(process.cwd());

const args = process.argv.slice(2);
const rollbackIdx = args.indexOf("--rollback");
const isRollback = rollbackIdx !== -1;

let direction = (isRollback ? "down" : args[0] ?? "up") as "up" | "down";
let count = direction === "down" ? 1 : Infinity;

if (isRollback) {
  const next = args[rollbackIdx + 1];
  if (next !== undefined && !next.startsWith("--")) {
    count = Number(next);
    if (!Number.isInteger(count) || count < 1) {
      console.error("--rollback expects a positive integer, e.g. --rollback 3");
      process.exit(1);
    }
  }
  direction = "down";
}

if (direction !== "up" && direction !== "down") {
  console.error("Usage: ts-node scripts/migrate.ts [up|down] | --rollback [N]");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

runner({
  databaseUrl,
  dir: path.join(__dirname, "../migrations"),
  direction,
  migrationsTable: "pgmigrations",
  count,
  log: (msg: string) => console.log(msg),
})
  .then(() => {
    console.log(`Migrations (${direction}) complete`);
    process.exit(0);
  })
  .catch((err: Error) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
