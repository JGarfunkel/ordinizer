import { createContext, useContext, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export interface DataFetcher {
  <T = any>(url: string, options?: RequestInit): Promise<T>;
}

export interface OrdinizerConfig {
  baseUrl: string;
  fetcher: DataFetcher;
  queryClient?: QueryClient;
  theme?: {
    colorScale?: string[];
    cssVars?: Record<string, string>;
  };
}

interface OrdinizerContextValue extends OrdinizerConfig {
  queryClient: QueryClient;
}

const OrdinizerContext = createContext<OrdinizerContextValue | null>(null);

const defaultFetcher: DataFetcher = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
};

const defaultQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
    },
  },
});

export function OrdinizerProvider({
  children,
  baseUrl,
  fetcher = defaultFetcher,
  queryClient = defaultQueryClient,
  theme = {},
}: OrdinizerConfig & { children: ReactNode }) {
  const value: OrdinizerContextValue = {
    baseUrl,
    fetcher,
    queryClient,
    theme,
  };

  return (
    <OrdinizerContext.Provider value={value}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </OrdinizerContext.Provider>
  );
}

export function useOrdinizer(): OrdinizerContextValue {
  const context = useContext(OrdinizerContext);
  if (!context) {
    throw new Error('useOrdinizer must be used within OrdinizerProvider');
  }
  return context;
}
