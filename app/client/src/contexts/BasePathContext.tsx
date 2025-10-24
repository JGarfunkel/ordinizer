import { createContext, useContext, ReactNode } from 'react';

interface BasePathContextType {
  basePath: string;
  buildPath: (path: string) => string;
}

const BasePathContext = createContext<BasePathContextType>({
  basePath: '',
  buildPath: (path: string) => path,
});

export function useBasePath() {
  return useContext(BasePathContext);
}

interface BasePathProviderProps {
  basePath: string;
  children: ReactNode;
}

export function BasePathProvider({ basePath, children }: BasePathProviderProps) {
  const buildPath = (path: string) => {
    if (!basePath) return path;
    
    // Ensure basePath doesn't have trailing slash
    const cleanBasePath = basePath.replace(/\/$/, '');
    
    // Ensure path starts with /
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    
    // Combine them
    return `${cleanBasePath}${cleanPath}`;
  };

  return (
    <BasePathContext.Provider value={{ basePath, buildPath }}>
      {children}
    </BasePathContext.Provider>
  );
}
