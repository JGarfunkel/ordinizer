import { useQuery } from '@tanstack/react-query';
import { useOrdinizer } from '../providers/OrdinizerProvider';
import type { Realm } from '@ordinizer/core';

export function useRealms() {
  const { baseUrl, fetcher, apiPrefix } = useOrdinizer();

  return useQuery<Realm[]>({
    queryKey: [apiPrefix + '/realms'],
    queryFn: () => fetcher(`${baseUrl}${apiPrefix}/realms`),
  });
}
