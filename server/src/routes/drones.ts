import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Component, Drone, DroneDetail, DroneSummary, Profile } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { toLog } from "./logs";
import {
  components,
  droneComponents,
  dronePhotos,
  drones,
  flights,
  logs,
  profiles,
} from "../db/schema";

const createSchema = z.object({
  name: z.string().min(1),
  sizeClass: z.string().optional().default(""),
  notes: z.string().nullable().optional(),
  videoSystem: z.enum(["analog", "hd"]).nullable().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  sizeClass: z.string().optional(),
  notes: z.string().nullable().optional(),
  fcTarget: z.string().nullable().optional(),
  fcBoard: z.string().nullable().optional(),
  fcCraftName: z.string().nullable().optional(),
  fcUid: z.string().nullable().optional(),
  videoSystem: z.enum(["analog", "hd"]).nullable().optional(),
});

const addComponentSchema = z.object({
  componentId: z.number().int().positive(),
  slot: z.string().min(1),
});

function toDrone(row: typeof drones.$inferSelect): Drone {
  return {
    id: row.id,
    name: row.name,
    sizeClass: row.sizeClass,
    notes: row.notes,
    createdAt: row.createdAt,
    fcTarget: row.fcTarget,
    fcBoard: row.fcBoard,
    fcCraftName: row.fcCraftName,
    fcUid: row.fcUid,
    videoSystem: row.videoSystem,
  };
}

function toProfile(row: typeof profiles.$inferSelect): Profile {
  return {
    id: row.id,
    droneId: row.droneId,
    name: row.name,
    goal: row.goal,
    sizeClass: row.sizeClass,
    videoSystem: row.videoSystem,
    notes: row.notes,
    settings: (row.settingsJson ?? {}) as Profile["settings"],
    source: row.source as Profile["source"],
    createdAt: row.createdAt,
  };
}

function toComponent(row: typeof components.$inferSelect): Component {
  return {
    id: row.id,
    category: row.category as Component["category"],
    name: row.name,
    specs: (row.specsJson ?? {}) as Record<string, unknown>,
    notes: row.notes,
  };
}

