/**
 * Ruleset resolution utilities for the Ordinizer library
 * Extracted and generalized from server/lib/metadataUtils.ts
 *
 * The legacy "Metadata" interface has been retired in favour of the
 * `Ruleset` / `RulesetSource` types defined in @ordinizer/core.
 */

import type { Ruleset, RulesetSource } from '@civillyengaged/ordinizer-core';
import type { IStorageReadOnly } from './storage.js';


export type RealmType = 'statute' | 'policy';

// ---------------------------------------------------------------------------
// Deprecated aliases — kept for backward compatibility during migration.
// New code should import Ruleset / RulesetSource from @ordinizer/core.
// ---------------------------------------------------------------------------

/** @deprecated Use `RulesetSource` from `@ordinizer/core`. */
export type MetadataSource = RulesetSource;

/** @deprecated Use `Ruleset` from `@ordinizer/core`. */
export type Metadata = Ruleset;

/** @deprecated Use `Ruleset` from `@ordinizer/core`. */
export type StatuteMetadata = Ruleset & {
  downloadDate?: string;
  section?: string;
};

/**
 * Gets the appropriate source from a ruleset's sources array based on the realm type.
 */
export function getSourceForRealm(ruleset: Ruleset | null | undefined, realmType: RealmType): RulesetSource | null {
  if (!ruleset) return null;
  
  const wanted = realmType.toLowerCase();
  const aliases: Record<string, string[]> = { 
    statute: ['ordinance', 'code'], 
    policy: [] 
  };
  
  const list = Array.isArray(ruleset.sources) ? ruleset.sources : [];
  
  // Try exact match first
  const byExact = list.find(s => s?.type?.toLowerCase() === wanted);
  if (byExact) return byExact;
  
  // Try alias match
  const byAlias = list.find(s => aliases[wanted]?.includes(s?.type?.toLowerCase?.() || ''));
  if (byAlias) return byAlias;
  
  // Fallback to legacy metadata fields based on realm type
  const raw = ruleset as any;
  if (wanted === 'policy' && raw.policyUrl) {
    return {
      type: wanted,
      sourceUrl: raw.policyUrl,
      title: raw.policyTitle || raw.title,
      downloadedAt: raw.downloadedAt || '',
    };
  }
  
  if (raw.sourceUrl) {
    return {
      type: undefined,
      sourceUrl: raw.sourceUrl,
      title: raw.statuteTitle || raw.policyTitle || raw.title,
      downloadedAt: raw.downloadedAt || '',
    };
  }
  
  return null;
}

export class RulesetResolver {
  private storage: IStorageReadOnly;

  constructor(storage: IStorageReadOnly) {
    this.storage = storage;
  }

  async getRealmType(): Promise<RealmType> {
    const config = await this.storage.getRealmConfig();
    return config?.ruleType || 'statute';
  }

  /**
   * Get the primary source for a document based on realm type
   */
  async getPrimarySource(domainId: string, entityId: string): Promise<string | null> {
    try {
      const ruleset = await this.storage.getRuleset(domainId, entityId);
      const realmType = await this.getRealmType();
      const source = getSourceForRealm(ruleset, realmType);
      return source?.sourceUrl || null;
    } catch (error) {
      console.warn(`Failed to load ruleset for ${entityId}/${domainId}:`, error);
      return null;
    }
  }

  /**
   * Get formatted ruleset for display
   */
  async getFormattedRuleset(domainId: string, entityId: string): Promise<Ruleset | null> {
    try {
      const ruleset = await this.storage.getRuleset(domainId, entityId);
      if (!ruleset) return null;

      const realmType = await this.getRealmType();
      const source = getSourceForRealm(ruleset, realmType);
      const raw = ruleset as any;
      
      return {
        ...ruleset,
        sourceUrl: source?.sourceUrl || raw.sourceUrl,
        title: source?.title || raw.title,
        downloadDate: raw.downloadedAt || raw.downloadDate,
        section: raw.section,
      } as any;
    } catch (error) {
      console.warn(`Failed to format ruleset for ${entityId}/${domainId}:`, error);
      return null;
    }
  }

  /** @deprecated Use getFormattedRuleset() instead. */
  async getFormattedMetadata(domainId: string, entityId: string): Promise<Ruleset | null> {
    return this.getFormattedRuleset(domainId, entityId);
  }

  /**
   * Check if an entity has available data
   */
  async hasData(domainId: string, entityId: string): Promise<boolean> {
    try {
      const analysis = await this.storage.getAnalysisByEntityAndDomain(entityId, domainId);
      return analysis !== null;
    } catch {
      return false;
    }
  }

  /**
   * Get the appropriate source from ruleset based on realm type
   */
  async getSourceForEntity(domainId: string, entityId: string): Promise<RulesetSource | null> {
    try {
      const ruleset = await this.storage.getRuleset(domainId, entityId);
      const realmType = await this.getRealmType();
      return getSourceForRealm(ruleset, realmType);
    } catch (error) {
      console.warn(`Failed to get source for ${entityId}/${domainId}:`, error);
      return null;
    }
  }
}

/** @deprecated Use `RulesetResolver` instead. */
export const MetadataResolver = RulesetResolver;