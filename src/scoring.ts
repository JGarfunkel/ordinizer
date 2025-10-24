/**
 * Scoring engine for the Ordinizer library
 * Extracted and generalized from server/lib/scoringUtils.ts
 */

import { OrdinizerConfig } from './config.js';
import { DataAdapter, Analysis, EntitySummary, DomainSummary, Question } from './types.js';

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
  score: number; // Individual score 0.0 - 1.0
  weight: number; // Question weight (default 1)
  weightedScore: number; // score * weight
  maxWeightedScore: number; // weight (max possible for this question)
  confidence: number;
}

export interface DetailedEntityScore {
  entityId: string;
  domainId: string;
  questions: QuestionWithScore[];
  totalWeightedScore: number;
  totalPossibleWeight: number;
  overallScore: number; // 0.0 - 10.0 scale (backward compatibility)
  normalizedScore: number; // 0.0 - 1.0 scale (library standard)
}

export class ScoringEngine {
  private config: OrdinizerConfig;
  private adapter: DataAdapter;

  constructor(config: OrdinizerConfig) {
    this.config = config;
    this.adapter = config.getAdapter();
  }

  /**
   * Calculate normalized score (0-1) for a single entity in a domain
   */
  async calculateEntityScore(domainId: string, entityId: string): Promise<number | null> {
    try {
      const analysis = await this.adapter.getAnalysis(domainId, entityId);
      if (!analysis || !analysis.questions || analysis.questions.length === 0) {
        return null;
      }

      // Calculate weighted average score
      const questions = await this.adapter.getQuestions(domainId);
      const questionWeights = new Map(questions.map(q => [String(q.id), q.weight ?? 1]));

      let totalScore = 0;
      let totalWeight = 0;

      for (const analyzedQuestion of analysis.questions) {
        // Get question ID, supporting both formats, and normalize to string
        const questionId = analyzedQuestion.questionId ?? analyzedQuestion.id;
        const weight = questionId !== undefined ? questionWeights.get(String(questionId)) ?? 1 : 1;
        const score = analyzedQuestion.score ?? 0;
        
        if (questionId === undefined) {
          console.warn(`Missing question ID in analyzed question for ${entityId}/${domainId}`);
        }
        
        totalScore += score * weight;
        totalWeight += weight;
      }

      return totalWeight > 0 ? totalScore / totalWeight : null;
    } catch (error) {
      console.warn(`Failed to calculate score for ${entityId}/${domainId}:`, error);
      return null;
    }
  }

  /**
   * Calculate detailed score breakdown for an entity (backward compatibility)
   */
  async calculateDetailedScore(domainId: string, entityId: string): Promise<DetailedEntityScore | null> {
    try {
      const analysis = await this.adapter.getAnalysis(domainId, entityId);
      if (!analysis || !analysis.questions || analysis.questions.length === 0) {
        return null;
      }

      // Get questions with weights
      const questions = await this.adapter.getQuestions(domainId);
      const questionMap = new Map(questions.map(q => [String(q.id), q]));

      const questionsWithScores: QuestionWithScore[] = [];
      let totalWeightedScore = 0;
      let totalPossibleWeight = 0;

      for (const question of questions) {
        // Find corresponding analysis answer
        const analyzedQuestion = analysis.questions.find(aq => 
          String(aq.questionId ?? aq.id) === String(question.id)
        );

        const weight = question.weight ?? 1;
        const score = analyzedQuestion?.score ?? 0;
        const weightedScore = score * weight;

        questionsWithScores.push({
          id: question.id,
          question: question.question || question.text || '',
          answer: analyzedQuestion?.answer || "Not analyzed",
          score,
          weight,
          weightedScore,
          maxWeightedScore: weight,
          confidence: analyzedQuestion?.confidence ?? 0
        });

        totalWeightedScore += weightedScore;
        totalPossibleWeight += weight;
      }

      // Calculate scores
      const normalizedScore = totalPossibleWeight > 0 ? totalWeightedScore / totalPossibleWeight : 0;
      const overallScore = Math.round(normalizedScore * 10 * 10) / 10; // 0-10 scale

      return {
        entityId,
        domainId,
        questions: questionsWithScores,
        totalWeightedScore,
        totalPossibleWeight,
        overallScore,
        normalizedScore
      };
    } catch (error) {
      console.warn(`Failed to calculate detailed score for ${entityId}/${domainId}:`, error);
      return null;
    }
  }

  /**
   * Get RGB color for score based on green gradient (0-1 scale)
   */
  getScoreColor(score: number, options: ScoreOptions = {}): string {
    const realm = this.config.getRealm();
    
    // Use gradient from realm config or options, fallback to environmental green gradient
    if (options.colorGradient || realm.scoring?.colorGradient) {
      const gradient = options.colorGradient || realm.scoring?.colorGradient!;
      const thresholds = realm.scoring?.thresholds || { low: 0.3, high: 0.7 }; // 0-1 scale
      
      if (score < thresholds.low) return gradient.low;
      if (score < thresholds.high) return gradient.medium;
      return gradient.high;
    }

    // Default environmental gradient calculation
    return this.calculateGreenGradient(score);
  }

