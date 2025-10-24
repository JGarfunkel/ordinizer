/**
 * Ordinizer Application Server Routes
 * Export function to register all ordinizer API routes with a prefix
 */
import type { Express } from "express";
import { registerRoutes } from "./routes.js";

export interface OrdinizerServerOptions {
  /**
   * API prefix for all ordinizer routes
   * e.g., "/api/ordinizer" means routes become /api/ordinizer/realms, etc.
   */
  apiPrefix?: string;
}

/**
 * Register all Ordinizer application routes with an Express app
 * @param app Express application instance
 * @param options Configuration options including API prefix
 */
export async function registerOrdinizerRoutes(
  app: Express,
  options: OrdinizerServerOptions = {}
) {
  const { apiPrefix = "" } = options;
  
  // Register all routes with the prefix
  // The registerRoutes function will handle the prefix internally
  return await registerRoutes(app, apiPrefix);
}

export { registerRoutes };
