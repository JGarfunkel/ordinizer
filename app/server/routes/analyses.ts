import type { Express } from "express";
import { getDefaultStorage, getReadOnlyStorage } from "../storage"
import { get } from "node:http";

export function registerAnalysisRoutes(app: Express, apiPrefix: string = "/api") {

  // Get available analysis versions (backups) for a municipality and domain
  app.get(`${apiPrefix}/analyses/:realmId/:municipalityId/:domainId/versions`, async (req, res) => {
    try {
      const { realmId, municipalityId, domainId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      storage.getAnalysisVersionsByEntityAndDomain(municipalityId, domainId)
        .then(versions => {
          res.json({ versions });
        });

    } catch (error) {
      res.status(500).json({ error: 'Failed to list analysis versions' });
    }
  });

  /**
   * Get the current analysis for a municipality and domain. This will return the latest analysis, which may be a draft or in-progress version. 
   * For listing available versions, use the /versions endpoint.
   * 
   * Earlier versions of this returned a super-object of { municipality, domain, statute, questions, alignmentSuggestions } - for unclear design reasons
   * 
   */
  app.get(`${apiPrefix}/analyses/:realmId/:municipalityId/:domainId`, async (req, res) => {
    try {
      const { realmId, municipalityId, domainId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      storage.getAnalysisByEntityAndDomain(municipalityId, domainId)
        .then(analysis => {
          if (!analysis) {
            return res.status(404).json({ error: 'Analysis not found' });
          }
          res.json({ analysis });
        });

    } catch (error) {
      res.status(500).json({ error: "Failed to fetch analysis" });
    }
  });
}

