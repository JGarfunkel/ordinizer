import { Analysis, BestPractice, MetaAnalysis, AnalyzedQuestion, Question } from "@civillyengaged/ordinizer-core";
import {
 checkRateLimit, recordTokenUsage, estimateTokens, sleep, createChatCompletion
} from "../services/aiService.js";
import { getDefaultStorage, IStorage} from "@civillyengaged/ordinizer-servercore";
import { NO_SOURCES_AVAILABLE, NOT_SPECIFIED } from "./analyzeQuestions.js";
import { analyzeGapText } from './gapAnalysis'
import { ensurePdfParseCompatibility } from "./extractionUtils.js";


const SYNTHESIS_PAUSE_MS = 300; // 300ms pause between synthesis calls

/**
 * @deprecated This function is domain-specific and needs to be replaced
 * Condenses a detailed answer to its essential elements without lengthy quotes
 */
async function condenseAnswerToEssence(fullAnswer: string, questionText: string): Promise<string> {
  // Rule-based condensation for common patterns
  let condensed = fullAnswer;
  
  // Extract key requirements
  const essentials: string[] = [];
  
  // Change language from "yes, you can..." to "the statute calls for..."
  const isNonPrescriptive = questionText.toLowerCase().includes('ordinance') ||
                           questionText.toLowerCase().includes('include');
  
  // Look for permit requirements
  if (questionText.toLowerCase().includes('permit')) {
    if (fullAnswer.toLowerCase().includes('yes') && fullAnswer.toLowerCase().includes('permit')) {
      essentials.push('The statute calls for tree permits before removal');
    }
    
    // Extract size thresholds
    const sizeMatch = fullAnswer.match(/(\d+)\s*inch(es)?\s*(DBH|diameter)/i);
    if (sizeMatch) {
      essentials.push(`applies to trees ${sizeMatch[1]}+ inches DBH`);
    }
    
    // Extract application process
    if (fullAnswer.toLowerCase().includes('application')) {
      essentials.push('written application required');
    }
  }
  
  // Look for penalty information
  if (questionText.toLowerCase().includes('penalties') || questionText.toLowerCase().includes('fine')) {
    const fineMatches = fullAnswer.match(/\$(\d+(?:,\d{3})*)/g);
    if (fineMatches) {
      const amounts = fineMatches.map(f => f.replace('$', '').replace(',', '')).map(Number).sort((a, b) => b - a);
      if (amounts.length > 0) {
        essentials.push(`fines up to $${amounts[0].toLocaleString()}`);
      }
    }
    
    // Extract replacement requirements
    if (fullAnswer.toLowerCase().includes('replacement') || fullAnswer.toLowerCase().includes('replant')) {
      essentials.push('mandatory tree replacement required');
    }
  }
  
  // Look for fee information
  if (questionText.toLowerCase().includes('fee')) {
    const feeMatches = fullAnswer.match(/\$(\d+(?:,\d{3})*)/g);
    if (feeMatches) {
      essentials.push('permit fees');
    } else if (fullAnswer.toLowerCase().includes('no fee') || fullAnswer.toLowerCase().includes('free')) {
      essentials.push('no permit fees');
    }
  }
  
  // For non-prescriptive questions, provide more comprehensive information
  if (isNonPrescriptive) {
    if (questionText.toLowerCase().includes('canopy')) {
      essentials.push('The statute should establish tree canopy coverage goals, measurement methods, and implementation strategies');
      if (fullAnswer.toLowerCase().includes('percent') || fullAnswer.match(/\d+%/)) {
        const percentMatch = fullAnswer.match(/(\d+)%/);
        if (percentMatch) {
          essentials.push(`target coverage of ${percentMatch[1]}%`);
        }
      }
    }
    
    if (questionText.toLowerCase().includes('ordinance') && questionText.toLowerCase().includes('include')) {
      essentials.push('The statute should include permit requirements, protection standards, penalty provisions, and replacement obligations');
    }
  }
  
  // If we extracted essentials, use them with proper grammar; otherwise improve the original
  if (essentials.length > 0) {
    // Join essentials with proper grammar - add "The statute calls for" only once at the beginning
    let result = essentials.join(', ');
    
    // Check if any essential already starts with "The statute"
    const hasStatutePrefix = essentials.some(essential => 
      essential.toLowerCase().startsWith('the statute')
    );
    
    // Only add "The statute calls for" if none of the essentials already have a statute prefix
    if (!hasStatutePrefix && !result.toLowerCase().startsWith('the statute')) {
      result = 'The statute calls for ' + result;
    }
    
    return result;
  }
  
  // Fallback: improve the language of the original answer
  let improved = fullAnswer;
  
  // Handle "Yes, the statute requires..." pattern specifically to avoid duplication
  if (improved.match(/^Yes,?\s+the statute requires/i)) {
    improved = improved.replace(/^Yes,?\s+the statute requires/i, 'The statute requires');
  } else if (improved.match(/^The statute requires/i)) {
    // Already has proper prefix, keep as-is
    improved = improved;
  } else {
    // For other patterns, apply normal transformations
    improved = improved.replace(/^Yes,?\s*/i, 'The statute calls for ');
    improved = improved.replace(/^No,?\s*/i, 'The statute does not require ');
  }
  
  // Handle list-style answers more intelligently
  if (improved.includes('\n\n1.') || improved.includes('include:')) {
    // For maintenance/responsibility questions with numbered lists, preserve the structure
    const lines = improved.split('\n');
    const mainSentence = lines[0];
    const listItems = lines.filter(line => line.match(/^\d+\./));
    
    if (listItems.length > 0) {
      // Summarize list items and remove statute references
      const cleanedItem = listItems[0].replace(/^\d+\.\s*/, '')
        .replace(/\s*\([§\s\d\-A-Z()]+\)/g, '') // Remove statute references like (§ 252-4 A(1))
        .split(',')[0];
      const summary = listItems.length === 1 ? cleanedItem : 
                      `${listItems.length} specific requirements including ${cleanedItem}`;
      return `${mainSentence} ${summary}`;
    }
  }
  
  // Take first sentence and key phrases for other cases, removing statute references
  const sentences = improved.split(/[.!?]+/);
  const cleanedSentence = sentences[0].replace(/\s*\([§\s\d\-A-Z()]+\)/g, ''); // Remove statute references
  return cleanedSentence + (cleanedSentence.endsWith('.') ? '' : '.');
}

