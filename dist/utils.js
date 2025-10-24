/**
 * Utility functions for backward compatibility and data transformation
 */
/**
 * Get the actual entity ID from an analysis, handling both formats
 */
export function getEntityId(analysis) {
    return analysis.entityId || analysis.municipality?.id || '';
}
/**
 * Get the actual domain ID from an analysis, handling both formats
 */
export function getDomainId(analysis) {
    return analysis.domainId || analysis.domain?.id || '';
}
/**
 * Get the question text from a question object, handling both field names
 */
export function getQuestionText(question) {
    return question.question || question.text || '';
}
/**
 * Get the question ID from an analyzed question, handling both formats
 */
export function getQuestionId(analyzedQuestion) {
    return analyzedQuestion.id ?? analyzedQuestion.questionId;
}
/**
 * Convert any question ID to a stable string key for consistent lookups
 */
export function getStableQuestionKey(id) {
    return id !== undefined ? String(id) : '';
}
/**
 * Normalize confidence score to 0-1 range (handles both 0-1 and 0-100 ranges)
 */
export function normalizeConfidence(confidence) {
    if (confidence > 1) {
        return confidence / 100; // Convert from 0-100 to 0-1
    }
    return confidence;
}
/**
 * Create a library-format Analysis from current format
 */
export function normalizeAnalysis(analysis) {
    return {
        ...analysis,
        entityId: getEntityId(analysis),
        domainId: getDomainId(analysis),
        questions: analysis.questions.map(q => ({
            ...q,
            questionId: getQuestionId(q),
            confidence: normalizeConfidence(q.confidence),
            // Ensure both gap formats are available
            gap: q.gap ?? q.gapAnalysis,
            gapAnalysis: q.gapAnalysis ?? q.gap
        }))
    };
}
/**
 * Convert library format back to current format for backward compatibility
 */
export function denormalizeAnalysis(analysis, entityName, domainName) {
    const result = {
        ...analysis,
        municipality: {
            id: analysis.entityId || '',
            displayName: entityName || analysis.entityId || ''
        },
        domain: {
            id: analysis.domainId || '',
            displayName: domainName || analysis.domainId || ''
        },
        questions: analysis.questions.map(q => ({
            ...q,
            id: q.questionId ?? q.id,
            confidence: q.confidence <= 1 ? q.confidence * 100 : q.confidence, // Convert back to 0-100 if needed
            // Preserve both gap formats
            gap: q.gap ?? q.gapAnalysis,
            gapAnalysis: q.gapAnalysis ?? q.gap
        }))
    };
    // Remove library-specific fields if they exist
    delete result.entityId;
    delete result.domainId;
    return result;
}
