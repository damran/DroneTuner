// DroneTuner e2e API smoke script. The server must be running (pnpm dev:server).
// Usage: pnpm smoke
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3001";

async function req(method, path, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok - ${msg}`);
}

const CURRENT_CONFIG = {
  apiVersion: "1.46.0",
  fcVariant: "BTFL",
  fcVersion: "4.5.1",
  pids: {
    roll: { p: 46, i: 90, d: 40 },
    pitch: { p: 48, i: 90, d: 40 },
    yaw: { p: 80, i: 100, d: 0 },
  },
  filters: { gyroLowpassDynMinHz: 250, dtermLowpassHz: 100 },
  rates: { rcRate: 100, rollRate: 70 },
  advanced: { feedforwardRoll: 120 },
  featureMask: 0,
};

async function main() {
  console.log("DroneTuner smoke test");

  console.log("health");
  const h = await req("GET", "/api/health");
  assert(h.status === 200 && h.json?.ok === true, "health check");

  console.log("fleet CRUD");
  const drone = await req("POST", "/api/drones", { name: "Smoke Whoop", sizeClass: "65mm" });
  assert(drone.status === 200, "create drone");
  const droneId = drone.json.id;
  const list = await req("GET", "/api/drones");
  assert(list.json.some((d) => d.id === droneId), "drone listed in fleet");

  console.log("component library (seeded)");
  const comps = await req("GET", "/api/components?category=battery");
  assert(comps.status === 200 && comps.json.length > 0, "battery components present");

  console.log("template library (seeded)");
  const tpl = await req("GET", "/api/profiles?templates=1");
  assert(tpl.status === 200 && tpl.json.length > 0, "templates present");

  console.log("apply-plan (diff engine)");
  const plan = await req("POST", `/api/profiles/${tpl.json[0].id}/apply-plan`, {
    current: CURRENT_CONFIG,
  });
  assert(plan.status === 200 && plan.json.diff.length > 0, "apply-plan produced a diff");

  console.log("auto-detect (FC identity matching)");
  await req("PATCH", `/api/drones/${droneId}`, {
    fcUid: "00112233445566778899aabb",
    fcTarget: "BETAFPVF411",
    fcCraftName: "SmokeWhoop",
  });
  const detect = await req("POST", "/api/detect", {
    identity: {
      apiVersion: "1.46.0",
      fcVariant: "BTFL",
      fcVersion: "4.5.1",
      boardId: "S411",
      targetName: "BETAFPVF411",
      boardName: "BETAFPVF411",
      manufacturerId: "BEFH",
      craftName: "SmokeWhoop",
      uid: "00112233445566778899aabb",
    },
  });
  assert(
    detect.status === 200 && detect.json.matches[0]?.droneId === droneId,
    "connected FC matched to fleet drone",
  );

  console.log("vendor presets (CLI dump import + hybrid baseline)");
  const imp = await req("POST", "/api/vendor-presets/import", {
    text: "# board_name BETAFPVF411\nset name = SmokeWhoop\nset p_roll = 45\nset rc_rate = 1.10\n",
  });
  assert(imp.status === 200 && imp.json.preset.settings.pids.roll.p === 45, "CLI dump imported");
  const frame = await req("POST", "/api/components", {
    category: "frame",
    name: "SmokeWhoop Frame",
    specs: {},
  });
  await req("POST", `/api/drones/${droneId}/components`, { componentId: frame.json.id, slot: "frame" });
  const baseline = await req("GET", `/api/drones/${droneId}/baseline`);
  assert(
    baseline.status === 200 && baseline.json.merged.pids?.roll?.p === 45,
    "baseline merged from component preset",
  );

  console.log("chatbot SSE endpoint (tolerant — Ollama may be offline)");
  const chat = await req(
    "POST",
    "/api/chat",
    { droneId, messages: [{ role: "user", content: "Hello" }] },
    20000,
  );
  assert(chat.status === 200, "chat endpoint responds");

  console.log("cleanup");
  await req("DELETE", `/api/vendor-presets/${imp.json.preset.id}`);
  await req("DELETE", `/api/components/${frame.json.id}`);
  const del = await req("DELETE", `/api/drones/${droneId}`);
  assert(del.status === 204, "drone deleted");

  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
