import type { Express } from "express";
import fs from "fs-extra";
import path from "path";
import { getReadOnlyStorage } from "../storage";
import { getOrdinizer } from "@civillyengaged/ordinizer-servercore";
import { MatrixData, DomainDataFile } from "@civillyengaged/ordinizer-core";

export function registerMatrixRoutes(app: Express, apiPrefix: string = "/api") {
  // Matrix view endpoint for domain analysis (realm-aware)
  app.get(`${apiPrefix}/domains/:realmId/:domainId/matrix`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      const ordinizer = await getOrdinizer(realmId);
      const domain = await storage.getDomain(domainId);
      if (!domain) {
        return res.status(404).json({ error: 'Domain not found' });
      }
      const entities = await storage.getEntities();
      const entityMatrixRecords = await ordinizer.getDomainMatrixData(domainId);
      res.json(entityMatrixRecords);
      
    } catch (error) {
      res.status(500).json({ error: 'Failed to load matrix data' });
    }
  });

   // Get consolidated domain data (scores + summary) for map efficiency.
   // For data-type domains (those with data.json), returns availability rows derived from data.json.
  app.get(`${apiPrefix}/domains/:realmId/:domainId/summary`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;

      // Check if this is a data-type domain (has data.json instead of analysis)
      const storage = getReadOnlyStorage(realmId);
      const dataPath = path.join(storage.getRealmDir(), domainId, "data.json");
      if (await fs.pathExists(dataPath)) {
        const dataFile: DomainDataFile = await fs.readJson(dataPath);
        const summaryRows = dataFile.rows.map(row => ({
          entityId: row.entityId,
          available: true,
          hasData: true,
        }));
        return res.json(summaryRows);
      }

      const ordinizer = await getOrdinizer(realmId);
      const entityScores = await ordinizer.generateEntitiesSummary(domainId);
      res.json(entityScores);
    } catch (error) {
      console.error('Error fetching consolidated domain data:', error);
      res.status(500).json({ error: 'Failed to fetch domain data' });
    }
  });

}
