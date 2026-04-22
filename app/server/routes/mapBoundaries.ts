import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";

export function registerMapBoundariesRoutes(app: Express, apiPrefix: string = "/api") {
  // Get map boundaries for a specific realm
  app.get(`${apiPrefix}/map-boundaries`, async (req, res) => {
    try {
      const { realm: realmId } = req.query;
      if (!realmId || typeof realmId !== 'string') {
        return res.status(400).json({ error: 'Realm parameter is required' });
      }

      const storage = getReadOnlyStorage(realmId);
      storage.getBoundariesForRealm(realmId).then((boundaries) => {
        if (!boundaries) {
          return res.status(404).json({ error: `Boundary data not found for realm: ${realmId}` });
        }
        res.json(boundaries);
      }).catch((error) => {
        console.error(`Error loading boundary data for realm ${realmId}:`, error);
        res.status(500).json({ error: 'Failed to load boundary data' });
      });

    } catch (error) {
      console.error('Error processing map boundaries request:', error);
      res.status(500).json({ error: 'Failed to load boundary data' });
    }
  });
}

