import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionCardProposal } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { analyses, chatMessages, droneComponents, drones, logs, profiles } from "../db/schema";
import { chatStream, type ToolCallResult, type ToolDef } from "../services/ollama";
import { settingsSchema } from "./profiles";

const chatSchema = z.object({
  droneId: z.number().int().positive().nullable().optional(),
  messages: z.array(
    z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) }),
  ),
});

const METRIC_EXPLANATIONS: Record<string, string> = {
  noisePeaks:
    "Spectral peaks in the gyro trace, usually frame/prop resonances. A dynamic notch covering the peak frequency removes the noise with minimal latency.",
  dtermRms:
    "Root-mean-square of the D-term output per axis. High values mean the D-term is amplifying noise, which heats motors and causes propwash oscillation.",
  stepResponse:
    "How the gyro responds to a stick step: overshoot %, rise time, settling time. High overshoot = under-damped (too much P / too little D); slow rise = over-filtered or low P.",
  motorSaturationPercent:
    "Share of frames where a motor is at full output. Above a few percent the PID loop has no authority left — reduce D or P to free headroom.",
  vbatSagV:
    "Voltage drop between idle and full throttle. Large sag indicates a weak or low-C battery.",
  filterLatencyMs:
    "Rough estimate of the delay added by the filter chain, derived from step-response rise time. Lower is snappier but noisier.",
  rpmFilterActive:
    "Whether RPM filtering (bidirectional DSHOT) is active in this log. RPM filters track motor speed and notch out harmonics precisely.",
  throttleAvg: "Average throttle position across the flight (1000-2000 µs).",
};

