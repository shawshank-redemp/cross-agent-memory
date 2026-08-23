import { openDb } from "../db/connection.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 4000);

const db = openDb();
const app = createApp(db);

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
