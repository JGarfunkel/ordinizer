/**
 * API Configuration for Ordinizer App
 * 
 * This module provides the API base path configuration.
 * When ordinizer is mounted at a sub-path (e.g., /ordinizer),
 * API calls need to be prefixed accordingly (e.g., /api/ordinizer)
 */

// API prefix - can be overridden via environment variable
export const API_PREFIX = import.meta.env.VITE_ORDINIZER_API_PREFIX || '/api/ordinizer';

/**
 * Creates an API path with the correct prefix
 * @param path - The API path (e.g., '/realms', '/domains')
 * @returns The full API path with prefix
 */
export function apiPath(path: string): string {
  // Remove leading slash from path if present to avoid double slashes
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
