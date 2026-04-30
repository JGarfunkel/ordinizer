import { Analysis, AnalysisAnswer, BestPractice, MetaAnalysis } from "@civillyengaged/ordinizer-core";
import {
 checkRateLimit, recordTokenUsage, estimateTokens, sleep, fetchChatResponse
} from "../services/openai.js";
import { getDefaultStorage, IStorage} from "@civillyengaged/ordinizer-servercore";
import { analyzeGapText } from './gapAnalysis'


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
async function synthesizeTopAnswers(topAnswers: Array<{entity: Analysis['entity']; answer: AnalysisAnswer;}>, questionText: string): Promise<string> {
  if (topAnswers.length === 0) return "Not specified in the statute.";
  
  // If only one answer, use the condensed version
  if (topAnswers.length === 1) {
    return await condenseAnswerToEssence(topAnswers[0].answer.answer, questionText);
  }
  
  // Prepare context for OpenAI synthesis
  const entityData = topAnswers.map((qa, index) => {
    const displayName = qa.entity?.displayName || 'N/A';
    return `entity ${index + 1}: ${displayName} (Score: ${qa.answer.score}, Confidence: ${qa.answer.confidence}%)\nAnswer: ${qa.answer.answer}`;
  }).join("\n\n---\n\n");
  const prompt = `You are synthesizing municipal environmental protection best practices. Based on the following top-scoring entity responses to the question "${questionText}", create a comprehensive best practice summary.

TOP entity RESPONSES:
${entityData}

SYNTHESIS INSTRUCTIONS:
1. Identify the strongest regulatory elements across all responses
2. Combine the most protective requirements into a cohesive best practice
3. Extract specific quantitative thresholds (fees, sizes, timeframes, penalties)
4. Focus on actionable requirements rather than descriptive text
5. Use language like "The statute should require..." or "Best practices include..."
6. Keep the synthesis concise (2-3 sentences maximum)
7. Prioritize elements that appear in multiple municipalities or have the highest scores

Synthesized best practice:`;

  try {
    // Rate limiting for synthesis
    const estimatedTokens = estimateTokens(prompt) + 200; // Add max_tokens estimate
    await checkRateLimit(estimatedTokens);
    
    console.log(`🤖 Synthesizing best practice from ${topAnswers.length} top municipalities for question: ${questionText.substring(0, 80)}...`);
    
    const response = await fetchChatResponse("gpt-4o", prompt, 0.1, 200);
    
    // Record actual token usage
    const actualTokens = response.usage?.total_tokens || estimatedTokens;
    recordTokenUsage(actualTokens);
    
    const synthesized = response.choices[0].message.content?.trim() || "Not specified in the statute.";
    
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

async function findBestPracticesForQuestion(questionId: number, analyses: Analysis[]): Promise<BestPractice | null> {
  const questionAnswers: Array<{
    entity: Analysis['entity'];
    answer: AnalysisAnswer;
  }> = [];
  
  let questionText = '';
  
  // Collect all answers for this question across municipalities
  for (const analysis of analyses) {
    const question = analysis.questions.find(q => q.id === questionId);
    if (question && typeof question.id === 'number') {
      questionText = question.question;
      // Cast to AnalysisAnswer (if needed, copy only the compatible fields)
      const answer: AnalysisAnswer = {
        id: question.id,
        answer: question.answer,
        score: question.score,
        confidence: question.confidence,
        gap: question.gap,
        question: question.question,
        sourceRefs: (question as any).sourceRefs || []
      };
      questionAnswers.push({
        entity: analysis.entity,
        answer
      });
    }
  }
  
  if (questionAnswers.length === 0) return null;
  
  // Find the best scoring answers - get top 5 for synthesis
  const sortedAnswers = questionAnswers
    .filter(qa => qa.answer.score > 0) // Exclude unscored answers
    .sort((a, b) => {
      // Primary sort: score (descending)
      if (b.answer.score !== a.answer.score) {
        return b.answer.score - a.answer.score;
      }
      // Secondary sort: confidence (descending)
      return b.answer.confidence - a.answer.confidence;
    });
  
  // Special case: if no scored answers but many "Not specified" answers exist,
  // create a gap-focused best practice for the few municipalities that do have answers
  if (sortedAnswers.length === 0) {
    const notSpecifiedCount = questionAnswers.filter(qa => 
      qa.answer.answer === "Not specified in the statute."
    ).length;
    
    const substantiveAnswers = questionAnswers.filter(qa => 
      qa.answer.answer !== "Not specified in the statute." && qa.answer.confidence > 40
    );
    
    // If most are "Not specified" but some have substantive answers, highlight the gap
    if (notSpecifiedCount >= questionAnswers.length * 0.7 && substantiveAnswers.length > 0) {
      const best = substantiveAnswers.sort((a, b) => b.answer.confidence - a.answer.confidence)[0];
      const bestEntity = best.entity ? { id: best.entity.id, displayName: best.entity.displayName } : { id: '', displayName: '' };
      return {
        questionId,
        question: questionText,
        bestEntity,
        bestAnswer: await condenseAnswerToEssence(best.answer.answer, questionText),
        bestScore: 0.5, // Moderate score since it's rare
        supportingExamples: [{
          municipality: bestEntity,
          score: 0.5,
          confidence: best.answer.confidence
        }],
        commonGaps: [
          "Missing regulatory framework",
          "Lack of data collection requirements", 
          "No public reporting mandates"
        ]
      };
    }
    return null;
  }
  
  // Get top 5 scoring municipalities for synthesis (or all if fewer than 5)
  const top5Answers = sortedAnswers.slice(0, 5);
  const best = top5Answers[0]; // Still track the absolute best for metadata
  
  // Use external gap analysis mapping
  const gapTypes = new Map<string, number>();
  questionAnswers.forEach(qa => {
    if (qa.answer.score < 1.0 && qa.answer.gap) {
      const categories = analyzeGapText(qa.answer.gap);
      for (const category of categories) {
        gapTypes.set(category, (gapTypes.get(category) || 0) + 1);
      }
    }
  });
  
  // Convert to sorted array of most common gaps
  const commonGaps = Array.from(gapTypes.entries())
    .sort((a, b) => b[1] - a[1]) // Sort by frequency
    .slice(0, 3) // Top 3 most common
    .map(([gap]) => gap);
  
  // Use OpenAI to synthesize the top 5 answers into a comprehensive best practice
  const synthesizedAnswer = await synthesizeTopAnswers(top5Answers, questionText);
  
  // Extract quantitative data from all top answers for comprehensive highlights
  const allQuantitativeData: string[] = [];
  for (const topAnswer of top5Answers) {
    const quantData = await extractQuantitativeData(topAnswer.answer.answer, questionText);
    allQuantitativeData.push(...quantData);
  }
  
  // Remove duplicates and keep most specific measurements
  const uniqueQuantitativeData = [...new Set(allQuantitativeData)]
    .sort((a, b) => b.length - a.length) // Prefer more specific measurements
    .slice(0, 3); // Keep top 3 most informative
  
  // Get up to 3 supporting examples from the top answers
  const supportingExamples = top5Answers.slice(0, 3).map(example => {
    const municipality = example.entity ? { id: example.entity.id, displayName: example.entity.displayName } : { id: '', displayName: '' };
    return {
      municipality,
      score: example.answer.score,
      confidence: example.answer.confidence
    };
  });

  const bestEntity = best.entity ? { id: best.entity.id, displayName: best.entity.displayName } : { id: '', displayName: '' };

  return {
    questionId,
    question: questionText,
    bestAnswer: synthesizedAnswer,
    bestScore: best.answer.score,
    bestEntity,
    quantitativeHighlights: uniqueQuantitativeData,
    supportingExamples, // Up to 3 municipal references
    commonGaps
  };
}

async function generateMetaAnalysis(st: IStorage, domainId: string = 'trees', realm?: string): Promise<void> {
  console.log(`🚀 Generating meta-analysis for ${domainId} domain...`);
  
  // Load all analyses
  const analyses = await loadAllAnalyses(st, domainId);
  console.log(`📊 Loaded ${analyses.length} entity analyses`);
  
  if (analyses.length === 0) {
    console.error('❌ No analyses found to process');
    return;
  }
  
  // Calculate overall statistics - handle analyses with or without overallScore
  let validAnalyses = analyses.filter(a => typeof a.overallScore === 'number' && !isNaN(a.overallScore));
  
  // If no overall scores available, calculate them from question scores
  if (validAnalyses.length === 0) {
    console.log('🔄 No overallScore found, calculating from individual question scores...');
    
    for (const analysis of analyses) {
      if (analysis.questions && analysis.questions.length > 0) {
        // Calculate overall score from question scores (if they exist)
        const scoredQuestions = analysis.questions.filter(q => 
          typeof q.score === 'number' && !isNaN(q.score)
        );
        
        if (scoredQuestions.length > 0) {
          const totalScore = scoredQuestions.reduce((sum, q) => sum + q.score, 0);
          analysis.overallScore = totalScore / scoredQuestions.length;
          validAnalyses.push(analysis);
        } else {
          // No numeric scores, estimate based on confidence and answer quality
          const substantiveQuestions = analysis.questions.filter(q => 
            q.answer !== "Not specified in the statute." && q.confidence > 50
          );
          
          if (substantiveQuestions.length > 0) {
            // Score based on how many questions have substantive answers
            analysis.overallScore = substantiveQuestions.length / analysis.questions.length;
            validAnalyses.push(analysis);
          }
        }
      }
    }
  }
  
  if (validAnalyses.length === 0) {
    console.error('❌ No valid analyses found to process (no scores or substantive answers)');
    return;
  }
  
  console.log(`📊 Processing ${validAnalyses.length} analyses with calculated scores`);
  
  const totalScore = validAnalyses.reduce((sum, analysis) => sum + (analysis.overallScore ?? 0), 0);
  const averageScore = totalScore / validAnalyses.length;
  
  const highestScoring = validAnalyses.reduce((best, current) => {
    if ((current.overallScore ?? 0) > (best.overallScore ?? 0)) {
      return current;
    }
    return best;
  });
  
  // Find unique questions across all analyses
  const questionIds = new Set<number>();
  analyses.forEach(analysis => {
    analysis.questions.forEach(q => {
      if (typeof q.id === 'number') questionIds.add(q.id);
    });
  });
  
  console.log(`📝 Processing ${questionIds.size} unique questions...`);
  
  // Generate best practices for each question
  const bestPractices: BestPractice[] = [];
  for (const questionId of Array.from(questionIds).sort()) {
    const bestPractice = await findBestPracticesForQuestion(questionId, analyses);
    if (bestPractice) {
      bestPractices.push(bestPractice);
      // Use bestEntity for logging if available
      const bestEntityName = bestPractice.bestEntity?.displayName || 'N/A';
      console.log(`✅ Q${questionId}: Synthesized best practice from top municipalities (best: ${bestEntityName}, score: ${bestPractice.bestScore.toFixed(1)})`);
    }
  }
  
  // Generate overall recommendations
  const commonWeaknesses: string[] = [];
  const keyImprovements: string[] = [];
  const modelMunicipalities: string[] = [];
  
  // Identify common patterns
  const lowScoringQuestions = bestPractices.filter(bp => bp.bestScore < 0.8);
  if (lowScoringQuestions.length > 0) {
    commonWeaknesses.push(`${lowScoringQuestions.length} questions consistently score below 0.8 across municipalities`);
  }
  
  // High-performing municipalities
  const topMunicipalities = validAnalyses
    .filter(a => (a.overallScore ?? 0) >= averageScore * 1.1)
    .sort((a, b) => (b.overallScore ?? 0) - (a.overallScore ?? 0))
    .slice(0, 5)
    .map(a => a.entity?.displayName || '');
  
  modelMunicipalities.push(...topMunicipalities);
  
  // Key improvements from best practices
  const allImprovements = bestPractices
    .flatMap(bp => bp.commonGaps)
    .filter((improvement, index, arr) => arr.indexOf(improvement) === index)
    .slice(0, 10);
  
  keyImprovements.push(...allImprovements);
  
  // Create meta-analysis object
  const metaAnalysis: MetaAnalysis = {
    domain: {
      id: domainId,
      displayName: analyses[0]?.domain?.displayName || domainId
    },
    analysisDate: new Date().toISOString(),
    totalMunicipalitiesAnalyzed: analyses.length,
    averageScore: Number(averageScore.toFixed(2)),
    highestScoringEntity: {
      id: highestScoring.entity?.id || '',
      displayName: highestScoring.entity?.displayName || '',
      score: Number((highestScoring.overallScore ?? 0).toFixed(2))
    },
    bestPractices,
    overallRecommendations: {
      commonWeaknesses,
      keyImprovements,
      modelMunicipalities
    },
    version: "1.0"
  };
  
  // Save meta-analysis using storage abstraction
  // Fallback: use saveAnalysis for meta-analysis if saveMetaAnalysis does not exist
  if (typeof (st as any).saveMetaAnalysis === 'function') {
    await (st as any).saveMetaAnalysis(domainId, metaAnalysis);
    console.log(`\n🎉 Meta-analysis complete!`);
    console.log(`📁 Meta-analysis saved for domain: ${domainId}`);
  } else if (typeof (st as any).saveAnalysis === 'function') {
    // Save as a special analysis with id 'meta-analysis'
    await (st as any).saveAnalysis(domainId, 'meta-analysis', metaAnalysis);
    console.log(`\n🎉 Meta-analysis complete!`);
    console.log(`📁 Meta-analysis saved as analysis 'meta-analysis' for domain: ${domainId}`);
  } else {
    throw new Error('No suitable save method found on storage abstraction.');
  }
  console.log(`📊 Analyzed ${analyses.length} municipalities`);
  console.log(`🏆 Best overall: ${highestScoring.entity?.displayName || 'N/A'} (${(highestScoring.overallScore ?? 0).toFixed(1)})`);
  console.log(`📈 Average score: ${averageScore.toFixed(2)}`);
  console.log(`⭐ ${bestPractices.length} best practices identified`);
  console.log(`🎯 ${modelMunicipalities.length} model municipalities found`);
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const domainId = process.argv[2] || 'trees';
  const storage = getDefaultStorage('data');
  generateMetaAnalysis(storage, domainId)
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Meta-analysis generation failed:', error);
      process.exit(1);
    });
}

export { generateMetaAnalysis, findBestPracticesForQuestion };