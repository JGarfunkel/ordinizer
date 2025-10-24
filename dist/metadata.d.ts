/**
 * Metadata resolution utilities for the Ordinizer library
 * Extracted and generalized from server/lib/metadataUtils.ts
 */
import { OrdinizerConfig } from './config.js';
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
    sourceUrl?: string;
    referencesStateCode?: boolean;
    [key: string]: any;
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
export declare function getSourceForRealm(metadata: Metadata | null | undefined, realmType: RealmType): MetadataSource | null;
export declare class MetadataResolver {
    private config;
    private adapter;
    constructor(config: OrdinizerConfig);
    /**
     * Get the primary source for a document based on realm type
     */
    getPrimarySource(domainId: string, entityId: string): Promise<string | null>;
    /**
     * Get formatted metadata for display
     */
    getFormattedMetadata(domainId: string, entityId: string): Promise<StatuteMetadata | null>;
    /**
     * Check if an entity has available data
     */
    hasData(domainId: string, entityId: string): Promise<boolean>;
    /**
     * Get entity display name with fallback
     */
    getEntityDisplayName(entityId: string): Promise<string>;
    /**
     * Get the appropriate source from metadata based on realm type
     */
    getSourceForEntity(domainId: string, entityId: string): Promise<MetadataSource | null>;
}
