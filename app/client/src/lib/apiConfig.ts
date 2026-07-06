declare const __ORDINIZER_CONTEXT_PATH__: string;

const contextPath = __ORDINIZER_CONTEXT_PATH__;

export const API_PREFIX = `/api${contextPath}`;
console.log(`API_PREFIX set to: ${API_PREFIX}`);

/**
 * Creates an API path with the correct prefix
 * @param path - The API path (e.g., '/realms', '/domains')
 * @returns The full API path with prefix
 */
export function apiPath(path: string): string {
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return `${API_PREFIX}/${cleanPath}`;
}

/**
 * Creates an API query key for use with react-query
 * @param segments - Path segments that will be joined (e.g., ['realms', realmId])
 * @returns Array suitable for use as queryKey
 */
export function apiQueryKey(...segments: (string | number)[]): string[] {
  const path = segments.join('/');
  return [apiPath(path)];
}
