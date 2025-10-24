/**
 * Main entry point for the Ordinizer library
 * Provides the public API for municipal statute analysis
 */

// Core exports
export { OrdinizerConfig } from './config.js';
export { MetadataResolver } from './metadata.js';
export { ScoringEngine } from './scoring.js';
export { FileDataAdapter } from './adapters/fileData.js';

// Import for internal use
import { OrdinizerConfig } from './config.js';
import { MetadataResolver } from './metadata.js';
import { ScoringEngine } from './scoring.js';
import { FileDataAdapter } from './adapters/fileData.js';
import type { RealmConfig, PluginConfig } from './types.js';

// Type exports
export type {
  RealmConfig,
  Entity,
  Domain,
  Question,
  Analysis,
  AnalyzedQuestion,
  SourceRef,
  EntitySummary,
  DomainSummary,
  DataAdapter,
  LLMProvider,
  EmbeddingsProvider,
  PluginConfig
} from './types.js';

// Plugin exports
export { 
  OpenAILLMProvider, 
  OpenAIEmbeddingsProvider, 
  createOpenAIProviders,
  type OpenAIConfig 
} from './plugins/openai.js';

// Utility exports
export type { ScoreOptions, QuestionWithScore, DetailedEntityScore } from './scoring.js';
export type { StatuteMetadata, MetadataSource, Metadata, RealmType } from './metadata.js';
export { getSourceForRealm } from './metadata.js';
export { 
  getEntityId, 
  getDomainId, 
  getQuestionText, 
  getQuestionId, 
  getStableQuestionKey,
  normalizeConfidence, 
  normalizeAnalysis, 
  denormalizeAnalysis 
} from './utils.js';

/**
 * Main Ordinizer class - provides the primary API
 */
export class Ordinizer {
  private config: OrdinizerConfig;
  private metadataResolver: MetadataResolver;
  private scoringEngine: ScoringEngine;

  constructor(config: OrdinizerConfig) {
    this.config = config;
    this.metadataResolver = new MetadataResolver(config);
    this.scoringEngine = new ScoringEngine(config);
  }

  // Configuration access
  getConfig(): OrdinizerConfig {
    return this.config;
  }

  // Data access methods
  async getEntities() {
    return await this.config.getAdapter().listEntities();
  }

  async getDomains() {
    return await this.config.getAdapter().getDomains();
  }

  async getQuestions(domainId: string) {
    return await this.config.getAdapter().getQuestions(domainId);
  }

  async getAnalysis(domainId: string, entityId: string) {
    return await this.config.getAdapter().getAnalysis(domainId, entityId);
  }

  // Metadata methods
  async getPrimarySource(domainId: string, entityId: string) {
    return await this.metadataResolver.getPrimarySource(domainId, entityId);
  }

  async getFormattedMetadata(domainId: string, entityId: string) {
    return await this.metadataResolver.getFormattedMetadata(domainId, entityId);
  }

  async hasData(domainId: string, entityId: string) {
    return await this.metadataResolver.hasData(domainId, entityId);
  }

  async getEntityDisplayName(entityId: string) {
    return await this.metadataResolver.getEntityDisplayName(entityId);
  }

  // Scoring methods
  async calculateEntityScore(domainId: string, entityId: string) {
    return await this.scoringEngine.calculateEntityScore(domainId, entityId);
  }

  async generateEntitySummary(domainId: string, entityId: string, options = {}) {
    return await this.scoringEngine.generateEntitySummary(domainId, entityId, options);
  }

  async generateDomainSummary(domainId: string, options = {}) {
    return await this.scoringEngine.generateDomainSummary(domainId, options);
  }

  async calculateAllDomainScores(entityId: string, options = {}) {
    return await this.scoringEngine.calculateAllDomainScores(entityId, options);
  }

  getScoreColor(score: number, options = {}) {
    return this.scoringEngine.getScoreColor(score, options);
  }

  getScoreColorHex(score: number) {
    return this.scoringEngine.getScoreColorHex(score);
  }

  async calculateDetailedScore(domainId: string, entityId: string) {
    return await this.scoringEngine.calculateDetailedScore(domainId, entityId);
  }

  async getDomainScores(domainId: string) {
    return await this.scoringEngine.getDomainScores(domainId);
  }

  async calculateDomainScores(domainId: string) {
    return await this.scoringEngine.calculateDomainScores(domainId);
  }
}

/**
 * Factory function to initialize Ordinizer with a realm configuration
 */
export function createOrdinizer(realmConfig: RealmConfig, pluginConfig: PluginConfig = {}) {
  // Create file adapter using realm's data path and path configuration
  const adapterOptions = realmConfig.paths ? {
    entitiesFile: realmConfig.paths.entitiesFile,
    domainsFile: realmConfig.paths.domainsFile,
    questionsPattern: realmConfig.paths.questionsPattern,
    analysisPattern: realmConfig.paths.analysisPattern,
    metadataPattern: realmConfig.paths.metadataPattern
  } : {};
  
  // For backward compatibility with municipality-specific data files
  if (realmConfig.entityType === 'municipalities' && !adapterOptions.entitiesFile) {
    adapterOptions.entitiesFile = 'municipalities.json';
  }
  
  const dataAdapter = new FileDataAdapter(realmConfig.dataPath, adapterOptions);
  const config = new OrdinizerConfig(realmConfig, dataAdapter, pluginConfig);
  return new Ordinizer(config);
}