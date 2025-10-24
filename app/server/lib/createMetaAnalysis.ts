#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// Helper functions for path resolution (simplified from analyzeStatutes.ts)
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getProjectRoot(): Promise<string> {
  let currentDir = process.cwd();
  while (currentDir !== path.dirname(currentDir)) {
    if (await fileExists(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  return process.cwd();
}

async function getDataDir(): Promise<string> {
  const projectRoot = await getProjectRoot();
  return path.join(projectRoot, 'data');
}

async function getRealmsPath(): Promise<string> {
  const projectRoot = await getProjectRoot();
  return path.join(projectRoot, 'data', 'realms.json');
}

async function getRealmDataDir(realmDataPath: string): Promise<string> {
  const projectRoot = await getProjectRoot();
  return path.join(projectRoot, 'data', realmDataPath);
}

// Initialize OpenAI client for synthesis
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Rate limiting globals for meta-analysis
interface TokenUsage {
  timestamp: number;
  tokens: number;
}

let tokenUsageHistory: TokenUsage[] = [];
const TOKENS_PER_MINUTE_LIMIT = 30000;
const SYNTHESIS_PAUSE_MS = 300; // 300ms pause between synthesis calls

// Token estimation function
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Check if we need to pause based on token usage
async function checkRateLimit(estimatedTokens: number): Promise<void> {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  
  tokenUsageHistory = tokenUsageHistory.filter(usage => usage.timestamp > oneMinuteAgo);
  const currentUsage = tokenUsageHistory.reduce((sum, usage) => sum + usage.tokens, 0);
  
  if (currentUsage + estimatedTokens > TOKENS_PER_MINUTE_LIMIT) {
    const oldestEntry = tokenUsageHistory[0];
    const waitTime = oldestEntry ? (oldestEntry.timestamp + 60000 - now) : 60000;
    
    if (waitTime > 0) {
      console.log(`⏳ Meta-analysis rate limit approached. Waiting ${(waitTime / 1000).toFixed(1)}s...`);
      await sleep(waitTime);
      tokenUsageHistory = tokenUsageHistory.filter(usage => usage.timestamp > Date.now() - 60000);
    }
  }
}

// Record token usage
function recordTokenUsage(tokens: number): void {
  tokenUsageHistory.push({ timestamp: Date.now(), tokens });
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Meta-Analysis System for Municipal Environmental Protection Standards
 * 
 * This script analyzes all municipal statutes to identify:
 * 1. The most environmentally protective answers for each question
 * 2. Best practices across all municipalities 
 * 3. "Ideal" standards for future analysis comparisons
 */

interface AnalysisAnswer {
  id: number;
  question: string;
  answer: string;
  confidence: number;
  score: number;
  gap?: string;
  sourceRefs: string[];
  relevantSections?: string[];
}

interface Analysis {
  municipality: {
    id: string;
    displayName: string;
  };
  domain: {
    id: string;
    displayName: string;
  };
  questions: AnalysisAnswer[];
  overallScore: number;
  lastUpdated: string;
  processingMethod?: string;
}

interface BestPractice {
  questionId: number;
  question: string;
  bestAnswer: string;
  bestScore: number;
  bestMunicipality: {
    id: string;
    displayName: string;
  };
  quantitativeHighlights?: string[]; // New field for specific numbers/measurements
  supportingExamples: Array<{ // Up to 3 municipal references
    municipality: {
      id: string;
      displayName: string;
    };
    score: number;
    confidence: number;
  }>;

  commonGaps: string[];
}

interface MetaAnalysis {
  domain: {
    id: string;
    displayName: string;
  };
  analysisDate: string;
  totalMunicipalitiesAnalyzed: number;
  averageScore: number;
  highestScoringMunicipality: {
    id: string;
    displayName: string;
    score: number;
  };
  bestPractices: BestPractice[];
  overallRecommendations: {
    commonWeaknesses: string[];
    keyImprovements: string[];
    modelMunicipalities: string[];
  };
  version: string;
}

/**
 * Condenses a detailed answer to its essential elements without lengthy quotes
 */
async function condenseAnswerToEssence(fullAnswer: string, questionText: string): Promise<string> {
  // Rule-based condensation for common patterns
  let condensed = fullAnswer;
  
  // Extract key requirements
  const essentials: string[] = [];
  
  // Change language from "yes, you can..." to "the statute calls for..."
  const isNonPrescriptive = questionText.toLowerCase().includes('canopy') || 
                           questionText.toLowerCase().includes('ordinance') ||
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
async function synthesizeTopAnswers(topAnswers: Array<{municipality: Analysis['municipality']; answer: AnalysisAnswer;}>, questionText: string): Promise<string> {
  if (topAnswers.length === 0) return "Not specified in the statute.";
  
  // If only one answer, use the condensed version
  if (topAnswers.length === 1) {
    return await condenseAnswerToEssence(topAnswers[0].answer.answer, questionText);
  }
  
  // Prepare context for OpenAI synthesis
  const municipalityData = topAnswers.map((qa, index) => {
    return `Municipality ${index + 1}: ${qa.municipality.displayName} (Score: ${qa.answer.score}, Confidence: ${qa.answer.confidence}%)
Answer: ${qa.answer.answer}`;
  }).join('\n\n---\n\n');
  
  const prompt = `You are synthesizing municipal environmental protection best practices. Based on the following top-scoring municipality responses to the question "${questionText}", create a comprehensive best practice summary.

TOP MUNICIPALITY RESPONSES:
${municipalityData}

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
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 200
    });
    
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

async function loadAllAnalyses(domainId: string, realm?: string): Promise<Analysis[]> {
  // Determine data directory based on realm
  let dataDir = await getDataDir();
  
  // Load realms configuration to get the correct datapath
  if (realm) {
    try {
      const realmsPath = await getRealmsPath();
      if (fs.existsSync(realmsPath)) {
        const realmsData = JSON.parse(fs.readFileSync(realmsPath, "utf-8"));
        const realmConfig = realmsData.realms?.find(r => r.id === realm);
        if (realmConfig && realmConfig.datapath) {
          dataDir = await getRealmDataDir(realmConfig.datapath);
          console.log(`🏛️  Using data directory for realm ${realm}: ${dataDir}`);
        }
      }
    } catch (error) {
      console.warn(`⚠️  Could not load realm configuration, using default data directory:`, error.message);
    }
  }
  
  const domainDir = path.join(dataDir, domainId);
  
  if (!fs.existsSync(domainDir)) {
    throw new Error(`Domain directory not found: ${domainDir}`);
  }
  
  // Load municipalities data for proper display names
  const municipalitiesPath = 'data/municipalities.json';
  let municipalitiesData: {municipalities: Array<{id: string, displayName: string}>} = {municipalities: []};
  
  if (fs.existsSync(municipalitiesPath)) {
    try {
      municipalitiesData = JSON.parse(fs.readFileSync(municipalitiesPath, 'utf8'));
    } catch (error) {
      console.warn('⚠️  Could not load municipalities.json, using analysis displayNames');
    }
  }

  const analyses: Analysis[] = [];
  const entries = fs.readdirSync(domainDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('NY-')) continue;
    
    const municipalityDir = path.join(domainDir, entry.name);
    const analysisPath = path.join(municipalityDir, 'analysis.json');
    
    if (!fs.existsSync(analysisPath)) {
      console.log(`⏭️  Skipping ${entry.name} - no analysis.json`);
      continue;
    }
    
    try {
      const analysis: Analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
      
      // Fix municipality displayName if it's undefined or contains "Unknown"
      const municipalityInfo = municipalitiesData.municipalities.find(m => m.id === analysis.municipality.id);
      if (municipalityInfo && (!analysis.municipality.displayName || analysis.municipality.displayName.includes('undefined') || analysis.municipality.displayName.includes('Unknown'))) {
        analysis.municipality.displayName = municipalityInfo.displayName;
        console.log(`🔧 Fixed displayName for ${analysis.municipality.id}: "${analysis.municipality.displayName}" -> "${municipalityInfo.displayName}"`);
      }
      if (analysis.questions && analysis.questions.length > 0) {
        analyses.push(analysis);
        console.log(`📄 Loaded ${analysis.municipality.displayName} (${analysis.questions.length} questions)`);
      }
    } catch (error) {
      console.warn(`⚠️  Error loading analysis for ${entry.name}:`, error);
    }
  }
  
  return analyses;
}

async function findBestPracticesForQuestion(questionId: number, analyses: Analysis[]): Promise<BestPractice | null> {
  const questionAnswers: Array<{
    municipality: Analysis['municipality'];
    answer: AnalysisAnswer;
  }> = [];
  
  let questionText = '';
  
  // Collect all answers for this question across municipalities
  for (const analysis of analyses) {
    const question = analysis.questions.find(q => q.id === questionId);
    if (question) {
      questionText = question.question;
      questionAnswers.push({
        municipality: analysis.municipality,
        answer: question
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
      
      return {
        questionId,
        question: questionText,
        bestMunicipality: best.municipality,
        bestAnswer: await condenseAnswerToEssence(best.answer.answer, questionText),
        bestScore: 0.5, // Moderate score since it's rare
        supportingExamples: [{
          municipality: best.municipality,
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
  
  // Generate concise common gaps (most frequent improvement needs)
  const gapTypes = new Map<string, number>();
  
  questionAnswers.forEach(qa => {
    if (qa.answer.score < 1.0) {
      // Extract improvement categories from gaps
      if (qa.answer.gap) {
        const gap = qa.answer.gap.toLowerCase();
        if (gap.includes('penalty') || gap.includes('fine')) {
          gapTypes.set('Higher penalties needed', (gapTypes.get('Higher penalties needed') || 0) + 1);
        }
        if (gap.includes('arborist') || gap.includes('professional')) {
          gapTypes.set('Professional consultation required', (gapTypes.get('Professional consultation required') || 0) + 1);
        }
        if (gap.includes('replacement') || gap.includes('replant')) {
          gapTypes.set('Mandatory replacement standards', (gapTypes.get('Mandatory replacement standards') || 0) + 1);
        }
        if (gap.includes('permit') || gap.includes('application')) {
          gapTypes.set('Permit process improvements', (gapTypes.get('Permit process improvements') || 0) + 1);
        }
        if (gap.includes('notification') || gap.includes('neighbor')) {
          gapTypes.set('Neighbor notification requirements', (gapTypes.get('Neighbor notification requirements') || 0) + 1);
        }
        if (gap.includes('enforcement') || gap.includes('mechanism')) {
          gapTypes.set('Enforcement mechanisms', (gapTypes.get('Enforcement mechanisms') || 0) + 1);
        }
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
  const supportingExamples = top5Answers.slice(0, 3).map(example => ({
    municipality: example.municipality,
    score: example.answer.score,
    confidence: example.answer.confidence
  }));

  return {
    questionId,
    question: questionText,
    bestAnswer: synthesizedAnswer,
    bestScore: best.answer.score,
    bestMunicipality: best.municipality,
    quantitativeHighlights: uniqueQuantitativeData,
    supportingExamples, // Up to 3 municipal references
    commonGaps
  };
}

async function generateMetaAnalysis(domainId: string = 'trees', realm?: string): Promise<void> {
  console.log(`🚀 Generating meta-analysis for ${domainId} domain...`);
  
  // Load all analyses
  const analyses = await loadAllAnalyses(domainId, realm);
  console.log(`📊 Loaded ${analyses.length} municipality analyses`);
  
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
  
  const totalScore = validAnalyses.reduce((sum, analysis) => sum + analysis.overallScore, 0);
  const averageScore = totalScore / validAnalyses.length;
  
  const highestScoring = validAnalyses.reduce((best, current) => 
    current.overallScore > best.overallScore ? current : best
  );
  
  // Find unique questions across all analyses
  const questionIds = new Set<number>();
  analyses.forEach(analysis => {
    analysis.questions.forEach(q => questionIds.add(q.id));
  });
  
  console.log(`📝 Processing ${questionIds.size} unique questions...`);
  
  // Generate best practices for each question
  const bestPractices: BestPractice[] = [];
  for (const questionId of Array.from(questionIds).sort()) {
    const bestPractice = await findBestPracticesForQuestion(questionId, analyses);
    if (bestPractice) {
      bestPractices.push(bestPractice);
      console.log(`✅ Q${questionId}: Synthesized best practice from top municipalities (best: ${bestPractice.bestMunicipality.displayName}, score: ${bestPractice.bestScore.toFixed(1)})`);
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
    .filter(a => a.overallScore >= averageScore * 1.1)
    .sort((a, b) => b.overallScore - a.overallScore)
    .slice(0, 5)
    .map(a => a.municipality.displayName);
  
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
      displayName: analyses[0]?.domain.displayName || domainId
    },
    analysisDate: new Date().toISOString(),
    totalMunicipalitiesAnalyzed: analyses.length,
    averageScore: Number(averageScore.toFixed(2)),
    highestScoringMunicipality: {
      id: highestScoring.municipality.id,
      displayName: highestScoring.municipality.displayName,
      score: Number(highestScoring.overallScore.toFixed(2))
    },
    bestPractices,
    overallRecommendations: {
      commonWeaknesses,
      keyImprovements,
      modelMunicipalities
    },
    version: "1.0"
  };
  
  // Save meta-analysis using the same dataDir logic
  let saveDataDir = await getDataDir();
  if (realm) {
    try {
      const realmsPath = await getRealmsPath();
      if (fs.existsSync(realmsPath)) {
        const realmsData = JSON.parse(fs.readFileSync(realmsPath, "utf-8"));
        const realmConfig = realmsData.realms?.find(r => r.id === realm);
        if (realmConfig && realmConfig.datapath) {
          saveDataDir = await getRealmDataDir(realmConfig.datapath);
        }
      }
    } catch (error) {
      console.warn(`⚠️  Could not determine save path, using default data directory`);
    }
  }
  
  const outputPath = path.join(saveDataDir, domainId, 'meta-analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(metaAnalysis, null, 2));
  
  console.log(`\n🎉 Meta-analysis complete!`);
  console.log(`📁 Saved to: ${outputPath}`);
  console.log(`📊 Analyzed ${analyses.length} municipalities`);
  console.log(`🏆 Best overall: ${highestScoring.municipality.displayName} (${highestScoring.overallScore.toFixed(1)})`);
  console.log(`📈 Average score: ${averageScore.toFixed(2)}`);
  console.log(`⭐ ${bestPractices.length} best practices identified`);
  console.log(`🎯 ${modelMunicipalities.length} model municipalities found`);
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const domainId = process.argv[2] || 'trees';
  
  generateMetaAnalysis(domainId)
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Meta-analysis generation failed:', error);
      process.exit(1);
    });
}

export { generateMetaAnalysis, findBestPracticesForQuestion };