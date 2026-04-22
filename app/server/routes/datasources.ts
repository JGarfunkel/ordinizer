import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";

// deprecated
export function registerDatasourceRoutes(app: Express, apiPrefix: string = "/api") {
  // Get available data sources

  app.get(`${apiPrefix}/datasources`, async (req, res) => {
    try {
      const storage = getReadOnlyStorage("");
      const datasources = await storage.getDataSources();
      if (!datasources) {
        return res.status(404).json({ error: 'Datasources configuration not found' });
      }
      res.json(datasources);
    } catch (error) {
      res.status(500).json({ error: 'Failed to load datasources' });
    }
  });

  // Generic source data endpoint
  app.get(`${apiPrefix}/sourcedata`, async (req, res) => {
    try {
      const { source } = req.query;
      if (!source || typeof source !== 'string') {
        return res.status(400).json({ error: 'Source parameter is required' });
      }
      const storage = getReadOnlyStorage("");
      const result = await storage.getSourceData(source);
      if (!result) {
        return res.status(404).json({ error: `Source '${source}' not found` });
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Failed to load source data' });
    }
  });
}
