import { useQuery } from '@tanstack/react-query';
import { useOrdinizer, defaultFetcher } from '../providers/OrdinizerProvider';
import { apiPath } from '../lib/apiConfig';
import type { Entity } from '@civillyengaged/ordinizer-core';

export function useEntities(realmId?: string) {
  const { fetcher = defaultFetcher } = useOrdinizer();

  return useQuery<Entity[]>({
    queryKey: [apiPath(`realms/${realmId}/entities`)],
    queryFn: () => fetcher(apiPath(`realms/${realmId}/entities`)),
    enabled: !!realmId,
  });
}
