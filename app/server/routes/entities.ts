import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";
import { Entity } from "@civillyengaged/ordinizer-core";


export function registerEntityRoutes(app: Express, apiPrefix: string = "/api") {
  // Get entities for a specific realm
  app.get(`${apiPrefix}/realms/:realmId/entities`, async (req, res) => {
    try {
      const { realmId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      const entities = await storage.getEntities();
      if (!entities) {
        return res.status(404).json({ error: "Entities not found for this realm" });
      }
      res.json(entities);
    } catch (error) {
      console.error(`Error fetching entities for realm ${req.params.realmId}:`, error);
      res.status(500).json({ error: "Failed to fetch realm entities" });
    }
  });

  // Get a specific entity within a realm
  app.get(`${apiPrefix}/realms/:realmId/entities/:entityId`, async (req, res) => {
    try {
      const { realmId, entityId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      const entity = await storage.getEntity(entityId);
      if (!entity) {
        return res.status(404).json({ error: "Entity not found" });
      }
      res.json(entity);
    } catch (error) {
      console.error(`Error fetching entity ${req.params.entityId} for realm ${req.params.realmId}:`, error);
      res.status(500).json({ error: "Failed to fetch entity" });
    }
  });

  app.get(`${apiPrefix}/realms/:realmId/entities/:entityId/domains`, async (req, res) => {
    const { realmId, entityId } = req.params;
    try {
      const storage = getReadOnlyStorage(realmId);
      const entity = await storage.getEntity(entityId);
      if (!entity) {
        return res.status(404).json({ error: "Entity not found: ", entityId });
      }
      storage.getEntityDomains(entityId).then((domains) => {
        res.json(domains);
      }).catch((error) => {
        console.error(`Error fetching domains for entity ${entityId} in realm ${realmId}:`, error);
        res.status(500).json({ error: "Failed to fetch entity domains" });
      });
    } catch (error) {
      console.error(`Error fetching entity ${entityId} for realm ${realmId}:`, error);
      res.status(500).json({ error: "Failed to fetch entity" });
    }
  });
}
