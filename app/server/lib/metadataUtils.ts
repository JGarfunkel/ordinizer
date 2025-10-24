export type RealmType = 'statute' | 'policy';

export interface MetadataSource {
  type: string;
  sourceUrl: string;
  title?: string;
  downloadedAt?: string;
  contentLength?: number;
  name?: string;
  sections?: string[];
}

export interface Metadata {
  sources?: MetadataSource[];
  statuteNumber?: string;
  policyNumber?: string | null;
  statuteTitle?: string;
  policyTitle?: string;
  number?: string;
  title?: string;
  sourceUrl?: string; // Legacy field for backward compatibility
  referencesStateCode?: boolean;
}

/**
 * Gets the appropriate source from metadata.sources based on the realm type.
 * 
 * @param metadata The metadata object containing sources array
 * @param realmType The realm type ('statute' or 'policy') from realmConfig
 * @returns The matching source object or null if not found
 */
export function getSourceForRealm(metadata: Metadata | null | undefined, realmType: RealmType): MetadataSource | null {
  if (!metadata) return null;
  
  const wanted = realmType.toLowerCase();
  const aliases: Record<string, string[]> = { 
    statute: ['ordinance', 'code'], 
    policy: [] 
  };
  
  const list = Array.isArray(metadata.sources) ? metadata.sources : [];
  
  // Try exact match first
  const byExact = list.find(s => s?.type?.toLowerCase() === wanted);
  if (byExact) return byExact;
  
  // Try alias match
  const byAlias = list.find(s => aliases[wanted]?.includes(s?.type?.toLowerCase?.() || ''));
  if (byAlias) return byAlias;
  
  // Fallback to legacy metadata.sourceUrl if present
  if (metadata.sourceUrl) {
    return {
      type: wanted,
      sourceUrl: metadata.sourceUrl,
      title: metadata.statuteTitle || metadata.policyTitle || metadata.title
    };
  }
  
  return null;
}