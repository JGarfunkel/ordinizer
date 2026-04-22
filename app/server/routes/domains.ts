import type { Express } from "express";
import { getDefaultStorage } from "../storage";

export function registerDomainRoutes(app: Express, apiPrefix: string = "/api") {
  // Get domains with questions for a specific realm
  app.get(`${apiPrefix}/realms/:realmId/domains/questions`, async (req, res) => {
    try {
      const { realmId } = req.params;
      const storage = getDefaultStorage(realmId);
      const realm = await storage.getRealm(realmId);
      if (!realm) {
        return res.status(404).json({ error: "Realm not found" });
      }
      const domains = await storage.getDomainsByRealm(realmId);
      const domainsWithQuestions = await Promise.all(
        domains.map(async (domain) => {
          try {
            const questions = await storage.getQuestionsByDomain(domain.id, realmId); // Validate domain and realm
            const totalWeight = questions.reduce((sum, q) => sum + (q.weight || 1), 0);
            return { id: domain.id, name: domain.name, displayName: domain.displayName || domain.name, questions, questionCount: questions.length, totalWeight };
          } catch {
            return { id: domain.id, name: domain.name, displayName: domain.displayName || domain.name, questions: [], questionCount: 0, totalWeight: 0 };
          }
        })
      );
      res.json(domainsWithQuestions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch realm domains with questions" });
    }
  });

  // get domain and questions for it
  app.get(`${apiPrefix}/realms/:realmId/domains/:domainId/questions`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      console.log(`[questions] realmId=${realmId} domainId=${domainId}`);
      const storage = getDefaultStorage(realmId);
      console.debug("Using storage with dataDir:", storage.getDataDir());
      const realmDomains = await storage.getDomainsByRealm(realmId);
      console.debug(`Found ${realmDomains.length} domains for realmId=${realmId}`);
      const domain = realmDomains.find((d) => d.id === domainId);
      if (!domain) {
        return res.status(404).json({ error: "Domain not found" });
      }
      const questions = await storage.getQuestionsByDomain(domainId, realmId);
      res.json({ ...domain, questions });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch domain questions" });
    }
  });

  // Get domains for a specific realm
  app.get(`${apiPrefix}/realms/:realmId/domains`, async (req, res) => {
    try {
      const { realmId } = req.params;
      const storage = getDefaultStorage(realmId);
      const domains = await storage.getDomains();
      const visibleDomains = domains.filter((domain) => domain.show !== false);
      res.json(visibleDomains);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch realm domains" });
    }
  });

  // // Get all domains (legacy endpoint)
  // app.get(`${apiPrefix}/domains`, async (_req, res) => {
  //   try {
  //     const storage = getDefaultStorage("");
  //     const domains = await storage.getDomains();
  //     const visibleDomains = domains.filter((domain) => domain.show !== false);
  //     res.json(visibleDomains);
  //   } catch (error) {
  //     res.status(500).json({ error: "Failed to fetch domains" });
  //   }
  // });
}
