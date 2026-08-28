import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  photosDir: string;
  logsDir: string;
  dbPath: string;
  clientOrigin: string;
  clientDist: string | null;
  ollamaUrl: string;
  ollamaModel: string;
}

export function loadConfig(): ServerConfig {
  const dataDir = path.resolve(serverRoot, process.env.DATA_DIR ?? "./data");
  const photosDir = path.join(dataDir, "photos");
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(photosDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3001),
    dataDir,
    photosDir,
    logsDir,
    dbPath: path.join(dataDir, "dronetuner.db"),
    clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
    // Opt-in: only serve a built client bundle when CLIENT_DIST is explicitly set.
    clientDist: process.env.CLIENT_DIST ? path.resolve(serverRoot, process.env.CLIENT_DIST) : null,
    ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1",
  };
}
