import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app";
import type { ServerConfig } from "../src/config";
import { createDb } from "../src/db";
import { profiles, vendorPresets } from "../src/db/schema";
import { runSeed } from "../src/seed/seed";
import { buildLog } from "../../shared/test/helpers/synthetic-log";

let app: ReturnType<typeof buildApp>;
let db: ReturnType<typeof createDb>;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dronetuner-test-"));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: tmpDir,
    photosDir: path.join(tmpDir, "photos"),
    logsDir: path.join(tmpDir, "logs"),
    dbPath: path.join(tmpDir, "test.db"),
    clientOrigin: "http://localhost:5173",
    clientDist: path.join(tmpDir, "no-client-dist"),
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "llama3.1",
  };
  fs.mkdirSync(config.photosDir, { recursive: true });
  fs.mkdirSync(config.logsDir, { recursive: true });
  db = createDb(config);
  app = buildApp({ db, config });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  (db as unknown as { $client?: { close(): void } }).$client?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("api", () => {
  it("health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("components CRUD", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { category: "frame", name: "Test Frame", specs: { wheelbase_mm: 65 } },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json().id;

    const list = await app.inject({ method: "GET", url: "/api/components" });
    expect(list.json().length).toBeGreaterThan(0);

    const del = await app.inject({ method: "DELETE", url: `/api/components/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it("drone + profile + apply-plan diff", async () => {
    const drone = await app.inject({
      method: "POST",
      url: "/api/drones",
      payload: { name: "Test Whoop", sizeClass: "65mm" },
    });
    expect(drone.statusCode).toBe(200);

    const profile = await app.inject({
      method: "POST",
      url: "/api/profiles",
      payload: { name: "Test Profile", goal: "racing", sizeClass: "65mm", settings: { pids: { roll: { p: 50 } } } },
    });
    const profileId = profile.json().id;

    const plan = await app.inject({
      method: "POST",
      url: `/api/profiles/${profileId}/apply-plan`,
      payload: {
        current: {
          apiVersion: "1.46.0",
          fcVariant: "BTFL",
          fcVersion: "4.5.1",
          pids: {
            roll: { p: 46, i: 90, d: 40 },
            pitch: { p: 48, i: 90, d: 40 },
            yaw: { p: 80, i: 100, d: 0 },
          },
          filters: {},
          rates: {},
          advanced: {},
          featureMask: 0,
        },
      },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().diff.length).toBe(1);
    expect(plan.json().diff[0].label).toBe("Roll P");
    expect(plan.json().sections).toContain("pids");
  });

  it("profile settings strip unknown keys and reject out-of-range values", async () => {
    // Unknown keys are dropped (no phantom diff rows for the MSP write path)…
    const created = await app.inject({
      method: "POST",
      url: "/api/profiles",
      payload: {
        name: "Schema Probe",
        goal: "freestyle",
        settings: { filters: { dynNotchCount: 2, notARealKey: 42 }, rates: { rcRate: 100 } },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().settings.filters).toEqual({ dynNotchCount: 2 });

    // …and out-of-range values are rejected outright.
    const rejected = await app.inject({
      method: "POST",
      url: "/api/profiles",
      payload: { name: "Bad", goal: "freestyle", settings: { advanced: { tpaRate: 500 } } },
    });
    expect(rejected.statusCode).not.toBe(200);
  });

  it("snapshots only accept the four restorable MSP SET commands", async () => {
    const drone = await app.inject({
      method: "POST",
      url: "/api/drones",
      payload: { name: "Snap Whoop", sizeClass: "65mm" },
    });
    const droneId = drone.json().id;
    const dump = {
      apiVersion: "1.46.0",
      fcVariant: "BTFL",
      fcVersion: "4.5.1",
      capturedAt: Date.now(),
      decoded: { pids: {} },
    };
    // MSP_REBOOT (68) must never be replayable from a stored snapshot.
    const bad = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      payload: { droneId, dump: { ...dump, sections: [{ command: 68, payloadHex: "00" }] } },
    });
    expect(bad.statusCode).toBe(400);

    // MSP_SET_PID (202) with a valid hex payload is fine.
    const good = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      payload: { droneId, dump: { ...dump, sections: [{ command: 202, payloadHex: "2e5a28" }] } },
    });
    expect(good.statusCode).toBe(200);

    // Malformed hex is rejected too.
    const badHex = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      payload: { droneId, dump: { ...dump, sections: [{ command: 202, payloadHex: "zz" }] } },
    });
    expect(badHex.statusCode).toBe(400);
  });

  it("seed templates are read-only via PATCH (seed refreshes them in place)", async () => {
    const [tpl] = await db
      .insert(profiles)
      .values({
        name: "65mm 1S analog · Racing", // exact seed template name
        goal: "racing",
        sizeClass: "65mm",
        droneId: null,
        settingsJson: {},
        source: "template",
        createdAt: Date.now(),
      })
      .returning();
    const blocked = await app.inject({
      method: "PATCH",
      url: `/api/profiles/${tpl!.id}`,
      payload: { settings: { pids: { roll: { p: 99 } } } },
    });
    expect(blocked.statusCode).toBe(409);

    // A user copy (" (copy)" name) stays editable.
    const [copy] = await db
      .insert(profiles)
      .values({
        name: "65mm 1S analog · Racing (copy)",
        goal: "racing",
        sizeClass: "65mm",
        droneId: null,
        settingsJson: {},
        source: "template",
        createdAt: Date.now(),
      })
      .returning();
    const allowed = await app.inject({
      method: "PATCH",
      url: `/api/profiles/${copy!.id}`,
      payload: { settings: { pids: { roll: { p: 99 } } } },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("uploading a multi-session blackbox file creates one log per flight", async () => {
    const drone = await app.inject({ method: "POST", url: "/api/drones", payload: { name: "Multi Whoop", sizeClass: "65mm" } });
    const droneId = drone.json().id;

    // Two sessions back to back, like a flash download with two arms. The
    // synthetic frames span 1 ms, so both are "blips" and the longest is kept.
    const one = buildLog();
    const two = buildLog({ firmware: "Betaflight 4.5.1 (second)" });
    const data = Buffer.concat([Buffer.from(one), Buffer.from(two)]);
    const boundary = "----dronetuner-test";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="droneId"\r\n\r\n${droneId}\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="BTFL_BLACKBOX_LOG_TEST_20260518_125703_X.BBL"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/logs",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const result = res.json();
    expect(result.sessionCount).toBe(2);
    expect(result.logs.length).toBe(1); // both blips -> longest kept
    expect(result.skippedSessions).toBe(1);
    const log = result.logs[0];
    expect(log.sessionCount).toBe(2);
    expect(log.originalName).toBe("BTFL_BLACKBOX_LOG_TEST_20260518_125703_X.BBL");
    // Recorded time comes from the filename because the header has no clock.
    expect(new Date(log.recordedAt).getFullYear()).toBe(2026);

    const list = await app.inject({ method: "GET", url: `/api/logs?droneId=${droneId}` });
    expect(list.json().length).toBe(1);
    expect(list.json()[0].sessionIndex).toBe(log.sessionIndex);

    // Deleting the only row removes the shared file too.
    const del = await app.inject({ method: "DELETE", url: `/api/logs/${log.id}` });
    expect(del.statusCode).toBe(204);
  });

  it("stores and lists A/B tests per drone and refuses identical slots", async () => {
    const drone = await app.inject({ method: "POST", url: "/api/drones", payload: { name: "AB Whoop", sizeClass: "65mm" } });
    const droneId = drone.json().id as number;
    const variants = [
      { side: "A", label: "A · Crisp", slot: 0, settings: { filters: { dtermLowpass2Hz: 150 } } },
      { side: "B", label: "B · Smooth", slot: 1, settings: { filters: { dtermLowpass2Hz: 96 } } },
    ];
    const created = await app.inject({ method: "POST", url: "/api/ab-tests", payload: { droneId, kind: "pid", variants } });
    expect(created.statusCode).toBe(200);
    expect(created.json().variants[1].label).toBe("B · Smooth");
    const same = await app.inject({
      method: "POST",
      url: "/api/ab-tests",
      payload: { droneId, kind: "rate", variants: [variants[0], { ...variants[1], slot: 0 }] },
    });
    expect(same.statusCode).toBe(400);
    const list = await app.inject({ method: "GET", url: `/api/ab-tests?droneId=${droneId}` });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].kind).toBe("pid");
    const del = await app.inject({ method: "DELETE", url: `/api/ab-tests/${created.json().id}` });
    expect(del.statusCode).toBe(204);
  });

  it("seeds the vendor catalogue idempotently with parsed settings and source URLs", async () => {
    const first = await runSeed(db);
    expect(first.vendorInserted).toBeGreaterThan(50);
    expect(first.vendorSkipped).toEqual([]);
    const second = await runSeed(db);
    expect(second.vendorInserted, JSON.stringify({ first, second })).toBe(0);
    expect(second.vendorUpdated, JSON.stringify({ first, second })).toBe(first.vendorInserted);

    const rows = await db.select().from(vendorPresets);
    expect(rows.every((r) => r.source === "seed" && r.sourceUrl && r.cliDump)).toBe(true);

    // A resolved community preset: AOS 65mm filters (Chris Rosser).
    const aos = rows.find((r) => r.name.startsWith("AOS 65mm filters"));
    expect(aos?.kind).toBe("preset");
    const aosSettings = aos!.settingsJson as { filters?: Record<string, number> };
    expect(aosSettings.filters?.dynNotchCount).toBe(1);
    expect(aosSettings.filters?.dynNotchMinHz).toBe(150);
    expect(aosSettings.filters?.gyroLowpass2Hz).toBe(1000);

    // A factory dump: the Air65 R keeps its class metadata and PIDs.
    const air65 = rows.find((r) => r.name.startsWith("BetaFPV Air65 Racing"));
    expect(air65?.sizeClass).toBe("65mm");
    expect(air65?.videoSystem).toBe("analog");
    const air65Settings = air65!.settingsJson as { pids?: { pitch?: { p?: number } } };
    expect(air65Settings.pids?.pitch?.p).toBe(71);

    const list = await app.inject({ method: "GET", url: "/api/vendor-presets?sizeClass=65mm&kind=factory" });
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBeGreaterThan(5);
    expect(list.json().every((p: { sizeClass: string }) => p.sizeClass === "65mm")).toBe(true);
    expect(list.json()[0].cliDump).toBe(""); // list responses omit the raw text
  });
});
