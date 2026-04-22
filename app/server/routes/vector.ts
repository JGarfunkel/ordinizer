import { vectorService } from "../../analyzer/services/vectorService.js";
import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";

// Vector database endpoints (not registered in main app)
export function registerVectorRoutes(app: Express, apiPrefix: string = "/api") {
  // Index a statute in the vector database
  app.post(`${apiPrefix}/vector/index/:municipalityId/:domainId`, async (req, res) => {
    try {
      const { municipalityId, domainId } = req.params;
      const { realm: realmId } = req.body;
      const targetRealmId = typeof realmId === 'string' ? realmId : '';
      const storage = getReadOnlyStorage(targetRealmId);
      const statuteContent = await storage.getDocumentText(domainId, municipalityId, targetRealmId);
      if (!statuteContent) {
        return res.status(404).json({ error: "Statute file not found" });
      }
      await vectorService.indexStatute(municipalityId, domainId, statuteContent);
      res.json({ 
        message: "Statute indexed successfully", 
        municipalityId, 
        domainId,
        contentLength: statuteContent.length
      });
    } catch (error) {
      console.error('Error indexing statute:', error);
      res.status(500).json({ error: "Failed to index statute" });
    }
  });

  // Search vector database for relevant sections
  app.post(`${apiPrefix}/vector/search/:municipalityId/:domainId`, async (req, res) => {
    try {
      const { municipalityId, domainId } = req.params;
      const { question, topK = 5 } = req.body;
      if (!question) {
        return res.status(400).json({ error: "Question is required" });
      }
      const results = await vectorService.searchRelevantSections(
        municipalityId, 
        domainId, 
        question, 
        Math.min(topK, 10)
      );
      res.json(results);
    } catch (error) {
      console.error('Error searching vector database:', error);
      res.status(500).json({ error: "Failed to search vector database" });
    }
  });

  // Get vector database statistics
  app.get(`${apiPrefix}/vector/stats`, async (req, res) => {
    try {
      const stats = await vectorService.getIndexStats();
      res.json(stats);
    } catch (error) {
      console.error('Error getting vector database stats:', error);
      res.status(500).json({ error: "Failed to get vector database stats" });
    }
  });
}