/**
 * Extracts specific quantitative data from answers for highlighting strongest laws
 */
async function extractQuantitativeData(fullAnswer: string, questionText: string): Promise<string[]> {
  const highlights: string[] = [];
  
  // Extract tree size thresholds
  const sizeMatches = fullAnswer.match(/(\d+)\s*inch(es)?\s*(DBH|diameter)/gi);
  if (sizeMatches) {
    const sizes = sizeMatches.map(m => parseInt(m.match(/\d+/)?.[0] || '0')).filter(s => s > 0).sort((a, b) => a - b);
    if (sizes.length > 0) {
      highlights.push(`Smallest protected trees: ${sizes[0]} inches DBH`);
    }
  }
  
  // Extract fine amounts
  const fineMatches = fullAnswer.match(/\$(\d+(?:,\d{3})*)/g);
  if (fineMatches) {
    const amounts = fineMatches.map(f => parseInt(f.replace(/[$,]/g, ''))).sort((a, b) => b - a);
    if (amounts.length > 0) {
      highlights.push(`Highest fine: $${amounts[0].toLocaleString()}`);
    }
  }
  
  // Extract replacement ratios
  const replacementMatch = fullAnswer.match(/(\d+)\s*(?:to|:)\s*(\d+)|(\d+)\s*replacement/i);
  if (replacementMatch) {
    const ratio = replacementMatch[1] && replacementMatch[2] ? 
      `${replacementMatch[1]}:${replacementMatch[2]}` : 
      replacementMatch[3] ? `${replacementMatch[3]}:1` : null;
    if (ratio) {
      highlights.push(`Replacement ratio: ${ratio}`);
    }
  }
  
  return highlights;
}

