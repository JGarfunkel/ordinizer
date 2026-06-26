import { useQuery } from '@tanstack/react-query';
import { defaultFetcher, useOrdinizer } from '../providers/OrdinizerProvider';
import { apiPath } from '../lib/apiConfig';
import type { Realm, RealmsConfig } from '@civillyengaged/ordinizer-core';

export function useRealms() {
  const { fetcher = defaultFetcher } = useOrdinizer();

  return useQuery<Realm[]>({
    queryKey: [apiPath('realms')],
    queryFn: () => fetcher(apiPath('realms')),
    staleTime: 30 * 60 * 1000, // 30 minutes
  });
}

export function useRealmsConfig() {
  const { fetcher = defaultFetcher } = useOrdinizer();

  return useQuery<RealmsConfig>({
    queryKey: [apiPath('realms-config')],
    queryFn: () => fetcher(apiPath('realms-config')),
    staleTime: 30 * 60 * 1000, // 30 minutes
  });
}
