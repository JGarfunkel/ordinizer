import { useQuery } from '@tanstack/react-query';
import { useOrdinizer } from '../providers/OrdinizerProvider';
import type { RealmConfig } from 'ordinizer';

export function useRealms() {
  const { baseUrl, fetcher } = useOrdinizer();

  return useQuery<RealmConfig[]>({
    queryKey: ['/api/realms'],
    queryFn: () => fetcher(`${baseUrl}/api/realms`),
  });
}
