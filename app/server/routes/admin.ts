import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";
import { Question } from "@civillyengaged/ordinizer-core";

export function registerAdminRoutes(app: Express, apiPrefix: string = "/api") {
  // NOTE: No current client consumer. The client uses /realms/:realmId/domains/questions instead.
  // This route duplicates that functionality under an /admin prefix.
  app.get(`${apiPrefix}/admin/:realmId/domains`, async (req, res) => {
    try {
      const { realmId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      const domains = await storage.getDomains();
      const domainsWithQuestions = [];
      for (const domain of domains) {
        let questions: Question[] = [];
        try {
          questions = await storage.getQuestionsByDomain(domain.id, realmId);
        } catch (error) {
          console.error(`Error reading questions for domain ${domain.id}:`, error);
        }
        domainsWithQuestions.push({
          ...domain,
          questions,
          questionCount: questions.length,
          totalWeight: questions.reduce((sum, q) => sum + (q.weight || 1), 0)
        });
      }
      res.json(domainsWithQuestions);
    } catch (error) {
      console.error('Error fetching admin domains data:', error);
      res.status(500).json({ error: 'Failed to fetch admin domains data' });
    }
  });
}

