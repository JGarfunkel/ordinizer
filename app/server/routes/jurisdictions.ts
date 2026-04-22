import type { Express } from "express";

export function registerJurisdictionRoutes(app: Express, apiPrefix: string = "/api") {
  // TODO: stub — always returns []. Client (home.tsx) calls this expecting EntityDomain[].
  // Implement when per-jurisdiction domain availability is needed.
  app.get(`${apiPrefix}/realms/:realmId/jurisdictions/:jurisdictionId/domains`, async (req, res) => {
    res.json([]);
  });
}
