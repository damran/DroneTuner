import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import type { AppContext } from "./context";
import componentsRoutes from "./routes/components";
import dronesRoutes from "./routes/drones";
import photosRoutes from "./routes/photos";
import profilesRoutes from "./routes/profiles";
import flightsRoutes from "./routes/flights";
import logsRoutes from "./routes/logs";
import snapshotsRoutes from "./routes/snapshots";
import detectRoutes from "./routes/detect";
import vendorPresetsRoutes from "./routes/vendorPresets";
import chatRoutes from "./routes/chat";
import abTestsRoutes from "./routes/abTests";

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: true });

  // Validation errors are client errors, not 500s.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      void reply.code(400).send({
        error: "Invalid request",
        issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return;
    }
    const e = err as { statusCode?: number; message?: string };
    app.log.error(err);
    void reply.code(e.statusCode ?? 500).send({ error: e.message ?? "Internal server error" });
  });

  app.register(cors, { origin: ctx.config.clientOrigin });
  app.register(multipart, { limits: { fileSize: 256 * 1024 * 1024, files: 20 } });
  app.register(fastifyStatic, {
    root: ctx.config.photosDir,
    prefix: "/api/files/photos/",
    decorateReply: false,
  });
  app.register(fastifyStatic, {
    root: ctx.config.logsDir,
    prefix: "/api/files/logs/",
    decorateReply: false,
  });

  app.get("/api/health", async () => ({ ok: true, name: "DroneTuner", time: Date.now() }));

  app.register(componentsRoutes, { ctx });
  app.register(dronesRoutes, { ctx });
  app.register(photosRoutes, { ctx });
  app.register(profilesRoutes, { ctx });
  app.register(flightsRoutes, { ctx });
  app.register(logsRoutes, { ctx });
  app.register(snapshotsRoutes, { ctx });
  app.register(detectRoutes, { ctx });
  app.register(vendorPresetsRoutes, { ctx });
  app.register(chatRoutes, { ctx });
  app.register(abTestsRoutes, { ctx });

  // Serve the built client (production / Docker) when a bundle is configured and exists.
  const clientDist = ctx.config.clientDist;
  if (clientDist && fs.existsSync(path.join(clientDist, "index.html"))) {
    app.register(fastifyStatic, {
      root: clientDist,
      prefix: "/",
      decorateReply: false,
    });
    // SPA fallback: client-side routes get index.html, unknown API routes get JSON 404.
    app.setNotFoundHandler((req, reply) => {
      const pathname = req.url.split("?", 1)[0] ?? req.url;
      const isApi = pathname === "/api" || pathname.startsWith("/api/");
      if ((req.method === "GET" || req.method === "HEAD") && !isApi) {
        void reply.type("text/html").send(fs.createReadStream(path.join(clientDist, "index.html")));
        return;
      }
      void reply.code(404).send({ error: "Not found" });
    });
  }

  return app;
}
