import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { AppContext } from "../context";
import { dronePhotos, drones } from "../db/schema";

const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

export default async function photosRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { db, config } = opts.ctx;

  app.post("/api/drones/:id/photos", async (req, reply) => {
    const droneId = Number((req.params as { id: string }).id);
    const drone = await db.select().from(drones).where(eq(drones.id, droneId)).get();
    if (!drone) return reply.code(404).send({ error: "Drone not found" });

    const created: { id: number; droneId: number; path: string; isPrimary: boolean }[] = [];
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type !== "file") continue;
      const ext = path.extname(part.filename).toLowerCase();
      if (!PHOTO_EXTENSIONS.has(ext)) {
        return reply.code(400).send({ error: `Unsupported image type "${ext || "(none)"}"` });
      }
      const name = `${crypto.randomUUID()}${ext}`;
      const dest = path.join(config.photosDir, name);
      await pipeline(part.file, fs.createWriteStream(dest));
      if (part.file.truncated) {
        await fs.promises.unlink(dest).catch(() => {});
        return reply.code(413).send({ error: "Photo exceeds the upload size limit" });
      }
      const [row] = await db
        .insert(dronePhotos)
        .values({ droneId, path: name, isPrimary: false })
        .returning();
      created.push({ id: row!.id, droneId, path: name, isPrimary: false });
    }

    if (created.length > 0) {
      const existingPrimary = await db
        .select()
        .from(dronePhotos)
        .where(and(eq(dronePhotos.droneId, droneId), eq(dronePhotos.isPrimary, true)))
        .get();
      if (!existingPrimary) {
        await db.update(dronePhotos).set({ isPrimary: true }).where(eq(dronePhotos.id, created[0]!.id));
        created[0]!.isPrimary = true;
      }
    }

    return created;
  });

  app.delete("/api/photos/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const photo = await db.select().from(dronePhotos).where(eq(dronePhotos.id, id)).get();
    if (!photo) return reply.code(404).send({ error: "Photo not found" });
    await db.delete(dronePhotos).where(eq(dronePhotos.id, id));
    const filePath = path.join(config.photosDir, photo.path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return reply.code(204).send();
  });

  app.post("/api/photos/:id/primary", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const photo = await db.select().from(dronePhotos).where(eq(dronePhotos.id, id)).get();
    if (!photo) return reply.code(404).send({ error: "Photo not found" });
    await db.update(dronePhotos).set({ isPrimary: false }).where(eq(dronePhotos.droneId, photo.droneId));
    await db.update(dronePhotos).set({ isPrimary: true }).where(eq(dronePhotos.id, id));
    return { id, droneId: photo.droneId, path: photo.path, isPrimary: true };
  });
}
