import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");

export interface ServerConfig {
  port: number;
  dataDir: string;
  photosDir: string;
  logsDir: string;
  dbPath: string;
  clientOrigin: string;
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
    port: Number(process.env.PORT ?? 3001),
    dataDir,
    photosDir,
    logsDir,
    dbPath: path.join(dataDir, "dronetuner.db"),
    clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
    ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1",
  };
}
