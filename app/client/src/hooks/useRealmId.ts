import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { getDefaultRealmId } from "../lib/realmUtils";

export function useRealmId(): string | undefined {
  const { realmid } = useParams<{ realmid?: string }>();
  const [fallback, setFallback] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!realmid) {
      getDefaultRealmId().then(id => { if (id) setFallback(id); });
    }
  }, [realmid]);

  return realmid || fallback;
}
