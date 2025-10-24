/**
 * Metadata resolution utilities for the Ordinizer library
 * Extracted and generalized from server/lib/metadataUtils.ts
 */

import { OrdinizerConfig } from './config.js';
import { DataAdapter } from './types.js';

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
  [key: string]: any; // Allow additional fields
}

export interface StatuteMetadata extends Metadata {
  downloadDate?: string;
  section?: string;
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
  
  // Fallback to legacy metadata fields based on realm type
  if (wanted === 'policy' && metadata.policyUrl) {
    return {
      type: wanted,
      sourceUrl: metadata.policyUrl,
      title: metadata.policyTitle || metadata.title
    };
  }
  
  if (metadata.sourceUrl) {
    return {
      type: wanted,
      sourceUrl: metadata.sourceUrl,
      title: metadata.statuteTitle || metadata.policyTitle || metadata.title
    };
  }
  
  return null;
}

export class MetadataResolver {
  private config: OrdinizerConfig;
  private adapter: DataAdapter;

  constructor(config: OrdinizerConfig) {
    this.config = config;
    this.adapter = config.getAdapter();
  }

  /**
   * Get the primary source for a document based on realm type
   */
  async getPrimarySource(domainId: string, entityId: string): Promise<string | null> {
    try {
      const metadata = await this.adapter.loadMetadata(domainId, entityId);
      const realmType = this.config.getRealmType();
      const source = getSourceForRealm(metadata, realmType);
      return source?.sourceUrl || null;
    } catch (error) {
      console.warn(`Failed to load metadata for ${entityId}/${domainId}:`, error);
      return null;
    }
  }

  /**
   * Get formatted metadata for display
   */
  async getFormattedMetadata(domainId: string, entityId: string): Promise<StatuteMetadata | null> {
    try {
      const metadata = await this.adapter.loadMetadata(domainId, entityId);
      if (!metadata) return null;

      const terminology = this.config.getTerminology();
      const realmType = this.config.getRealmType();
      const source = getSourceForRealm(metadata, realmType);
      
      return {
        ...metadata,
        sourceUrl: source?.sourceUrl || metadata.sourceUrl,
        title: source?.title || metadata.title || `${terminology.documentSingular} for ${entityId}`,
        downloadDate: metadata.downloadedAt || metadata.downloadDate,
        section: metadata.section
      };
    } catch (error) {
      console.warn(`Failed to format metadata for ${entityId}/${domainId}:`, error);
      return null;
    }
  }

  /**
   * Check if an entity has available data
   */
  async hasData(domainId: string, entityId: string): Promise<boolean> {
    try {
      const analysis = await this.adapter.getAnalysis(domainId, entityId);
      return analysis !== null;
    } catch {
      return false;
    }
  }

  /**
   * Get entity display name with fallback
   */
  async getEntityDisplayName(entityId: string): Promise<string> {
    try {
      const entities = await this.adapter.listEntities();
      const entity = entities.find(e => e.id === entityId);
      return entity?.displayName || entity?.name || entityId;
    } catch {
      return entityId;
    }
  }

  /**
   * Get the appropriate source from metadata based on realm type
   */
  async getSourceForEntity(domainId: string, entityId: string): Promise<MetadataSource | null> {
    try {
      const metadata = await this.adapter.loadMetadata(domainId, entityId);
      const realmType = this.config.getRealmType();
      return getSourceForRealm(metadata, realmType);
    } catch (error) {
      console.warn(`Failed to get source for ${entityId}/${domainId}:`, error);
      return null;
    }
  }
}