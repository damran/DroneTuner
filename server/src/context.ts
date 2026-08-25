import type { ServerConfig } from "./config";
import type { Db } from "./db";

export interface AppContext {
  db: Db;
  config: ServerConfig;
}
