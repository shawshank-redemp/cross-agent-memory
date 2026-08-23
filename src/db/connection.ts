import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");
const DEFAULT_DB_PATH = join(__dirname, "..", "..", "data", "db", "cross_agent_memory.sqlite");

export function openDb(path: string = DEFAULT_DB_PATH): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  return db;
}

export function dbExistsAt(path: string = DEFAULT_DB_PATH): boolean {
  return existsSync(path);
}

export { DEFAULT_DB_PATH };
