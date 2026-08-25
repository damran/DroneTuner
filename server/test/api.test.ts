import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app";
import type { ServerConfig } from "../src/config";
import { createDb } from "../src/db";

let app: ReturnType<typeof buildApp>;
let db: ReturnType<typeof createDb>;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dronetuner-test-"));
  const config: ServerConfig = {
    port: 0,
    dataDir: tmpDir,
    photosDir: path.join(tmpDir, "photos"),
    logsDir: path.join(tmpDir, "logs"),
    dbPath: path.join(tmpDir, "test.db"),
    clientOrigin: "http://localhost:5173",
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
    const droneId = drone.json().id;

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
});
