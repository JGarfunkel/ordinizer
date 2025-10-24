/**
 * Ordinizer Application Router
 * Complete municipal statute analysis application
 */
import { Router, Switch, Route } from "wouter";
import Home from "./pages/home";
import WestchesterDataPage from "./pages/westchester-data";
import FAQ from "./pages/faq";
import Matrix from "./pages/matrix";
import AdminDomains from "./pages/admin-domains";
import CombinedMatrix from "./pages/combined-matrix";
import NotFound from "./pages/not-found";
import { BasePathProvider } from "./contexts/BasePathContext";

interface OrdinizerAppProps {
  /**
   * Base path where the ordinizer app is mounted
   * e.g., "/ordinizer" or ""
   */
  basePath?: string;
}

export function OrdinizerApp({ basePath = "" }: OrdinizerAppProps) {
  // Wouter doesn't automatically strip parent paths in nested routing
  // Routes must include the full path including basePath
  const prefix = basePath || "";
  
  return (
    <BasePathProvider basePath={basePath}>
      <Switch>
        {/* Most specific routes first - realm-based routes */}
        <Route path={`${prefix}/realm/:realmid/:domain/matrix`} component={Matrix} />
        <Route path={`${prefix}/realm/:realmid/:domain/:municipality`} component={Home} />
        <Route path={`${prefix}/realm/:realmid/:domain`} component={Home} />
        <Route path={`${prefix}/realm/:realmid/matrix`} component={CombinedMatrix} />
        <Route path={`${prefix}/realm/:realmid`} component={Home} />
        
        {/* Admin and utility routes */}
        <Route path={`${prefix}/questions/:realmid/domains`} component={AdminDomains} />
        <Route path={`${prefix}/combined-matrix`} component={CombinedMatrix} />
        <Route path={`${prefix}/faq`} component={FAQ} />
        <Route path={`${prefix}/data/sourcedata`} component={WestchesterDataPage} />
        
        {/* Legacy routes for backward compatibility - less specific, so they come last */}
        <Route path={`${prefix}/:domain/:municipality`} component={Home} />
        <Route path={`${prefix}/:domain`} component={Home} />
        
        {/* Root path - show home component */}
        <Route path={prefix || "/"} component={Home} />
        <Route component={NotFound} />
      </Switch>
    </BasePathProvider>
  );
}

export default OrdinizerApp;
