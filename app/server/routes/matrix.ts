import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";
import { getOrdinizer } from "@ordinizer/servercore";

export function registerMatrixRoutes(app: Express, apiPrefix: string = "/api") {
  // Matrix view endpoint for domain analysis (realm-aware)
  app.get(`${apiPrefix}/domains/:realmId/:domainId/matrix`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      const summary = await storage.getDomainSummary(domainId, realmId);
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: 'Failed to load matrix data' });
    }
  });

   // Get consolidated domain data (scores + summary) for map efficiency
  app.get(`${apiPrefix}/domains/:realmId/:domainId/summary`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      const ordinizer = await getOrdinizer(realmId);
      const entityScores = await ordinizer.generateEntitiesSummary(domainId);
      res.json(entityScores);
    } catch (error) {
      console.error('Error fetching consolidated domain data:', error);
      res.status(500).json({ error: 'Failed to fetch domain data' });
    }
  });

}
