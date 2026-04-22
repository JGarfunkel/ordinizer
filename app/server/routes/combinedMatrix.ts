import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";

export function registerCombinedMatrixRoutes(app: Express, apiPrefix: string = "/api") {
  // Get combined matrix data for all domains and municipalities (realm-specific)
  app.get(`${apiPrefix}/realms/:realmId/combined-matrix`, async (req, res) => {
    try {
      const { realmId } = req.params;
      const storage = getReadOnlyStorage(realmId);

      const domains = await storage.getDomainsByRealm(realmId);
      const visibleDomains = domains.filter((d: any) => d.show !== false);
      const matrixData = await storage.getCombinedMatrixData(realmId);

      res.json({
        domains: visibleDomains.map((d: any) => ({
          id: d.id,
          displayName: d.displayName || d.name,
          description: d.description
        })),
        municipalities: matrixData
      });
    } catch (error) {
      console.error('Error generating combined matrix:', error);
      res.status(500).json({ error: 'Failed to generate combined matrix' });
    }
  });
}
