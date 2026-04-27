import type { Express } from "express";
import { getReadOnlyStorage } from "../storage"
import type { MetaAnalysis } from "@civillyengaged/ordinizer-core";

export function registerMetaAnalysisRoutes(app: Express, apiPrefix: string = "/api") {
  
  // Get meta-analysis for a domain
  app.get(`${apiPrefix}/domains/:realmId/:domainId/meta-analysis`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      storage.getMetaAnalysisByDomain(domainId).then((metaAnalysis: MetaAnalysis) => {
        if (!metaAnalysis) {
          return res.status(404).json({ error: 'Meta-analysis not found for this domain' });
        }
        res.json(metaAnalysis);
      });
    } catch (error) {
      console.error("Error fetching meta-analysis:", error);
      res.status(500).json({ error: 'Failed to fetch meta-analysis' });
    }
  });

}
