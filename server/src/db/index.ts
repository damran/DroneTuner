import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "../config";
import * as schema from "./schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

export function createDb(config: ServerConfig) {
  const sqlite = new Database(config.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  // Expose the raw connection so tests/scripts can close it cleanly.
  (db as { $client?: Database.Database }).$client = sqlite;
  return db;
}

export type Db = ReturnType<typeof createDb>;
