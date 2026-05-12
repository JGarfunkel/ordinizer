import type { Express } from "express";
import { registerRealmRoutes } from "./realms";
import { registerDomainRoutes } from "./domains";
import { registerEntityRoutes } from "./entities";
import { registerMatrixRoutes } from "./matrix";
import { registerAdminRoutes } from "./admin";
import { registerDatasourceRoutes } from "./datasources";
import { registerStatuteRoutes } from "./statutes";
import { registerScoreRoutes } from "./scores";
import { registerAnalysisRoutes } from "./analyses";
import { registerMapBoundariesRoutes } from "./mapBoundaries";
import { registerMetaAnalysisRoutes } from "./metaAnalysis";
import { registerCombinedMatrixRoutes } from "./combinedMatrix";

export function registerAllRoutes(app: Express, apiPrefix = "/api") {
  registerRealmRoutes(app, apiPrefix);
  registerDomainRoutes(app, apiPrefix);
  registerEntityRoutes(app, apiPrefix);
  registerMatrixRoutes(app, apiPrefix);
  registerAdminRoutes(app, apiPrefix);
  registerDatasourceRoutes(app, apiPrefix);
  registerStatuteRoutes(app, apiPrefix);
  registerScoreRoutes(app, apiPrefix);
  registerAnalysisRoutes(app, apiPrefix);
  // registerQuestionEntityRoutes(app, apiPrefix);
  registerMapBoundariesRoutes(app, apiPrefix);
  registerMetaAnalysisRoutes(app, apiPrefix);
  registerCombinedMatrixRoutes(app, apiPrefix);
  // registerJurisdictionRoutes(app, apiPrefix);
  // Do NOT register vector routes in main app unless desired
}