  /**
   * Get hex color for score based on green gradient (0-1 scale)
   */
  getScoreColorHex(score: number): string {
    const intensity = Math.max(0, Math.min(1, score));
    
    // Dark green: #22c55e, Light green: #bbf7d0
    const darkGreen = { r: 34, g: 197, b: 94 };
    const lightGreen = { r: 187, g: 247, b: 208 };
    
    const r = Math.round(lightGreen.r + (darkGreen.r - lightGreen.r) * intensity);
    const g = Math.round(lightGreen.g + (darkGreen.g - lightGreen.g) * intensity);
    const b = Math.round(lightGreen.b + (darkGreen.b - lightGreen.b) * intensity);
    
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  /**
   * Calculate green gradient RGB color (extracted from existing scoringUtils.ts)
   */
  private calculateGreenGradient(score: number): string {
    const intensity = Math.max(0, Math.min(1, score));
    
    // Dark green: rgb(34, 197, 94), Light green: rgb(187, 247, 208)
    const darkGreen = { r: 34, g: 197, b: 94 };
    const lightGreen = { r: 187, g: 247, b: 208 };
    
    const r = Math.round(lightGreen.r + (darkGreen.r - lightGreen.r) * intensity);
    const g = Math.round(lightGreen.g + (darkGreen.g - lightGreen.g) * intensity);
    const b = Math.round(lightGreen.b + (darkGreen.b - lightGreen.b) * intensity);
    
    return `rgb(${r}, ${g}, ${b})`;
  }

  /**
   * Generate entity summary for a domain
   */
  async generateEntitySummary(domainId: string, entityId: string, options: ScoreOptions = {}): Promise<EntitySummary> {
    const entities = await this.adapter.listEntities();
    const entity = entities.find(e => e.id === entityId);
    const entityName = entity?.displayName || entity?.name || entityId;

    // Check if analysis exists
    const analysis = await this.adapter.getAnalysis(domainId, entityId);
    const hasAnalysis = analysis !== null;

    // Check if scoring should be ignored based on realm policy
    const metadata = await this.adapter.loadMetadata(domainId, entityId);
    const realm = this.config.getRealm();
    const shouldIgnoreScoring = realm.scoring?.ignoreIf ? realm.scoring.ignoreIf(metadata) : 
                              metadata?.referencesStateCode === true; // Default fallback

    let score: number | null = null;
    let scoreColor: string | undefined = undefined;

    if (hasAnalysis && !shouldIgnoreScoring) {
      score = await this.calculateEntityScore(domainId, entityId);
      if (score !== null) {
        scoreColor = this.getScoreColor(score, options);
      }
    }

    return {
      entityId,
      name: entityName,
      available: hasAnalysis,
      stateCodeApplies: shouldIgnoreScoring, // Maintain backward compatibility
      score,
      scoreColor
    };
  }

  /**
   * Generate domain summary with all entities
   */
  async generateDomainSummary(domainId: string, options: ScoreOptions = {}): Promise<DomainSummary> {
    const entities = await this.adapter.listEntities();
    const entitySummaries: EntitySummary[] = [];
    let totalScore = 0;
    let scoredEntities = 0;

    for (const entity of entities) {
      const summary = await this.generateEntitySummary(domainId, entity.id, options);
      entitySummaries.push(summary);

      if (summary.score !== null && summary.score !== undefined) {
        totalScore += summary.score;
        scoredEntities++;
      }
    }

    const averageScore = scoredEntities > 0 ? totalScore / scoredEntities : undefined;
    const entitiesWithData = entitySummaries.filter(s => s.available).length;

    return {
      domainId,
      totalEntities: entities.length,
      entitiesWithData,
      averageScore,
      entities: entitySummaries
    };
  }

  /**
   * Calculate scores for all domains for a specific entity
   */
  async calculateAllDomainScores(entityId: string, options: ScoreOptions = {}): Promise<Record<string, number | null>> {
    const domains = await this.adapter.getDomains();
    const scores: Record<string, number | null> = {};

    for (const domain of domains) {
      scores[domain.id] = await this.calculateEntityScore(domain.id, entityId);
    }

    return scores;
  }

  /**
   * Get pre-calculated scores for all entities in a domain (reads from analysis files)
   * This is more efficient than calculateDomainScores as it reads stored scores
   */
  async getDomainScores(domainId: string): Promise<Record<string, number | null>> {
    const scores: Record<string, number | null> = {};

//    console.debug("Getting domain scores for:", domainId);
    try {
      const entities = await this.adapter.listEntities();
      
      for (const entity of entities) {
        try {
          // console.debug("Looking up analysis for entity:", entity.id)
          const analysis = await this.adapter.getAnalysis(domainId, entity.id);
          if (analysis) {
            // Try different score locations in analysis file
            const score = analysis.overallScore ?? analysis.scores?.overallScore ?? null;
            // console.debug("For entity:", entity.id, "Score:", score)
            if (score !== null && score !== undefined) {
              scores[entity.id] = score;
            }
          }
        } catch (error) {
          // Entity doesn't have analysis, skip
          continue;
        }
      }
    } catch (error) {
      console.error(`Error getting domain scores for ${domainId}:`, error);
    }

    return scores;
  }

  /**
   * Calculate scores for all entities in a domain (recalculates from questions)
   * Note: Use getDomainScores() instead if scores are pre-calculated
   */
  async calculateDomainScores(domainId: string): Promise<Record<string, number | null>> {
    const scores: Record<string, number | null> = {};
    
    try {
      const entities = await this.adapter.listEntities();
      
      for (const entity of entities) {
        const score = await this.calculateEntityScore(domainId, entity.id);
        if (score !== null) {
          scores[entity.id] = score;
        }
      }
    } catch (error) {
      console.error(`Error calculating domain scores for ${domainId}:`, error);
    }

    return scores;
  }
}