/**
 * Synthesizes insights from top 5 scoring municipalities using OpenAI
 */
async function synthesizeTopAnswers(topAnswers: Array<{entity: Analysis['entity']; answer: AnalyzedQuestion;}>, questionText: string): Promise<string> {
  if (topAnswers.length === 0) return "Not specified in the statute.";
  
  // If only one answer, use the condensed version
  // if (topAnswers.length === 1) {
  //   return await condenseAnswerToEssence(topAnswers[0].answer.answer, questionText);
  // }
  
  // Prepare context for OpenAI synthesis
  const entityData = topAnswers.map((qa, index) => {
    const displayName = qa.entity?.displayName || 'N/A';
    return `entity ${index + 1}: ${displayName} (Score: ${qa.answer.score}, Confidence: ${qa.answer.confidence}%)\nAnswer: ${qa.answer.answer}`;
  }).join("\n\n---\n\n");
  const systemPrompt = `You are synthesizing municipal environmental protection best practices. Given top-scoring entity responses to a question, produce a 2-3 sentence best practice summary. Use language like "The statute should require..." or "Best practices include...". Extract specific quantitative thresholds where present.`;

  const userPrompt = `Question: "${questionText}"

TOP ENTITY RESPONSES:
${entityData}

SYNTHESIS INSTRUCTIONS:
1. Identify the strongest regulatory elements across all responses
2. Combine the most protective requirements into a cohesive best practice
3. Extract specific quantitative thresholds (fees, sizes, timeframes, penalties)
4. Focus on actionable requirements rather than descriptive text
5. Keep the synthesis concise (2-3 sentences maximum)
6. Prioritize elements that appear in multiple municipalities or have the highest scores`;

  try {
    const estimatedTokens = estimateTokens(systemPrompt + userPrompt) + 400;
    await checkRateLimit(estimatedTokens);

    console.log(`🤖 Synthesizing best practice from ${topAnswers.length} top municipalities for question: ${questionText.substring(0, 80)}...`);

    const response = await createChatCompletion(userPrompt, {
      format: "text",
      system: systemPrompt,
      temperature: 0.1,
      maxCompletionTokens: 400,
    });
    
    // Record actual token usage
    const actualTokens = response.usage?.totalTokens || estimatedTokens;
    recordTokenUsage(actualTokens);

    const synthesized = response.text?.trim() || "Not specified in the statute.";
    
    // Clean up the response to remove any redundant prefixes
    const cleanedSynthesis = synthesized.replace(/^(Synthesized best practice:\s*|Best practice:\s*)/i, '').trim();
    
    console.log(`✅ Synthesized: ${cleanedSynthesis.substring(0, 100)}...`);
    
    // Pause between synthesis calls
    await sleep(SYNTHESIS_PAUSE_MS);
    
    return cleanedSynthesis;
    
  } catch (error) {
    console.warn('⚠️  OpenAI synthesis failed, falling back to best single answer:', error);
    // Fallback to the highest scoring answer if OpenAI fails
    return await condenseAnswerToEssence(topAnswers[0].answer.answer, questionText);
  }
}

async function loadAllAnalyses(storage: IStorage, domainId: string, realm?: string): Promise<Analysis[]> {
  const entities = await storage.getEntities();

  const analyses: Analysis[] = [];
  for (const entity of entities) {
    const analysis = await storage.getAnalysis(domainId, entity.id);
    if (!analysis) continue;

    if (analysis.questions && analysis.questions.length > 0) {
    analyses.push(analysis);
    }
  }
  return analyses;
}