export default async function chatRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db, config } = opts.ctx;

  app.get("/api/chat/messages", async (req) => {
    const { droneId } = req.query as { droneId?: string };
    const rows = droneId
      ? await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.droneId, Number(droneId)))
          .orderBy(desc(chatMessages.createdAt))
          .limit(200)
      : await db.select().from(chatMessages).orderBy(desc(chatMessages.createdAt)).limit(200);
    return rows
      .map((r) => ({
        id: r.id,
        droneId: r.droneId,
        role: r.role,
        content: r.content,
        toolCalls: r.toolCallsJson ?? null,
        createdAt: r.createdAt,
      }))
      .reverse();
  });

  app.post("/api/chat", async (req, reply) => {
    const body = chatSchema.parse(req.body);
    const droneId = body.droneId ?? null;

    const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      await db
        .insert(chatMessages)
        .values({ droneId, role: "user", content: lastUser.content, createdAt: Date.now() });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // hijack() bypasses Fastify's send path, so @fastify/cors headers must
      // be written manually or genuinely cross-origin clients get blocked.
      "Access-Control-Allow-Origin": config.clientOrigin,
    });
    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const tools: ToolDef[] = [
      {
        type: "function",
        function: {
          name: "get_fleet",
          description: "List all drones in the fleet.",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "get_drone",
          description: "Get details for one drone.",
          parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
        },
      },
      {
        type: "function",
        function: {
          name: "get_latest_analysis",
          description: "Get the latest blackbox analysis (metrics + findings) for a drone.",
          parameters: {
            type: "object",
            properties: { droneId: { type: "number" } },
            required: ["droneId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_profiles",
          description: "List tuning profiles (optionally for one drone).",
          parameters: {
            type: "object",
            properties: { droneId: { type: "number" } },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "propose_apply_profile",
          description: "Propose applying an existing profile to a drone (shown as a confirmable action card).",
          parameters: {
            type: "object",
            properties: { profileId: { type: "number" }, droneId: { type: "number" } },
            required: ["profileId", "droneId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "propose_pid_change",
          description:
            "Propose specific PID/filter/rate changes for a drone (shown as a confirmable action card). changes is an object with optional pids/filters/rates/advanced keys.",
          parameters: {
            type: "object",
            properties: {
              droneId: { type: "number" },
              rationale: { type: "string" },
              changes: { type: "object" },
            },
            required: ["droneId", "changes"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "explain_metric",
          description: "Explain a blackbox metric key in plain language.",
          parameters: {
            type: "object",
            properties: { metricKey: { type: "string" } },
            required: ["metricKey"],
          },
        },
      },
    ];

    const onToolCall = async (name: string, args: unknown): Promise<ToolCallResult> => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (name) {
        case "get_fleet": {
          const rows = await db.select().from(drones).orderBy(desc(drones.createdAt));
          return {
            result: JSON.stringify(rows.map((d) => ({ id: d.id, name: d.name, sizeClass: d.sizeClass }))),
          };
        }
        case "get_drone": {
          const id = Number(a.id);
          const d = await db.select().from(drones).where(eq(drones.id, id)).get();
          if (!d) return { result: "Drone not found" };
          const comps = await db.select().from(droneComponents).where(eq(droneComponents.droneId, id));
          return { result: JSON.stringify({ id: d.id, name: d.name, sizeClass: d.sizeClass, notes: d.notes, componentCount: comps.length }) };
        }
        case "get_latest_analysis": {
          const id = Number(a.droneId);
          const latestLog = await db
            .select()
            .from(logs)
            .where(eq(logs.droneId, id))
            .orderBy(desc(logs.uploadedAt))
            .limit(1);
          if (!latestLog[0]) return { result: "No logs for this drone yet." };
          const an = await db
            .select()
            .from(analyses)
            .where(eq(analyses.logId, latestLog[0].id))
            .orderBy(desc(analyses.createdAt))
            .limit(1);
          if (!an[0]) return { result: "No analysis for this drone's latest log yet." };
          return { result: JSON.stringify({ metrics: an[0].metricsJson, findings: an[0].findingsJson }) };
        }
        case "list_profiles": {
          const id = a.droneId !== undefined ? Number(a.droneId) : null;
          const rows = id
            ? await db.select().from(profiles).where(eq(profiles.droneId, id))
            : await db.select().from(profiles);
          return {
            result: JSON.stringify(
              rows.map((p) => ({ id: p.id, name: p.name, goal: p.goal, droneId: p.droneId, source: p.source })),
            ),
          };
        }
        case "propose_apply_profile": {
          const profileId = Number(a.profileId);
          const targetDroneId = Number(a.droneId);
          const p = await db.select().from(profiles).where(eq(profiles.id, profileId)).get();
          if (!p) return { result: "Profile not found" };
          const d = await db.select().from(drones).where(eq(drones.id, targetDroneId)).get();
          if (!d) return { result: "Drone not found" };
          const card: ActionCardProposal = {
            kind: "apply_profile",
            droneId: targetDroneId,
            profileId,
            profileName: p.name,
            title: `Apply profile "${p.name}"`,
            rationale: `Apply the ${p.goal} profile "${p.name}" to ${d.name}.`,
          };
          return { result: `Proposed applying profile "${p.name}" to ${d.name}.`, actionCard: card };
        }
        case "propose_pid_change": {
          const targetDroneId = Number(a.droneId);
          if (!Number.isFinite(targetDroneId)) return { result: "Invalid droneId" };
          const d = await db.select().from(drones).where(eq(drones.id, targetDroneId)).get();
          if (!d) return { result: "Drone not found" };
          // Proposals must be schema-validated before they become action cards.
          // settingsSchema strips unknown keys, so count actual leaf settings —
          // a proposal of only unmanaged keys must not become an empty card.
          const parsed = settingsSchema.safeParse(a.changes ?? {});
          const leafCount = parsed.success
            ? Object.values(parsed.data).reduce<number>((n, section) => {
                if (!section) return n;
                // pids nests per-axis objects; the other sections are flat key→number.
                return (
                  n +
                  Object.values(section as Record<string, unknown>).reduce<number>(
                    (m, v) => m + (typeof v === "object" && v !== null ? Object.keys(v).length : 1),
                    0,
                  )
                );
              }, 0)
            : 0;
          if (!parsed.success || leafCount === 0) {
            return { result: "Proposed changes were invalid; no action card was created." };
          }
          const card: ActionCardProposal = {
            kind: "pid_change",
            droneId: targetDroneId,
            title: "Proposed PID change",
            rationale: String(a.rationale ?? "Adjust settings based on the analysis."),
            settings: parsed.data,
          };
          return { result: "Proposed a PID change as an action card.", actionCard: card };
        }
        case "explain_metric": {
          const key = String(a.metricKey ?? "");
          return { result: METRIC_EXPLANATIONS[key] ?? `No explanation available for "${key}".` };
        }
        default:
          return { result: `Unknown tool ${name}` };
      }
    };

    let assistantText = "";
    const actionCards: ActionCardProposal[] = [];
    try {
      const system = await buildSystemPrompt(opts.ctx, droneId);
      const stream = chatStream({
        url: config.ollamaUrl,
        model: config.ollamaModel,
        messages: body.messages,
        system,
        tools,
        onToolCall,
      });
      for await (const ev of stream) {
        switch (ev.type) {
          case "token":
            assistantText += ev.text;
            send("token", { text: ev.text });
            break;
          case "action_card":
            actionCards.push(ev.card);
            send("action_card", { card: ev.card });
            break;
          case "done":
            send("done", {});
            break;
          case "error":
            send("error", { message: ev.message });
            break;
        }
      }
    } catch (err) {
      send("error", { message: String(err) });
    }

    if (assistantText || actionCards.length > 0) {
      await db.insert(chatMessages).values({
        droneId,
        role: "assistant",
        content: assistantText,
        toolCallsJson: actionCards.length > 0 ? actionCards : null,
        createdAt: Date.now(),
      });
    }
    reply.raw.end();
  });
}

async function buildSystemPrompt(ctx: AppContext, droneId: number | null): Promise<string> {
  const { db } = ctx;
  const parts = [
    "You are DroneTuner, a Betaflight PID tuning copilot for FPV drones. You help the pilot understand blackbox analysis and tune their quad.",
    "You NEVER apply changes yourself. To suggest a change, call propose_apply_profile or propose_pid_change so the pilot gets a confirmable action card.",
    "Be concise and concrete. Use the tools to look up fleet, drone, analysis and profile data before answering.",
  ];

  if (droneId !== null) {
    const drone = await db.select().from(drones).where(eq(drones.id, droneId)).get();
    if (drone) {
      parts.push(`Active drone: ${drone.name} (size class: ${drone.sizeClass || "unknown"}).`);
    }
    const latestLog = await db
      .select()
      .from(logs)
      .where(eq(logs.droneId, droneId))
      .orderBy(desc(logs.uploadedAt))
      .limit(1);
    if (latestLog[0]) {
      const an = await db
        .select()
        .from(analyses)
        .where(eq(analyses.logId, latestLog[0].id))
        .orderBy(desc(analyses.createdAt))
        .limit(1);
      if (an[0]) {
        parts.push(`Latest analysis findings: ${JSON.stringify(an[0].findingsJson)}`);
      }
    }
    const profs = await db.select().from(profiles).where(eq(profiles.droneId, droneId)).limit(10);
    if (profs.length > 0) {
      parts.push(`Available profiles: ${profs.map((p) => `${p.name} (${p.goal})`).join(", ")}.`);
    }
  }

  return parts.join("\n");
}
