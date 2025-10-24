/**
 * File-based data adapter for the Ordinizer library
 * Provides safe file system access with path validation
 */
import { DataAdapter, Entity, Question, Analysis, Domain } from '../types.js';
export interface FileDataAdapterOptions {
    entitiesFile?: string;
    domainsFile?: string;
    questionsPattern?: string;
    analysisPattern?: string;
    metadataPattern?: string;
}
export declare class FileDataAdapter implements DataAdapter {
    private basePath;
    private options;
    constructor(basePath: string, options?: FileDataAdapterOptions);
    /**
     * Safely resolve a path within the base data directory
     */
    safeResolve(relativePath: string): string;
    /**
     * Normalize entity ID for consistent lookups
     */
    normalizeEntityId(id: string): string;
    /**
     * Load and parse JSON file safely
     */
    private loadJsonFile;
    /**
     * Check if a file exists
     */
    private fileExists;
    getQuestions(domainId: string): Promise<Question[]>;
    getAnalysis(domainId: string, entityId: string): Promise<Analysis | null>;
    listEntities(): Promise<Entity[]>;
    loadMetadata(domainId: string, entityId: string): Promise<any>;
    getDomains(): Promise<Domain[]>;
}
