import { useQuery } from '@tanstack/react-query';
import { useOrdinizer } from '../providers/OrdinizerProvider';

export interface Domain {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  [key: string]: any;
}

export function useDomainSummary(realmId?: string) {
  const { baseUrl, fetcher, apiPrefix } = useOrdinizer();

  return useQuery<Domain[]>({
    queryKey: [apiPrefix + '/realms', realmId, 'domains'],
    queryFn: () => fetcher(`${baseUrl}${apiPrefix}/realms/${realmId}/domains`),
    enabled: !!realmId,
  });
}
