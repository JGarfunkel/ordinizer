import { useQuery } from '@tanstack/react-query';
import { useOrdinizer } from '../providers/OrdinizerProvider';
import { apiPath } from '../lib/apiConfig';
import type { Realm } from '@ordinizer/core';

export function useRealms() {
  const { fetcher } = useOrdinizer();

  return useQuery<Realm[]>({
    queryKey: [apiPath('realms')],
    queryFn: () => fetcher(apiPath('realms')),
  });
}
