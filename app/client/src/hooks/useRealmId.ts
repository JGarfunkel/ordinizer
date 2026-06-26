import { useParams } from "wouter";
import { useRealms } from "./useRealms";

export function useRealmId(): string | undefined {
  const { realmid } = useParams<{ realmid?: string }>();
  const { data: realms } = useRealms();

  if (realmid) return realmid;
  if (realms?.length === 1) return realms[0].id;
  const defaultRealm = realms?.find(r => r.isDefault);
  if (defaultRealm) return defaultRealm.id;
  return undefined;
}
