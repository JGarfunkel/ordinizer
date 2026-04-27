/**
 * Main entry point for the Ordinizer library
 * Provides the public API for municipal statute analysis
 */

// Core exports
export { OrdinizerConfig } from './config';
export { RulesetResolver, MetadataResolver } from './metadata';
export { ScoringEngine } from './scoring';

// Import for internal use
import { ScoringEngine } from './scoring';
import { getReadOnlyStorage } from './storage';
import type { IStorage, IStorageReadOnly } from './storage';

// Utility exports
export type { ScoreOptions, QuestionWithScore, DetailedEntityScore } from './scoring';
export type { StatuteMetadata, MetadataSource, Metadata, RealmType } from './metadata';
export { JsonFileStorage, getDefaultStorage, getReadOnlyStorage, getRealmsFromStorage } from './storage';
export type { IStorage, IStorageReadOnly, FileStat } from './storage';
export { getSourceForRealm } from './metadata';

// Re-export commonly used types from @ordinizer/core for convenience
export type { Analysis, MetaAnalysis, Ruleset, RulesetSource, Realm } from '@civillyengaged/ordinizer-core';
export { 
  getEntityId, 
  getDomainId, 
  getQuestionText, 
  getQuestionId, 
  getStableQuestionKey,
  normalizeConfidence, 
  normalizeAnalysis, 
} from './utils';

const ordinizerMap: Map<string, Ordinizer> = new Map();

/**
 * Factory function to initialize Ordinizer with a realm configuration
 */
export async function getOrdinizer(realmId: string) {
  if (ordinizerMap.has(realmId)) {
    return ordinizerMap.get(realmId)!;
  } else {
    const storage = getReadOnlyStorage(realmId);
    const ordinizer = new Ordinizer(storage);
    ordinizerMap.set(realmId, ordinizer);
    return ordinizer;
  }
}

/**
 * Main Ordinizer class - provides the primary API
 */
export class Ordinizer {
  private storage: IStorageReadOnly;
  private scoringEngine: ScoringEngine;

  constructor(storage: IStorageReadOnly, ) {
    this.storage = storage;
    this.scoringEngine = new ScoringEngine(this.storage);
  }

  // // Data access methods
  // async getEntities() {
  //   return await this.config.getAdapter().listEntities();
  // }

  // async getDomains() {
  //   return await this.config.getAdapter().getDomains();
  // }

  // async getQuestions(domainId: string) {
  //   return await this.config.getAdapter().getQuestions(domainId);
  // }

  // async getAnalysis(domainId: string, entityId: string) {
  //   return await this.config.getAdapter().getAnalysis(domainId, entityId);
  // }

  // // Metadata methods
  // async getPrimarySource(domainId: string, entityId: string) {
  //   return await this.metadataResolver.getPrimarySource(domainId, entityId);
  // }

  // async getFormattedMetadata(domainId: string, entityId: string) {
  //   return await this.metadataResolver.getFormattedMetadata(domainId, entityId);
  // }

  // async hasData(domainId: string, entityId: string) {
  //   return await this.metadataResolver.hasData(domainId, entityId);
  // }

  // async getEntityDisplayName(entityId: string) {
  //   return await this.metadataResolver.getEntityDisplayName(entityId);
  // }

  // Scoring methods
  async calculateEntityScore(domainId: string, entityId: string) {
    return await this.scoringEngine.calculateEntityScore(domainId, entityId);
  }

  async generateEntitiesSummary(domainId: string, options = {}) {
    return await this.scoringEngine.generateEntitiesSummary(domainId, options);
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

  async getDomainMatrixData(domainId: string) {
    return await this.scoringEngine.getDomainMatrixData(domainId);
  }

  async calculateDomainScores(domainId: string) {
    return await this.scoringEngine.calculateDomainScores(domainId);
  }
}



