import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");
const DEFAULT_DB_PATH = join(__dirname, "..", "..", "data", "db", "cross_agent_memory.sqlite");

// Column names per table, parsed out of schema.sql. Deliberately derived from
// the file rather than hand-listed, so it cannot fall behind the schema it is
// meant to check.
function declaredColumns(schemaSql: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const createTable = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const match of schemaSql.matchAll(createTable)) {
    const [, table, body] = match;
    if (!table || !body) continue;
    const columns: string[] = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      // Skip comments, blank lines, and table-level constraints.
      if (line.length === 0 || line.startsWith("--")) continue;
      if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
      const name = line.split(/\s+/)[0]?.replace(/[(),]/g, "");
      if (name) columns.push(name);
    }
    tables.set(table, columns);
  }
  return tables;
}

// FAIL FAST ON A STALE DB FILE. `CREATE TABLE IF NOT EXISTS` is a no-op on a
// table that already exists, so a db file written before a column was added
// keeps the OLD shape forever — and `npm run load:data` does not help, because
// it DELETEs rows rather than recreating tables.
//
// Without this check the first affected INSERT throws "no such column" in the
// middle of a batch run, after the API calls have already been paid for. The
// data here is disposable and seed-regenerated, so the fix is to delete the
// file, not to migrate it — but that has to be said out loud, at open, rather
// than discovered at event 400.
function assertSchemaIsCurrent(db: Database.Database, schemaSql: string, path: string): void {
  const missing: string[] = [];
  for (const [table, expected] of declaredColumns(schemaSql)) {
    const actual = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    if (actual.size === 0) continue; // table not created yet; schema.sql just made it
    for (const column of expected) {
      if (!actual.has(column)) missing.push(`${table}.${column}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `The database at ${path} predates a schema change and is missing: ${missing.join(", ")}.\n` +
        `CREATE TABLE IF NOT EXISTS cannot add columns to an existing table. This data is ` +
        `seed-regenerated and disposable, so delete the db and rebuild:\n` +
        `  rm -rf data/db && npm run load:data`,
    );
  }
}

export function openDb(path: string = DEFAULT_DB_PATH): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schemaSql);
  assertSchemaIsCurrent(db, schemaSql, path);
  return db;
}

export function dbExistsAt(path: string = DEFAULT_DB_PATH): boolean {
  return existsSync(path);
}

export { DEFAULT_DB_PATH };
