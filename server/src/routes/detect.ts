import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DetectResponse, FcIdentity } from "@dronetuner/shared";
import type { AppContext } from "../context";
import { drones } from "../db/schema";
import { detectDrones } from "../services/detect";

const identitySchema = z.object({
  apiVersion: z.string(),
  fcVariant: z.string(),
  fcVersion: z.string(),
  boardId: z.string().nullable(),
  targetName: z.string().nullable(),
  boardName: z.string().nullable(),
  manufacturerId: z.string().nullable(),
  craftName: z.string().nullable(),
  uid: z.string().nullable(),
});

export default async function detectRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db } = opts.ctx;

  // Match a connected FC identity against drones already in the fleet.
  app.post("/api/detect", async (req): Promise<DetectResponse> => {
    const { identity } = z.object({ identity: identitySchema }).parse(req.body);
    const rows = await db
      .select({
        id: drones.id,
        name: drones.name,
        fcTarget: drones.fcTarget,
        fcBoard: drones.fcBoard,
        fcCraftName: drones.fcCraftName,
        fcUid: drones.fcUid,
      })
      .from(drones);
    return { matches: detectDrones(rows, identity as FcIdentity) };
  });
}
