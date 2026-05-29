import { Switch, Route } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster, TooltipProvider, OrdinizerApp } from "@civillyengaged/ordinizer-client";
import { queryClient } from "./lib/queryClient";
import { ORDINIZER_CONTEXT_PATH } from "./config";

function Router() {
  const pathname = window.location.pathname;

  if (pathname.startsWith(ORDINIZER_CONTEXT_PATH)) {
    return <OrdinizerApp basePath={ORDINIZER_CONTEXT_PATH} />;
  }

  if (pathname === "" || pathname === "/") {
    window.location.href = ORDINIZER_CONTEXT_PATH;
    return null;
  }

  return (
    <Switch>
      <Route>
        {() => (
          <div className="min-h-screen flex items-center justify-center">
            <div className="text-center">
              <h1 className="text-6xl font-bold text-gray-300 mb-4">404</h1>
              <p className="text-xl text-gray-600 mb-8">Page not found</p>
              <a href="/" className="text-blue-600 hover:text-blue-700 underline">
                Return home
              </a>
            </div>
          </div>
        )}
      </Route>
    </Switch>
  );
}

function Footer() {
  return (
    <footer className="bg-white border-t border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div className="flex flex-col md:flex-row items-center justify-between">
          <span className="text-sm text-gray-500">
            {{displayName}} &copy; {new Date().getFullYear()} Civilly Engaged
          </span>
          <div className="flex items-center space-x-6 text-sm text-gray-500">
            <a
              className="hover:text-gray-900 transition-colors"
            >
              Contact
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <div className="flex flex-col min-h-screen">
          <div className="flex-1">
            <Router />
          </div>
          <Footer />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
