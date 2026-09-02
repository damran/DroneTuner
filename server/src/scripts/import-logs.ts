/**
 * One-off importer for a folder of Betaflight blackbox downloads and CLI
 * dumps (the pilot's ext_logs/): creates a drone, one log row per flight
 * session (same rules as POST /api/logs), and stores every CLI dump as a
 * per-drone "snapshot" profile named by its timestamp.
 *
 *   pnpm -C server exec tsx src/scripts/import-logs.ts --name "Air65 R" --size 65mm --video analog \
 *     --dir ../ext_logs/BBLLogs --dumps ../ext_logs [--goal precision] [--replace]
 *
 * Runs against the server's DATA_DIR (server/.env). Idempotent per file name:
 * a log file already imported for that drone is skipped.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseCliDump } from "@dronetuner/shared";
import { loadConfig } from "../config";
import { createDb } from "../db";
import { drones, logs, profiles } from "../db/schema";
import { recordedAtFrom, summarizeSessions } from "../routes/logs";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const name = arg("name");
  const sizeClass = arg("size", "65mm")!;
  const videoSystem = arg("video") ?? null;
  const dir = arg("dir");
  const dumpsDir = arg("dumps");
  const goal = arg("goal", "freestyle")!;
  if (!name || !dir) {
    console.error(
      "usage: --name <drone> --size <class> [--video analog|hd] --dir <folder with .BBL> [--dumps <folder with CLI .txt>] [--goal g] [--replace]",
    );
    process.exit(1);
  }
  const config = loadConfig();
  const db = createDb(config);
  fs.mkdirSync(config.logsDir, { recursive: true });

  let drone = await db.select().from(drones).where(eq(drones.name, name)).get();
  if (drone && has("replace")) {
    await db.delete(drones).where(eq(drones.id, drone.id));
    drone = undefined;
  }
  if (!drone) {
    [drone] = await db
      .insert(drones)
      .values({ name, sizeClass, videoSystem, notes: `Imported from ${path.resolve(dir)}`, createdAt: Date.now() })
      .returning();
    console.log(`Created drone #${drone!.id} ${name}`);
  } else {
    console.log(`Using existing drone #${drone.id} ${name}`);
  }
  const droneId = drone!.id;

  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(bbl|bfl)$/i.test(f))
    .sort();
  let imported = 0;
  let skippedFiles = 0;
  let skippedSessions = 0;
  for (const f of files) {
    const existing = await db
      .select({ id: logs.id })
      .from(logs)
      .where(and(eq(logs.droneId, droneId), eq(logs.originalName, f)))
      .get();
    if (existing) {
      skippedFiles++;
      continue;
    }
    const data = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    const { kept, skipped, total } = summarizeSessions(data);
    if (kept.length === 0) {
      console.log(`  ${f}: no usable session`);
      skippedFiles++;
      continue;
    }
    const stored = `${crypto.randomUUID()}${path.extname(f).toLowerCase()}`;
    fs.copyFileSync(path.join(dir, f), path.join(config.logsDir, stored));
    const uploadedAt = Date.now();
    for (const s of kept) {
      await db.insert(logs).values({
        droneId,
        filePath: stored,
        headersJson: s.headers,
        uploadedAt,
        sessionIndex: s.index,
        sessionCount: total,
        originalName: f,
        durationS: Math.round(s.durationS),
        recordedAt: recordedAtFrom(s.headers, f),
      });
      imported++;
    }
    skippedSessions += skipped;
    console.log(`  ${f}: ${kept.length} flight(s) of ${total} session(s)`);
  }
  console.log(`Logs: ${imported} flights imported, ${skippedFiles} files skipped, ${skippedSessions} short sessions skipped`);

  if (dumpsDir) {
    const dumps = fs
      .readdirSync(dumpsDir)
      .filter((f) => /\.txt$/i.test(f) && fs.statSync(path.join(dumpsDir, f)).size > 100)
      .sort();
    let stored = 0;
    for (const f of dumps) {
      const text = fs.readFileSync(path.join(dumpsDir, f), "utf8");
      const parsed = parseCliDump(text);
      if (parsed.recognized.length === 0) continue;
      const stamp = /(\d{8})_(\d{6})/.exec(f);
      const label = stamp
        ? `${stamp[1]!.slice(0, 4)}-${stamp[1]!.slice(4, 6)}-${stamp[1]!.slice(6, 8)} ${stamp[2]!.slice(0, 2)}:${stamp[2]!.slice(2, 4)}`
        : f.replace(/\.txt$/i, "");
      const profileName = `Flown config ${label}`;
      const exists = await db
        .select({ id: profiles.id })
        .from(profiles)
        .where(and(eq(profiles.droneId, droneId), eq(profiles.name, profileName)))
        .get();
      if (exists) continue;
      await db.insert(profiles).values({
        droneId,
        name: profileName,
        goal,
        sizeClass,
        videoSystem,
        notes:
          `Imported CLI dump ${f}` +
          (parsed.meta.selectedProfile !== undefined ? ` (PID profile ${parsed.meta.selectedProfile + 1} selected)` : ""),
        settingsJson: parsed.settings,
        source: "snapshot",
        createdAt: Date.now(),
      });
      stored++;
    }
    console.log(`CLI dumps: ${stored} stored as flown-config profiles`);
  }
  (db as unknown as { $client?: { close(): void } }).$client?.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
