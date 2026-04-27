import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";

export function registerStatuteRoutes(app: Express, apiPrefix: string = "/api") {
  // Serve statute files
  app.get(`${apiPrefix}/statute/:domainId/:entityId`, async (req, res) => {
    try {
      const { domainId, entityId } = req.params;
      const { realm: realmId } = req.query;
      const targetRealmId = typeof realmId === 'string' ? realmId : '';
      const storage = getReadOnlyStorage(targetRealmId);
      const content = await storage.getDocumentText(domainId, entityId, targetRealmId);
      if (!content) {
        return res.status(404).json({ error: 'Statute file not found' });
      }
      res.setHeader('Content-Type', 'text/plain');
      res.send(content);
    } catch (error) {
      res.status(500).json({ error: 'Failed to serve statute file' });
    }
  });

  // Get statute metadata including source URL
  app.get(`${apiPrefix}/statute-metadata/:domainId/:entityId`, async (req, res) => {
    try {
      const { domainId, entityId } = req.params;
      const { realm: realmId } = req.query;
      const targetRealmId = typeof realmId === 'string' ? realmId : '';
      const storage = getReadOnlyStorage(targetRealmId);
      const ruleset = await storage.getRuleset(domainId, entityId);
      if (!ruleset) {
        return res.status(404).json({ error: 'Statute metadata not found' });
      }
      res.json(ruleset);
    } catch (error) {
      res.status(500).json({ error: 'Failed to serve statute metadata' });
    }
  });

  // Get section-specific URL for a statute section
  app.get(`${apiPrefix}/section-url/:domainId/:entityId/:sectionNumber`, async (req, res) => {
    try {
      const { domainId, entityId, sectionNumber } = req.params;
      const { realm: realmId } = req.query;
      const targetRealmId = typeof realmId === 'string' ? realmId : '';
      const storage = getReadOnlyStorage(targetRealmId);

      const sectionIndex = await storage.getSectionIndex();
      const matches = sectionIndex.filter(
        e => e.entityId === entityId && e.domain === domainId && e.sectionNumber === sectionNumber
      );

      if (matches.length > 0) {
        const selectedMatch = matches.length > 1 ? matches[1] : matches[0];
        return res.json(selectedMatch);
      }

      // Fallback: return sourceUrl from ruleset metadata
      const ruleset = await storage.getRuleset(domainId, entityId);
      if (ruleset) {
        const sourceUrl = (ruleset as any).sourceUrl || `/api/statute/${domainId}/${entityId}`;
        return res.json({
          entityId,
          domain: domainId,
          sourceUrl,
          sectionNumber,
          anchorId: null,
          sectionUrl: sourceUrl
        });
      }

      res.status(404).json({ error: 'Section not found' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to find section URL' });
    }
  });
}
