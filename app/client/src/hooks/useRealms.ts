import { useQuery } from '@tanstack/react-query';
import { defaultFetcher, useOrdinizer } from '../providers/OrdinizerProvider';
import { apiPath } from '../lib/apiConfig';
import type { Realm } from '@civillyengaged/ordinizer-core';

export function useRealms() {
  const { fetcher = defaultFetcher } = useOrdinizer();

  return useQuery<Realm[]>({
    queryKey: [apiPath('realms')],
    queryFn: () => fetcher(apiPath('realms')),
  });
}
