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
// Plugin exports
export { OpenAILLMProvider, OpenAIEmbeddingsProvider, createOpenAIProviders } from './plugins/openai.js';
export { getSourceForRealm } from './metadata.js';
export { getEntityId, getDomainId, getQuestionText, getQuestionId, getStableQuestionKey, normalizeConfidence, normalizeAnalysis, denormalizeAnalysis } from './utils.js';
/**
 * Main Ordinizer class - provides the primary API
 */
export class Ordinizer {
    config;
    metadataResolver;
    scoringEngine;
    constructor(config) {
        this.config = config;
        this.metadataResolver = new MetadataResolver(config);
        this.scoringEngine = new ScoringEngine(config);
    }
    // Configuration access
    getConfig() {
        return this.config;
    }
    // Data access methods
    async getEntities() {
        return await this.config.getAdapter().listEntities();
    }
    async getDomains() {
        return await this.config.getAdapter().getDomains();
    }
    async getQuestions(domainId) {
        return await this.config.getAdapter().getQuestions(domainId);
    }
    async getAnalysis(domainId, entityId) {
        return await this.config.getAdapter().getAnalysis(domainId, entityId);
    }
    // Metadata methods
    async getPrimarySource(domainId, entityId) {
        return await this.metadataResolver.getPrimarySource(domainId, entityId);
    }
    async getFormattedMetadata(domainId, entityId) {
        return await this.metadataResolver.getFormattedMetadata(domainId, entityId);
    }
    async hasData(domainId, entityId) {
        return await this.metadataResolver.hasData(domainId, entityId);
    }
    async getEntityDisplayName(entityId) {
        return await this.metadataResolver.getEntityDisplayName(entityId);
    }
    // Scoring methods
    async calculateEntityScore(domainId, entityId) {
        return await this.scoringEngine.calculateEntityScore(domainId, entityId);
    }
    async generateEntitySummary(domainId, entityId, options = {}) {
        return await this.scoringEngine.generateEntitySummary(domainId, entityId, options);
    }
    async generateDomainSummary(domainId, options = {}) {
        return await this.scoringEngine.generateDomainSummary(domainId, options);
    }
    async calculateAllDomainScores(entityId, options = {}) {
        return await this.scoringEngine.calculateAllDomainScores(entityId, options);
    }
    getScoreColor(score, options = {}) {
        return this.scoringEngine.getScoreColor(score, options);
    }
    getScoreColorHex(score) {
        return this.scoringEngine.getScoreColorHex(score);
    }
    async calculateDetailedScore(domainId, entityId) {
        return await this.scoringEngine.calculateDetailedScore(domainId, entityId);
    }
    async getDomainScores(domainId) {
        return await this.scoringEngine.getDomainScores(domainId);
    }
    async calculateDomainScores(domainId) {
        return await this.scoringEngine.calculateDomainScores(domainId);
    }
}
/**
 * Factory function to initialize Ordinizer with a realm configuration
 */
export function createOrdinizer(realmConfig, pluginConfig = {}) {
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
