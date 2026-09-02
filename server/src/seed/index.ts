import { loadConfig } from "../config";
import { createDb } from "../db";
import { runSeed } from "./seed";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config);
  await runSeed(db, { log: (m) => console.log(m) });
  console.log("Seed complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
