import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";
import { ScoringEngine } from "@civillyengaged/ordinizer-servercore";

export function registerScoreRoutes(app: Express, apiPrefix: string = "/api") {
  // Get environmental protection scores for a municipality and domain
  app.get(`${apiPrefix}/scores/:realmId/:municipalityId/:domainId`, async (req, res) => {
    try {
      const { realmId, municipalityId, domainId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      const scoring = new ScoringEngine(storage);
      const analysis = await storage.getAnalysisByEntityAndDomain(municipalityId, domainId);
      if (!analysis || !analysis.scores) {
        return res.status(404).json({ error: "Score not found or not calculated" });
      }
      const scoreBreakdown = analysis.scores.scoreBreakdown || {};
      const weightedScoreNormalized = scoreBreakdown.weightedScore ?? 0;
      const overallScore = analysis.overallScore ?? analysis.scores.overallScore ?? 0;
      const normalizedScore = analysis.normalizedScore ?? analysis.scores.normalizedScore ?? 0;
      res.json({
        entityId: municipalityId,
        domainId,
        questions: scoreBreakdown.questionsWithScores || [],
        totalWeightedScore: scoreBreakdown.totalWeightedScore || 0,
        totalPossibleWeight: scoreBreakdown.totalPossibleWeight || 0,
        overallScore: overallScore,
        normalizedScore: normalizedScore,
        scoreColor: scoring.getScoreColorHex(weightedScoreNormalized)
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get municipality score" });
    }
  });

  // NOTE: No current client consumer — available for future use.
  // Per-entity scores are fetched individually via /scores/:realmId/:municipalityId/:domainId.
  app.get(`${apiPrefix}/domain-scores/:realmId/:domainId`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      const storage = getReadOnlyStorage(realmId);
      const scoring = new ScoringEngine(storage);
      const scores = await scoring.getDomainScores(domainId);
      const scoresWithColors: { [municipalityId: string]: { score: number, color: string } } = {};
      for (const [municipalityId, score] of Object.entries(scores)) {
        if (typeof score === 'number') {
          scoresWithColors[municipalityId] = {
            score: score * 10,
            color: scoring.getScoreColorHex(score)
          };
        }
      }
      res.json(scoresWithColors);
    } catch (error) {
      res.status(500).json({ error: "Failed to get domain scores" });
    }
  });
}
