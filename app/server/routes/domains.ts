import type { Express } from "express";
import fs from "fs-extra";
import path from "path";
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
      const domains = await storage.getDomains();
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
      const domain = await storage.getDomain(domainId);
      if (!domain) {
        return res.status(404).json({ error: "Domain not found" });
      }
      const questions = await storage.getQuestionsByDomain(domainId, realmId);
      res.json({ ...domain, questions });
    } catch (error) {
      console.log(`Error fetching questions for domain ${req.params.domainId} in realm ${req.params.realmId}:`, error);
      res.status(500).json({ error: "Failed to fetch domain questions" });
    }
  });

  // Serve data.json for a data-type domain, merged with scoring config from data-config.json
  app.get(`${apiPrefix}/realms/:realmId/domains/:domainId/data`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      const storage = getDefaultStorage(realmId);
      const dataPath = path.join(storage.getRealmDir(), domainId, "data.json");
      if (!(await fs.pathExists(dataPath))) {
        return res.status(404).json({ error: "data.json not found for this domain" });
      }
      const data = await fs.readJson(dataPath);

      const configPath = path.join(storage.getRealmDir(), domainId, "data-config.json");
      if (await fs.pathExists(configPath)) {
        const config = await fs.readJson(configPath);
        if (config.scoring) {
          data.scoring = config.scoring;
        }
      }

      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Failed to read domain data" });
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
