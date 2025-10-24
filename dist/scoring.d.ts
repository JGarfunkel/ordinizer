/**
 * Scoring engine for the Ordinizer library
 * Extracted and generalized from server/lib/scoringUtils.ts
 */
import { OrdinizerConfig } from './config.js';
import { EntitySummary, DomainSummary } from './types.js';
export interface ScoreOptions {
    includeStateCodeEntities?: boolean;
    colorGradient?: {
        low: string;
        medium: string;
        high: string;
    };
}
export interface QuestionWithScore {
    id: number | string;
    question: string;
    answer: string;
    score: number;
    weight: number;
    weightedScore: number;
    maxWeightedScore: number;
    confidence: number;
}
export interface DetailedEntityScore {
    entityId: string;
    domainId: string;
    questions: QuestionWithScore[];
    totalWeightedScore: number;
    totalPossibleWeight: number;
    overallScore: number;
    normalizedScore: number;
}
export declare class ScoringEngine {
    private config;
    private adapter;
    constructor(config: OrdinizerConfig);
    /**
     * Calculate normalized score (0-1) for a single entity in a domain
     */
    calculateEntityScore(domainId: string, entityId: string): Promise<number | null>;
    /**
     * Calculate detailed score breakdown for an entity (backward compatibility)
     */
    calculateDetailedScore(domainId: string, entityId: string): Promise<DetailedEntityScore | null>;
    /**
     * Get RGB color for score based on green gradient (0-1 scale)
     */
    getScoreColor(score: number, options?: ScoreOptions): string;
    /**
     * Get hex color for score based on green gradient (0-1 scale)
     */
    getScoreColorHex(score: number): string;
    /**
     * Calculate green gradient RGB color (extracted from existing scoringUtils.ts)
     */
    private calculateGreenGradient;
    /**
     * Generate entity summary for a domain
     */
    generateEntitySummary(domainId: string, entityId: string, options?: ScoreOptions): Promise<EntitySummary>;
    /**
     * Generate domain summary with all entities
     */
    generateDomainSummary(domainId: string, options?: ScoreOptions): Promise<DomainSummary>;
    /**
     * Calculate scores for all domains for a specific entity
     */
    calculateAllDomainScores(entityId: string, options?: ScoreOptions): Promise<Record<string, number | null>>;
    /**
     * Get pre-calculated scores for all entities in a domain (reads from analysis files)
     * This is more efficient than calculateDomainScores as it reads stored scores
     */
    getDomainScores(domainId: string): Promise<Record<string, number | null>>;
    /**
     * Calculate scores for all entities in a domain (recalculates from questions)
     * Note: Use getDomainScores() instead if scores are pre-calculated
     */
    calculateDomainScores(domainId: string): Promise<Record<string, number | null>>;
}
