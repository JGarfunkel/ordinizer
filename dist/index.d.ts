/**
 * Main entry point for the Ordinizer library
 * Provides the public API for municipal statute analysis
 */
export { OrdinizerConfig } from './config.js';
export { MetadataResolver } from './metadata.js';
export { ScoringEngine } from './scoring.js';
export { FileDataAdapter } from './adapters/fileData.js';
import { OrdinizerConfig } from './config.js';
import type { RealmConfig, PluginConfig } from './types.js';
export type { RealmConfig, Entity, Domain, Question, Analysis, AnalyzedQuestion, SourceRef, EntitySummary, DomainSummary, DataAdapter, LLMProvider, EmbeddingsProvider, PluginConfig } from './types.js';
export { OpenAILLMProvider, OpenAIEmbeddingsProvider, createOpenAIProviders, type OpenAIConfig } from './plugins/openai.js';
export type { ScoreOptions, QuestionWithScore, DetailedEntityScore } from './scoring.js';
export type { StatuteMetadata, MetadataSource, Metadata, RealmType } from './metadata.js';
export { getSourceForRealm } from './metadata.js';
export { getEntityId, getDomainId, getQuestionText, getQuestionId, getStableQuestionKey, normalizeConfidence, normalizeAnalysis, denormalizeAnalysis } from './utils.js';
/**
 * Main Ordinizer class - provides the primary API
 */
export declare class Ordinizer {
    private config;
    private metadataResolver;
    private scoringEngine;
    constructor(config: OrdinizerConfig);
    getConfig(): OrdinizerConfig;
    getEntities(): Promise<import("./types.js").Entity[]>;
    getDomains(): Promise<import("./types.js").Domain[]>;
    getQuestions(domainId: string): Promise<import("./types.js").Question[]>;
    getAnalysis(domainId: string, entityId: string): Promise<import("./types.js").Analysis | null>;
    getPrimarySource(domainId: string, entityId: string): Promise<string | null>;
    getFormattedMetadata(domainId: string, entityId: string): Promise<import("./metadata.js").StatuteMetadata | null>;
    hasData(domainId: string, entityId: string): Promise<boolean>;
    getEntityDisplayName(entityId: string): Promise<string>;
    calculateEntityScore(domainId: string, entityId: string): Promise<number | null>;
    generateEntitySummary(domainId: string, entityId: string, options?: {}): Promise<import("./types.js").EntitySummary>;
    generateDomainSummary(domainId: string, options?: {}): Promise<import("./types.js").DomainSummary>;
    calculateAllDomainScores(entityId: string, options?: {}): Promise<Record<string, number | null>>;
    getScoreColor(score: number, options?: {}): string;
    getScoreColorHex(score: number): string;
    calculateDetailedScore(domainId: string, entityId: string): Promise<import("./scoring.js").DetailedEntityScore | null>;
    getDomainScores(domainId: string): Promise<Record<string, number | null>>;
    calculateDomainScores(domainId: string): Promise<Record<string, number | null>>;
}
/**
 * Factory function to initialize Ordinizer with a realm configuration
 */
export declare function createOrdinizer(realmConfig: RealmConfig, pluginConfig?: PluginConfig): Ordinizer;
