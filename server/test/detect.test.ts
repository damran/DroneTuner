import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FcIdentity } from "@dronetuner/shared";
import { buildApp } from "../src/app";
import type { ServerConfig } from "../src/config";
import { createDb } from "../src/db";
import { detectDrones, scoreDroneIdentity } from "../src/services/detect";
import { buildBaseline, matchPresetForComponent } from "../src/services/baseline";

const IDENTITY: FcIdentity = {
  apiVersion: "1.46.0",
  fcVariant: "BTFL",
  fcVersion: "4.5.0",
  boardId: "S411",
  targetName: "BETAFPVF411",
  boardName: "BETAFPVF411",
  manufacturerId: "BEFH",
  craftName: "Meteor65",
  uid: "00112233445566778899aabb",
};

describe("detect service", () => {
  it("scores uid as a certain match", () => {
    const m = scoreDroneIdentity(
      { id: 1, name: "Whoop", fcUid: IDENTITY.uid, fcTarget: null, fcBoard: null, fcCraftName: null },
      IDENTITY,
    );
    expect(m?.score).toBe(100);
    expect(m?.matchedOn).toEqual(["uid"]);
  });

  it("combines weaker signals", () => {
    const m = scoreDroneIdentity(
      { id: 1, name: "Whoop", fcUid: null, fcTarget: "betafpvf411", fcBoard: null, fcCraftName: "meteor65" },
      IDENTITY,
    );
    expect(m?.score).toBe(80);
    expect(m?.matchedOn).toEqual(["craftName", "target"]);
  });

  it("returns null when nothing matches", () => {
    const m = scoreDroneIdentity(
      { id: 1, name: "Other", fcUid: "deadbeef", fcTarget: "MATEKF405", fcBoard: null, fcCraftName: "Five" },
      IDENTITY,
    );
    expect(m).toBeNull();
  });

  it("ranks best match first", () => {
    const matches = detectDrones(
      [
        { id: 1, name: "Weak", fcUid: null, fcTarget: "BETAFPVF411", fcBoard: null, fcCraftName: null },
        { id: 2, name: "Strong", fcUid: IDENTITY.uid, fcTarget: null, fcBoard: null, fcCraftName: null },
      ],
      IDENTITY,
    );
    expect(matches.map((m) => m.droneId)).toEqual([2, 1]);
  });
});

describe("baseline service", () => {
  const presets = [
    {
      id: 1,
      name: "Meteor65 stock",
      source: "upload" as const,
      boardTarget: null,
      componentId: null,
      droneModel: "Meteor65",
      settings: { pids: { roll: { p: 45 } }, filters: { gyroLowpassHz: 250 } },
      cliDump: null,
      sourceUrl: null,
      createdAt: 1,
      vendor: null,
      sizeClass: null,
      videoSystem: null,
      cells: null,
      bfVersion: null,
      kind: "factory" as const,
      variant: null,
      notes: null,
    },
    {
      id: 2,
      name: "0802 motors stock",
      source: "manual" as const,
      boardTarget: null,
      componentId: 20,
      droneModel: null,
      settings: { filters: { gyroLowpassHz: 300 } },
      cliDump: null,
      sourceUrl: null,
      createdAt: 2,
      vendor: null,
      sizeClass: null,
      videoSystem: null,
      cells: null,
      bfVersion: null,
      kind: "factory" as const,
      variant: null,
      notes: null,
    },
  ];

  it("prefers explicit component assignment over fuzzy model match", () => {
    expect(matchPresetForComponent({ id: 20, name: "Meteor65 0802 Motors" }, presets)?.id).toBe(2);
    expect(matchPresetForComponent({ id: 10, name: "Meteor65 Frame" }, presets)?.id).toBe(1);
    expect(matchPresetForComponent({ id: 30, name: "Random Prop" }, presets)).toBeNull();
  });

  it("merges per-component presets with provenance, later category wins", () => {
    const baseline = buildBaseline(
      [
        { slot: "frame", component: { id: 10, name: "Meteor65 Frame", category: "frame" } },
        { slot: "motors", component: { id: 20, name: "0802 Motors", category: "motor" } },
      ],
      presets,
    );
    // motor (category index 1) merges after frame (0) → its gyroLowpassHz wins
    expect(baseline.merged.pids?.roll?.p).toBe(45);
    expect(baseline.merged.filters?.gyroLowpassHz).toBe(300);
    expect(baseline.sources["pids.roll.p"]).toBe("Meteor65 stock");
    expect(baseline.sources["filters.gyroLowpassHz"]).toBe("0802 motors stock");
    expect(baseline.components[0]?.preset?.id).toBe(1);
    expect(baseline.components[1]?.preset?.id).toBe(2);
  });
});

