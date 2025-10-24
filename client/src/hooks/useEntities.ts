import { useQuery } from '@tanstack/react-query';
import { useOrdinizer } from '../providers/OrdinizerProvider';

export interface Entity {
  id: string;
  name: string;
  displayName: string;
  type?: string;
  [key: string]: any;
}

export function useEntities(realmId?: string) {
  const { baseUrl, fetcher } = useOrdinizer();

  return useQuery<Entity[]>({
    queryKey: ['/api/realms', realmId, 'entities'],
    queryFn: () => fetcher(`${baseUrl}/api/realms/${realmId}/entities`),
    enabled: !!realmId,
  });
}
