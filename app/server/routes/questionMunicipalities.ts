import type { Express } from "express";
import { getReadOnlyStorage } from "../storage";

export function registerQuestionEntityRoutes(app: Express, apiPrefix: string = "/api") {
  // Get municipalities that have specified a particular question
  app.get(`${apiPrefix}/question-municipalities/:domainId/:questionId`, async (req, res) => {
    try {
      const { domainId, questionId } = req.params;
      const { realm: realmId } = req.query;
      const targetRealmId = typeof realmId === 'string' ? realmId : '';
      const storage = getReadOnlyStorage(targetRealmId);
      const municipalitiesWithAnswer: { id: string; name: string; answer: string }[] = [];
      const entities = await storage.getEntitiesByRealm(targetRealmId);
      for (const entity of entities) {
        try {
          const analysis = await storage.getAnalysisByEntityAndDomain(entity.id, domainId);
          if (analysis) {
            const question = analysis.questions?.find((q: any) => 
              String(q.id) === String(questionId) || String(q.questionId) === String(questionId)
            );
            if (question && question.answer && 
                !question.answer.toLowerCase().includes('not specified') &&
                !question.answer.toLowerCase().includes('no specific') &&
                !question.answer.toLowerCase().includes('does not specify')) {
              municipalitiesWithAnswer.push({
                id: entity.id,
                name: entity.displayName || entity.name,
                answer: question.answer
              });
            }
          }
        } catch (error) {
          continue;
        }
      }
      res.json(municipalitiesWithAnswer);
    } catch (error) {
      res.status(500).json({ error: 'Failed to find municipalities with answers' });
    }
  });
}