async function findBestPracticesForQuestion(questionId: number, analyses: Analysis[], verbose?: boolean): Promise<BestPractice | null> {
  // Gather all answers for this question, excluding NO_SOURCES_AVAILABLE
  const answers: Array<{ entity: Analysis['entity']; analyzedQuestion: AnalyzedQuestion }> = [];
  for (const analysis of analyses) {
    const q = analysis.questions.find(q => {
      // Support both number and string IDs
      const qid = typeof q.id === 'number' ? q.id : Number(q.id);
      return qid === questionId;
    });
    if (q && q.answer && q.answer !== NO_SOURCES_AVAILABLE) {
      answers.push({ entity: analysis.entity, analyzedQuestion: q });
    }
  }

  if (answers.length === 0) return null;

  // Sort by answer length (descending), take top K=8
  const topK = 8;
  const topAnswers = answers
    .map(a => ({ ...a, length: a.analyzedQuestion.answer.length }))
    .sort((a, b) => b.length - a.length)
    .slice(0, topK)
    .map(({ entity, analyzedQuestion }) => ({ entity, answer: analyzedQuestion }));

  // Get the question text from the first available answer
  const questionText = topAnswers[0].answer.question;

  // Synthesize best practice using the top answers
  const bestAnswer = await synthesizeTopAnswers(topAnswers, questionText);

  // Optionally extract quantitative highlights
  let highlights: string[] = [];
  for (const ans of topAnswers) {
    const qHighlights = await extractQuantitativeData(ans.answer.answer, questionText);
    highlights = highlights.concat(qHighlights);
  }
  highlights = Array.from(new Set(highlights)); // Deduplicate

  return {
    questionId,
    question: questionText,
    bestAnswer,
    quantitativeHighlights: highlights
  };
}

export async function enrichEntityAnalysis(
  st: IStorage,
  entityId: string,
  domainId: string,
  verbose?: boolean,
  bestPractices?: BestPractice[]
) {
  const analysis = await st.getAnalysis(domainId, entityId);
  if (!analysis) return;

  if (!bestPractices) {
    const metaAnalysis = await st.getMetaAnalysisByDomain(domainId);
    bestPractices = metaAnalysis?.bestPractices || [];
  }

  if (!bestPractices || bestPractices.length === 0) {
    if (verbose) {
      console.warn(`No best practices available for domain ${domainId} to enrich analysis for entity ${entityId}`);
    }
    return;
  }

  enrichEntityAnalysesWithAI(st, domainId, [analysis], bestPractices, verbose); // Pass empty bestPractices since we only want to enrich gaps/scores  

}

const ENRICHMENT_MAX_TOKENS = 400;

async function enrichAnalysisQuestion(
  question: AnalyzedQuestion,
  bestPractice: BestPractice,
  verbose?: boolean
): Promise<boolean> {
  const prompt = `You are an expert policy analyst. Given the following:

- The question: "${question.question}"
- This municipality's answer: "${question.answer}"
- The synthesized best practice for this question: "${bestPractice.bestAnswer}"

Evaluate the answer and provide:
1. gap: 1–2 sentences describing what is missing or could be improved, or "No gap" if the answer fully matches the best practice.
2. score: A normalized score from 0.0 (no alignment) to 1.0 (perfect alignment).
3. nextPrompts: Up to 2 short research prompts (max 12 words each), or [] if not needed.

Respond in JSON:
{
  "gap": string,
  "score": number,
  "nextPrompts": string[]
}`;

  const estimatedTokens = estimateTokens(prompt) + ENRICHMENT_MAX_TOKENS;
  await checkRateLimit(estimatedTokens);
  if (verbose) {
    console.log(`🤖 Enriching Q${question.id} "${question.question.substring(0, 60)}..."`);
  }
  const response = await createChatCompletion(prompt, {
    format: "json",
    maxCompletionTokens: ENRICHMENT_MAX_TOKENS,
    temperature: 0.1,
  });
  recordTokenUsage(response.usage?.totalTokens || estimatedTokens);
  const content = response.text?.trim() || '{}';
  try {
    const enrichment = JSON.parse(content);
    if (enrichment.gap !== undefined) question.gap = enrichment.gap;
    if (enrichment.score !== undefined) question.score = enrichment.score;
    if (enrichment.nextPrompts !== undefined) question.nextPrompts = enrichment.nextPrompts;
    return true;
  } catch (error) {
    if (verbose) {
      console.error(`Error parsing enrichment response for Q${question.id} — got: ${content}`, error);
    }
    return false;
  }
}

