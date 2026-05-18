import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";

// deprecated
export function registerDatasourceRoutes(app: Express, apiPrefix: string = "/api") {
  // Get available data sources


  // register a route to return the datasources for an entity
  app.get(`${apiPrefix}/realms/:realmId/entities/:entityId/datasources`, async (req, res) => {
    const { realmId, entityId } = req.params;
    try {
      const storage = getReadOnlyStorage(realmId);
      const entity = await storage.getEntity(entityId);
      if (!entity) {
        return res.status(404).json({ error: "Entity not found", entityId });
      }
      const datasources = await storage.getSourcesForEntity(entityId);
      res.json(datasources);
    } catch (error) {
      console.error(`Error fetching datasources for entity ${entityId} in realm ${realmId}:`, error);
      res.status(500).json({ error: "Failed to fetch entity datasources" });
    }
  });

    app.get(`${apiPrefix}/realms/:realmId/datasources`, async (req, res) => {
    const { realmId } = req.params;
    try {
      const storage = getReadOnlyStorage(realmId);
      const datasources = await storage.getSourceMap();
      if (!datasources) {
        return res.status(404).json({ error: "Datasources not found for this realm", realmId });
      }
      console.log("Fetched datasources for realm " + realmId + ": ", datasources.size);
      res.json(Object.fromEntries(datasources));
    } catch (error) {
      console.error(`Error fetching datasources for realm ${realmId}:`, error);
      res.status(500).json({ error: "Failed to fetch datasources" });
    }
  });




}