describe("detect + vendor preset api", () => {
  let app: ReturnType<typeof buildApp>;
  let db: ReturnType<typeof createDb>;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dronetuner-detect-"));
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

  it("detects a drone by linked FC identity", async () => {
    const drone = await app.inject({
      method: "POST",
      url: "/api/drones",
      payload: { name: "My Whoop", sizeClass: "65mm" },
    });
    const droneId = drone.json().id;

    await app.inject({
      method: "PATCH",
      url: `/api/drones/${droneId}`,
      payload: { fcUid: IDENTITY.uid, fcTarget: IDENTITY.targetName, fcCraftName: IDENTITY.craftName },
    });

    const res = await app.inject({ method: "POST", url: "/api/detect", payload: { identity: IDENTITY } });
    expect(res.statusCode).toBe(200);
    const matches = res.json().matches;
    expect(matches[0].droneId).toBe(droneId);
    expect(matches[0].matchedOn).toContain("uid");
  });

  it("imports a CLI dump as a vendor preset", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vendor-presets/import",
      payload: {
        text: "# board_name BETAFPVF411\nset name = Meteor65\nset p_roll = 45\nset rc_rate = 1.10\n",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.preset.name).toBe("Meteor65");
    expect(body.preset.settings.pids.roll.p).toBe(45);
    expect(body.preset.settings.rates.rcRate).toBe(110);
    expect(body.preset.boardTarget).toBe("BETAFPVF411");
  });

  it("rejects text without recognizable settings", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/vendor-presets/import",
      payload: { text: "just some prose, no dump" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("builds a per-component baseline for a hybrid drone", async () => {
    const frame = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { category: "frame", name: "Meteor65 Frame", specs: {} },
    });
    const motor = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { category: "motor", name: "Otherbrand 0802", specs: {} },
    });

    await app.inject({
      method: "POST",
      url: "/api/vendor-presets",
      payload: { name: "Meteor65 stock", droneModel: "Meteor65", settings: { pids: { roll: { p: 45 } } } },
    });
    const motorPreset = await app.inject({
      method: "POST",
      url: "/api/vendor-presets",
      payload: {
        name: "Otherbrand motor tune",
        componentId: motor.json().id,
        settings: { filters: { gyroLowpassHz: 300 } },
      },
    });
    expect(motorPreset.statusCode).toBe(200);

    const drone = await app.inject({ method: "POST", url: "/api/drones", payload: { name: "Hybrid" } });
    const droneId = drone.json().id;
    await app.inject({
      method: "POST",
      url: `/api/drones/${droneId}/components`,
      payload: { componentId: frame.json().id, slot: "frame" },
    });
    await app.inject({
      method: "POST",
      url: `/api/drones/${droneId}/components`,
      payload: { componentId: motor.json().id, slot: "motors" },
    });

    const res = await app.inject({ method: "GET", url: `/api/drones/${droneId}/baseline` });
    expect(res.statusCode).toBe(200);
    const baseline = res.json();
    expect(baseline.components).toHaveLength(2);
    expect(baseline.merged.pids.roll.p).toBe(45);
    expect(baseline.merged.filters.gyroLowpassHz).toBe(300);
  });
});
