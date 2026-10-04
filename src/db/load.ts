import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./connection.js";
import { loadGeneratedDataIntoDb } from "./loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = join(__dirname, "..", "..", "data", "generated");

function main(): void {
  const db = openDb();
  const result = loadGeneratedDataIntoDb(db, GENERATED_DIR);
  const dbPath = db.name;
  db.close();
  console.log(`Loaded synthetic batch into ${dbPath}`);
  console.log(JSON.stringify(result, null, 2));
}

main();