function isAnswerSubstantive(answer: string): boolean {
  return (answer && answer!== NO_SOURCES_AVAILABLE && answer !== NOT_SPECIFIED) ? true : false;
}

/**
 * After meta-analysis, enrich each entity's analysis.json with updated gap, score, and nextPrompts fields.
 */
async function enrichEntityAnalysesWithAI(
  st: IStorage,
  domainId: string,
  analyses: Analysis[],
  bestPractices: BestPractice[],
  verbose?: boolean
) {
  for (const analysis of analyses) {
    let updated = false;
    for (const question of analysis.questions) {
      // Find the corresponding best practice for this question
      const bestPractice = bestPractices.find(bp => bp.questionId === question.id);
      if (!bestPractice) continue;
      // Skip enrichment if already done during the analysis pass (gap was computed in the same AI call)
      if (question.score !== undefined) {
        if (verbose) {
          console.log(`Skipping enrichment for question ${question.id} — already enriched during analysis`);
        }
        continue;
      }
      // skip enrichment if there is no answer or if the answer is "Not specified in the statute." to avoid generating gaps/scores for unanswered questions
      if (isAnswerSubstantive(question.answer)) {
        const enriched = await enrichAnalysisQuestion(question, bestPractice, verbose);
        if (enriched) updated = true;
      } else {
        question.gap = "";
        question.score = 0;
        question.nextPrompts = [];
      }
    }
    if (updated) {
      await st.saveAnalysis(analysis);
      if (verbose) {
        console.log(`✅ Enriched analysis for entity ${analysis.entity?.id}`);
      }
    }
  }
}

/**
 * Returns the question IDs whose best practices need (re)generating:
 * - questions present in currentQuestions but missing from the existing meta
 * - questions whose wording has changed since the meta was last generated
 */
export function bestPracticesToUpdate(
  existingMeta: MetaAnalysis | null | undefined,
  currentQuestions: Question[],
): number[] {
  if (!existingMeta?.bestPractices?.length) {
    return currentQuestions.map(q => q.id);
  }
  const bpMap = new Map(existingMeta.bestPractices.map(bp => [bp.questionId, bp]));
  const toUpdate: number[] = [];
  for (const q of currentQuestions) {
    const existing = bpMap.get(q.id);
    if (!existing) {
      toUpdate.push(q.id); // new question
    } else if (existing.question !== q.question) {
      toUpdate.push(q.id); // wording changed
    }
  }
  return toUpdate;
}

/**
 * Regenerates best practices only for the given question IDs, merges them into
 * the existing meta-analysis, and saves.
 */
async function updateMetaBestPractices(
  st: IStorage,
  domainId: string,
  existingMeta: MetaAnalysis,
  analyses: Analysis[],
  questionIdsToUpdate: number[],
  verbose?: boolean,
): Promise<void> {
  const updateSet = new Set(questionIdsToUpdate);
  const retained = existingMeta.bestPractices.filter(bp => !updateSet.has(bp.questionId));

  const regenerated: BestPractice[] = [];
  for (const questionId of questionIdsToUpdate) {
    const bp = await findBestPracticesForQuestion(questionId, analyses, verbose);
    if (bp) {
      regenerated.push(bp);
      if (verbose) console.log(`[VERBOSE] Updated best practice for question ${questionId}`);
    }
  }

  existingMeta.bestPractices = [...retained, ...regenerated].sort((a, b) => a.questionId - b.questionId);
  existingMeta.analysisDate = new Date().toISOString();
  existingMeta.totalMunicipalitiesAnalyzed = analyses.length;
  await st.saveMetaAnalysis(domainId, existingMeta);
}

