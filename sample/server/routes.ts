import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerAllRoutes as registerOrdinizerRoutes } from "@civillyengaged/ordinizer-server";

export async function registerRoutes(app: Express): Promise<Server> {
  // Mount Ordinizer API routes at /api/ordinizer
  await registerOrdinizerRoutes(app, "/api/ordinizer");

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", apps: ["ordinizer"] });
  });

  // Add other app routes here

  const server = createServer(app);
  return server;
}
