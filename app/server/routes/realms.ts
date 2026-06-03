import type { Express } from "express";
import { getReadOnlyStorage, getRealmsFromStorage, getRealmsConfigFromStorage } from "../storage";

export function registerRealmRoutes(app: Express, apiPrefix: string = "/api") {
  // Get all realms
  app.get(`${apiPrefix}/realms`, async (_req, res) => {
    try {
      const realms = await getRealmsFromStorage();
      res.json(realms);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch realms" });
    }
  });

  // Get realms config (layout options, etc.)
  app.get(`${apiPrefix}/realms-config`, async (_req, res) => {
    try {
      const config = await getRealmsConfigFromStorage();
      res.json({ layout: config.layout });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch realms config" });
    }
  });

  // Get a specific realm
  app.get(`${apiPrefix}/realms/:realmId`, async (req, res) => {
    try {
      const { realmId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      const realm = await storage.getRealm(realmId);
      if (!realm) {
        return res.status(404).json({ error: "Realm not found" });
      }
      res.json(realm);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch realm" });
    }
  });
}
