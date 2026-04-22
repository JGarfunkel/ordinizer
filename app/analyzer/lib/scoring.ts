/**
 * Scoring functions for municipal statute analysis.
 * Extracted from analyzeStatutes.ts.
 */

/**
 * Calculate an environmental protection score (0.1–1.0) based on answer content.
 * Higher scores reflect more specific, enforceable regulations.
 */
export function calculateAnswerScore(answer: string, confidence: number): number {
  const lowerAnswer = answer.toLowerCase();

  // No protection
  if (
    answer === "Not specified in the statute." ||
    lowerAnswer.includes("does not specify") ||
    lowerAnswer.includes("not mentioned") ||
    lowerAnswer.includes("no information") ||
    lowerAnswer.includes("not addressed") ||
    lowerAnswer.includes("not covered")
  ) {
    return 0.1;
  }

  // Minimal protection — general/vague language
  if (
    lowerAnswer.includes("general") ||
    lowerAnswer.includes("state code") ||
    lowerAnswer.includes("by law") ||
    lowerAnswer.includes("as determined") ||
    lowerAnswer.includes("may be") ||
    lowerAnswer.includes("if appropriate")
  ) {
    return 0.3;
  }

  let score = 0.5;

  // Specific measurements and standards
  if (lowerAnswer.match(/\d+\s*(inches?|feet|days?|hours?|percent|%|dollars?|\$)/)) score += 0.15;
  if (lowerAnswer.includes("diameter") || lowerAnswer.includes("dbh") || lowerAnswer.includes("height")) score += 0.1;

  // Clear procedures and requirements
  if (lowerAnswer.includes("permit") || lowerAnswer.includes("application")) score += 0.1;
  if (lowerAnswer.includes("approval") || lowerAnswer.includes("authorization")) score += 0.1;
  if (lowerAnswer.includes("inspection") || lowerAnswer.includes("review")) score += 0.1;

  // Enforcement mechanisms
  if (lowerAnswer.includes("fine") || lowerAnswer.includes("penalty") || lowerAnswer.includes("violation")) score += 0.1;
  if (lowerAnswer.match(/\$\d+/) || lowerAnswer.includes("fee")) score += 0.1;

  // Environmental protection specifics
  if (lowerAnswer.includes("replacement") || lowerAnswer.includes("replant") || lowerAnswer.includes("restore")) score += 0.15;
  if (lowerAnswer.includes("native") || lowerAnswer.includes("species") || lowerAnswer.includes("indigenous")) score += 0.1;
  if (lowerAnswer.includes("prohibited") || lowerAnswer.includes("required") || lowerAnswer.includes("mandatory")) score += 0.1;

  // Comprehensive regulatory framework
  if (lowerAnswer.includes("arborist") || lowerAnswer.includes("professional")) score += 0.05;
  if (lowerAnswer.includes("plan") || lowerAnswer.includes("schedule") || lowerAnswer.includes("timeline")) score += 0.05;
  if (lowerAnswer.includes("notice") || lowerAnswer.includes("hearing") || lowerAnswer.includes("appeal")) score += 0.05;

  // Length bonus for comprehensive answers
  if (answer.length > 200 && !lowerAnswer.includes("does not")) score += 0.05;
  if (answer.length > 400 && !lowerAnswer.includes("does not")) score += 0.05;

  // Penalty for qualified/uncertain language
  if (lowerAnswer.includes("may") || lowerAnswer.includes("might") || lowerAnswer.includes("could")) score -= 0.05;
  if (lowerAnswer.includes("unclear") || lowerAnswer.includes("vague") || lowerAnswer.includes("limited")) score -= 0.1;

  return Math.max(0.1, Math.min(1.0, score));
}

/**
 * Calculate weighted normalized scores across all Q&A pairs.
 * Returns a scores object with a `normalizedScore` scaled 0–10.
 */
export function calculateNormalizedScores(answers: any[], questions: any[]): any {
  const scores = {
    overallScore: 0,
    normalizedScore: 0,
    averageConfidence: 0,
    questionsAnswered: 0,
    totalQuestions: answers.length,
    scoreBreakdown: {
      questionScores: [] as number[],
      averageQuestionScore: 0,
      weightedScore: 0,
      totalWeightedScore: 0,
      totalPossibleWeight: 0,
      questionsWithScores: [] as any[],
    },
  };

  if (answers.length === 0 || questions.length === 0) return scores;

  const questionMap = new Map(questions.map(q => [String(q.id), q]));

  scores.questionsAnswered = answers.filter(a => a.answer !== "Not specified in the statute.").length;
  scores.averageConfidence = Math.round(answers.reduce((sum, a) => sum + (a.confidence || 0), 0) / answers.length);

  let totalWeightedScore = 0;
  let totalPossibleWeight = 0;
  const questionsWithScores: any[] = [];

  for (const answer of answers) {
    const question = questionMap.get(String(answer.questionId ?? answer.id));
    const weight = question?.weight ?? 1;
    const score = answer.score ?? 0;
    const weightedScore = score * weight;

    questionsWithScores.push({
      id: String(answer.questionId ?? answer.id),
      question: answer.question || question?.question || question?.text || '',
      answer: answer.answer || "Not analyzed",
      score,
      weight,
      weightedScore,
      maxWeightedScore: weight,
      confidence: answer.confidence ?? 0,
    });

    totalWeightedScore += weightedScore;
    totalPossibleWeight += weight;
  }

  scores.scoreBreakdown.questionScores = answers.map(a => a.score || 0);
  scores.scoreBreakdown.averageQuestionScore =
    scores.scoreBreakdown.questionScores.reduce((s, v) => s + v, 0) / answers.length;
  scores.scoreBreakdown.totalWeightedScore = totalWeightedScore;
  scores.scoreBreakdown.totalPossibleWeight = totalPossibleWeight;
  scores.scoreBreakdown.questionsWithScores = questionsWithScores;

  const normalized = totalPossibleWeight > 0 ? totalWeightedScore / totalPossibleWeight : 0;
  scores.scoreBreakdown.weightedScore = parseFloat(normalized.toFixed(4));
  scores.normalizedScore = parseFloat((normalized * 10).toFixed(2));
  scores.overallScore = scores.normalizedScore;

  return scores;
}
