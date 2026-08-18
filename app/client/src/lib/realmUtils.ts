/**
 * Realm utilities for configuration-driven realm management
 */
import type { Realm } from '@civillyengaged/ordinizer-core';
import { apiPath } from './apiConfig';

let cachedDefaultRealmId: string | null = null;

/**
 * Get the default realm ID dynamically from available realms
 * This replaces hardcoded 'westchester-municipal-environmental' references
 */
export async function getDefaultRealmId(): Promise<string | null> {
  if (cachedDefaultRealmId) {
    return cachedDefaultRealmId;
  }

  try {
    const response = await fetch(apiPath('realms'));
    if (!response.ok) {
      console.warn('Failed to fetch realms for default realm detection');
      return null;
    }
    
    const realms = await response.json();
    if (realms && realms.length > 0) {
      // Use the first available realm as default
      cachedDefaultRealmId = realms[0].id;
      console.log('🏛️ Default realm determined dynamically:', cachedDefaultRealmId);
      return cachedDefaultRealmId;
    }
  } catch (error) {
    console.warn('Error fetching realms for default realm:', error);
  }
  
  return null;
}

/**
 * Clear the cached default realm ID (useful for testing or realm changes)
 */
export function clearDefaultRealmCache(): void {
  cachedDefaultRealmId = null;
}

/**
 * Get realm ID with dynamic fallback
 * First tries the provided realmId, then falls back to dynamic default
 */
export async function resolveRealmId(realmId?: string): Promise<string | null> {
  if (realmId) {
    return realmId;
  }

  return await getDefaultRealmId();
}

const ENTITY_TYPE_LABELS: Record<string, { singular: string; plural: string }> = {
  'municipalities': { singular: 'Municipality', plural: 'Municipalities' },
  'school-districts': { singular: 'School District', plural: 'School Districts' },
  'product': { singular: 'Product', plural: 'Products' },
};

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Get display labels for a realm's entity type, preferring realm-supplied
 * terminology and falling back to a label keyed by `entityType` (rather than
 * a single generic "Entity" default that hides unmapped realm types).
 */
export function getEntityTypeLabels(realm?: Realm | { entityType?: string; terminology?: { entitySingular?: string; entityPlural?: string } } | null): { singular: string; plural: string } {
  const fallback = ENTITY_TYPE_LABELS[realm?.entityType ?? ''] ?? { singular: 'Entity', plural: 'Entities' };
  return {
    singular: realm?.terminology?.entitySingular ? capitalize(realm.terminology.entitySingular) : fallback.singular,
    plural: realm?.terminology?.entityPlural ? capitalize(realm.terminology.entityPlural) : fallback.plural,
  };
}