export default async function dronesRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db } = opts.ctx;

  app.get("/api/drones", async () => {
    const rows = await db.select().from(drones).orderBy(desc(drones.createdAt));
    const summaries: DroneSummary[] = [];
    for (const drone of rows) {
      const [photos, links, lastFlight, activeProfile] = await Promise.all([
        db.select().from(dronePhotos).where(eq(dronePhotos.droneId, drone.id)),
        db.select().from(droneComponents).where(eq(droneComponents.droneId, drone.id)),
        db
          .select()
          .from(flights)
          .where(eq(flights.droneId, drone.id))
          .orderBy(desc(flights.date))
          .limit(1),
        db
          .select()
          .from(profiles)
          .where(eq(profiles.droneId, drone.id))
          .orderBy(desc(profiles.createdAt))
          .limit(1),
      ]);
      const primary = photos.find((p) => p.isPrimary) ?? photos[0];
      summaries.push({
        ...toDrone(drone),
        primaryPhotoPath: primary?.path ?? null,
        lastFlightDate: lastFlight[0]?.date ?? null,
        componentCount: links.length,
        activeProfileName: activeProfile[0]?.name ?? null,
      });
    }
    return summaries;
  });

  app.get("/api/drones/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const drone = await db.select().from(drones).where(eq(drones.id, id)).get();
    if (!drone) return reply.code(404).send({ error: "Drone not found" });

    const [links, photos, profileRows, flightRows, logRows] = await Promise.all([
      db.select().from(droneComponents).where(eq(droneComponents.droneId, id)),
      db.select().from(dronePhotos).where(eq(dronePhotos.droneId, id)),
      db.select().from(profiles).where(eq(profiles.droneId, id)).orderBy(desc(profiles.createdAt)),
      db.select().from(flights).where(eq(flights.droneId, id)).orderBy(desc(flights.date)),
      db
        .select()
        .from(logs)
        .where(eq(logs.droneId, id))
        .orderBy(desc(sql`coalesce(${logs.recordedAt}, ${logs.uploadedAt})`), desc(logs.sessionIndex), desc(logs.id)),
    ]);

    const detail: DroneDetail = {
      ...toDrone(drone),
      components: [],
      photos: photos.map((p) => ({ id: p.id, droneId: p.droneId, path: p.path, isPrimary: p.isPrimary })),
      profiles: profileRows.map(toProfile),
      flights: flightRows.map((f) => ({
        id: f.id,
        droneId: f.droneId,
        batteryComponentId: f.batteryComponentId,
        logId: f.logId,
        date: f.date,
        durationS: f.durationS,
        styleTag: f.styleTag,
      })),
      logs: logRows.map(toLog),
    };

    for (const link of links) {
      const comp = await db.select().from(components).where(eq(components.id, link.componentId)).get();
      if (comp) {
        detail.components.push({
          droneId: link.droneId,
          componentId: link.componentId,
          slot: link.slot,
          component: toComponent(comp),
        });
      }
    }

    return detail;
  });

  app.post("/api/drones", async (req) => {
    const body = createSchema.parse(req.body);
    const [row] = await db
      .insert(drones)
      .values({
        name: body.name,
        sizeClass: body.sizeClass,
        notes: body.notes ?? null,
        videoSystem: body.videoSystem ?? null,
        createdAt: Date.now(),
      })
      .returning();
    return toDrone(row!);
  });

  app.patch("/api/drones/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = updateSchema.parse(req.body);
    const existing = await db.select().from(drones).where(eq(drones.id, id)).get();
    if (!existing) return reply.code(404).send({ error: "Drone not found" });
    const [row] = await db
      .update(drones)
      .set({
        name: body.name ?? existing.name,
        sizeClass: body.sizeClass ?? existing.sizeClass,
        notes: body.notes !== undefined ? body.notes : existing.notes,
        fcTarget: body.fcTarget !== undefined ? body.fcTarget : existing.fcTarget,
        fcBoard: body.fcBoard !== undefined ? body.fcBoard : existing.fcBoard,
        fcCraftName: body.fcCraftName !== undefined ? body.fcCraftName : existing.fcCraftName,
        fcUid: body.fcUid !== undefined ? body.fcUid : existing.fcUid,
        videoSystem: body.videoSystem !== undefined ? body.videoSystem : existing.videoSystem,
      })
      .where(eq(drones.id, id))
      .returning();
    return toDrone(row!);
  });

  app.delete("/api/drones/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    await db.delete(drones).where(eq(drones.id, id));
    return reply.code(204).send();
  });

  app.post("/api/drones/:id/components", async (req, reply) => {
    const droneId = Number((req.params as { id: string }).id);
    const body = addComponentSchema.parse(req.body);
    const drone = await db.select().from(drones).where(eq(drones.id, droneId)).get();
    if (!drone) return reply.code(404).send({ error: "Drone not found" });
    const comp = await db.select().from(components).where(eq(components.id, body.componentId)).get();
    if (!comp) return reply.code(404).send({ error: "Component not found" });
    await db
      .insert(droneComponents)
      .values({ droneId, componentId: body.componentId, slot: body.slot })
      .onConflictDoUpdate({
        target: [droneComponents.droneId, droneComponents.slot],
        set: { componentId: body.componentId },
      });
    return { droneId, componentId: body.componentId, slot: body.slot };
  });

  app.delete("/api/drones/:id/components/:slot", async (req, reply) => {
    const droneId = Number((req.params as { id: string }).id);
    const slot = (req.params as { slot: string }).slot;
    await db
      .delete(droneComponents)
      .where(and(eq(droneComponents.droneId, droneId), eq(droneComponents.slot, slot)));
    return reply.code(204).send();
  });
}
