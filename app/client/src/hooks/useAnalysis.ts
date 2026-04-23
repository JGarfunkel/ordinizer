import { useQuery } from '@tanstack/react-query';
import { useOrdinizer } from '../providers/OrdinizerProvider';
import { apiPath } from '../lib/apiConfig';
import type { Analysis } from '@ordinizer/core';

export function useAnalysis(realmId?: string, entityId?: string, domainId?: string) {
  const { fetcher } = useOrdinizer();

  return useQuery<Analysis>({
    queryKey: [apiPath('analyses'), realmId, entityId, domainId],
    queryFn: () => fetcher(apiPath(`analyses/${realmId}/${entityId}/${domainId}`)),
    enabled: !!realmId && !!entityId && !!domainId,
  });
}
