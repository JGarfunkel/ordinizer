import { useQuery } from '@tanstack/react-query';
import { apiPath } from '../lib/apiConfig';
import type { Entity } from '@civillyengaged/ordinizer-core';

/**
 * Fetch and cache entities (municipalities, school districts, etc.) for a realm.
 * React Query deduplicates requests across components that share the same realmId,
 * so multiple components can call this without triggering duplicate network requests.
 */
export function useRealmEntities(realmId: string) {
  return useQuery<Entity[]>({
    queryKey: [apiPath(`realms/${realmId}/entities`)],
    enabled: !!realmId,
    staleTime: 1000 * 60 * 60, // 1 hour
  });
}
