import { useQuery } from '@tanstack/react-query';
import { useOrdinizer } from '../providers/OrdinizerProvider';
import type { Analysis } from '@ordinizer/core';

export function useAnalysis(realmId?: string, entityId?: string, domainId?: string) {
  const { baseUrl, fetcher, apiPrefix } = useOrdinizer();

  return useQuery<Analysis>({
    queryKey: [apiPrefix + '/analyses', realmId, entityId, domainId],
    queryFn: async () => {
      const data = await fetcher(`${baseUrl}${apiPrefix}/analyses/${realmId}/${entityId}/${domainId}`);
      // Server returns { analysis: Analysis }; unwrap the wrapper
      return data.analysis ?? data;
    },
    enabled: !!realmId && !!entityId && !!domainId,
  });
}
