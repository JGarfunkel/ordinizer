/**
 * Utility functions for backward compatibility and data transformation
 */
import type { Analysis, Question, AnalyzedQuestion } from './types.js';
/**
 * Get the actual entity ID from an analysis, handling both formats
 */
export declare function getEntityId(analysis: Analysis): string;
/**
 * Get the actual domain ID from an analysis, handling both formats
 */
export declare function getDomainId(analysis: Analysis): string;
/**
 * Get the question text from a question object, handling both field names
 */
export declare function getQuestionText(question: Question): string;
/**
 * Get the question ID from an analyzed question, handling both formats
 */
export declare function getQuestionId(analyzedQuestion: AnalyzedQuestion): number | string | undefined;
/**
 * Convert any question ID to a stable string key for consistent lookups
 */
export declare function getStableQuestionKey(id: number | string | undefined): string;
/**
 * Normalize confidence score to 0-1 range (handles both 0-1 and 0-100 ranges)
 */
export declare function normalizeConfidence(confidence: number): number;
/**
 * Create a library-format Analysis from current format
 */
export declare function normalizeAnalysis(analysis: Analysis): Analysis;
/**
 * Convert library format back to current format for backward compatibility
 */
export declare function denormalizeAnalysis(analysis: Analysis, entityName?: string, domainName?: string): Analysis;