async function createMetaAnalysisForDomain(st: IStorage, domainId: string, analyses: Analysis[], verbose?: boolean) {
  const bestPractices: BestPractice[] = [];


  // 2. For each question, synthesize best practices
  const allQuestionIds = Array.from(
    new Set(analyses.flatMap(a => a.questions.map(q => typeof q.id === 'number' ? q.id : Number(q.id)).filter(Boolean)))
  );
  for (const questionId of allQuestionIds) {
    const bp = await findBestPracticesForQuestion(questionId, analyses, verbose);
    if (verbose) {
      console.log(`Best practice found for question ${questionId}:`, bp);
    }
    if (bp) bestPractices.push(bp);
  }

  // 3. Build meta-analysis object
  const meta: MetaAnalysis = {
    domain: {
      id: domainId,
      displayName: domainId,
    },
    analysisDate: new Date().toISOString(),
    totalMunicipalitiesAnalyzed: analyses.length,
    averageScore: analyses.length
      ? analyses.reduce((sum, a) => sum + (a.questions.reduce((s, q) => s + (q.score || 0), 0) / (a.questions.length || 1)), 0) / analyses.length
      : 0,
    highestScoringEntity: (() => {
      let best: { id: string; displayName: string; score: number } = { id: '', displayName: '', score: 0 };
      for (const a of analyses) {
        const avg = a.questions.length ? a.questions.reduce((s, q) => s + (q.score || 0), 0) / a.questions.length : 0;
        if (avg > best.score) best = { id: a.entity?.id || '', displayName: a.entity?.displayName || '', score: avg };
      }
      return best;
    })(),
    bestPractices,
    overallRecommendations: {
      commonWeaknesses: [],
      keyImprovements: [],
      modelMunicipalities: [],
    },
    version: '1.0',
  };

  await st.saveMetaAnalysis(domainId, meta);
}


/**
 * Generates meta-analysis for a domain and then enriches per-entity analyses with AI-evaluated fields.
 * Pass force=true to regenerate all best practices regardless of existing state.
 */
export async function generateMetaAnalysis(st: IStorage, domainId: string, verbose?: boolean, force?: boolean) {
  const analyses = await loadAllAnalyses(st, domainId);
  console.log(`Loaded ${analyses.length} analyses for domain ${domainId}`);

  const currentQuestions: Question[] = await st.getQuestionsByDomain(domainId);
  let metaAnalysis = await st.getMetaAnalysisByDomain(domainId);

  if (force) {
    console.log(`--force: regenerating all ${currentQuestions.length} best practices for domain ${domainId}`);
    await createMetaAnalysisForDomain(st, domainId, analyses, verbose);
  } else {
    const toUpdate = bestPracticesToUpdate(metaAnalysis, currentQuestions);
    if (toUpdate.length === 0) {
      console.log(`Meta-analysis is up-to-date for domain ${domainId}`);
    } else if (!metaAnalysis?.bestPractices?.length) {
      console.log(`No existing meta-analysis for domain ${domainId}, generating from scratch...`);
      await createMetaAnalysisForDomain(st, domainId, analyses, verbose);
    } else {
      console.log(`Updating ${toUpdate.length} best practice(s) for domain ${domainId}: questions ${toUpdate.join(', ')}`);
      await updateMetaBestPractices(st, domainId, metaAnalysis, analyses, toUpdate, verbose);
    }
  }

  metaAnalysis = await st.getMetaAnalysisByDomain(domainId);
  const bestPractices = metaAnalysis?.bestPractices || [];
  console.log(`🎉 Meta-analysis ready for domain ${domainId} with ${bestPractices.length} best practices.`);

  await enrichEntityAnalysesWithAI(st, domainId, analyses, bestPractices);
}

export { findBestPracticesForQuestion };

const entryFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (/(^|\/)createMetaAnalysis\.(ts|js)$/.test(entryFile)) {
  const domainId = process.argv[2] || 'trees';
  const storage = getDefaultStorage('data');
  generateMetaAnalysis(storage, domainId)
    .then(() => process.exit(0))
    .catch((error: unknown) => { console.error('Meta-analysis generation failed:', error); process.exit(1); });
}