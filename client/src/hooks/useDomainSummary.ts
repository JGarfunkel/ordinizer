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
  const { baseUrl, fetcher } = useOrdinizer();

  return useQuery<Domain[]>({
    queryKey: ['/api/realms', realmId, 'domains'],
    queryFn: () => fetcher(`${baseUrl}/api/realms/${realmId}/domains`),
    enabled: !!realmId,
  });
}
