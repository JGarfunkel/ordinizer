import { useQuery } from '@tanstack/react-query';
import { useOrdinizer } from '../providers/OrdinizerProvider';

export interface Analysis {
  id: string;
  questionId: string;
  answer: string;
  score: number;
  confidence: number;
  sourceReference?: string;
  gap?: string;
  [key: string]: any;
}

export function useAnalysis(realmId?: string, entityId?: string, domainId?: string) {
  const { baseUrl, fetcher } = useOrdinizer();

  return useQuery<Analysis[]>({
    queryKey: ['/api/realms', realmId, 'entities', entityId, 'domains', domainId, 'analysis'],
    queryFn: () => 
      fetcher(`${baseUrl}/api/realms/${realmId}/entities/${entityId}/domains/${domainId}/analysis`),
    enabled: !!realmId && !!entityId && !!domainId,
  });
}
