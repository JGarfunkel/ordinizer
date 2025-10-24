#!/usr/bin/env tsx

import fs from "fs/promises";
import path from "path";
import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";

// Centralized path resolver to work from any directory
class PathResolver {
  private static _projectRoot: string | null = null;

  static async getProjectRoot(): Promise<string> {
    if (this._projectRoot) {
      return this._projectRoot;
    }

    // Start from current working directory and walk up to find project root
    let currentDir = process.cwd();

    while (currentDir !== path.dirname(currentDir)) {
      // Check for package.json as project root marker
      const packageJsonPath = path.join(currentDir, "package.json");
      try {
        await fs.access(packageJsonPath);
        this._projectRoot = currentDir;
        return currentDir;
      } catch {
        // Continue searching
      }

      currentDir = path.dirname(currentDir);
    }

    // Fallback: assume current directory is project root
    this._projectRoot = process.cwd();
    return this._projectRoot;
  }

  static async getDataDir(): Promise<string> {
    const projectRoot = await this.getProjectRoot();
    return path.join(projectRoot, "data");
  }

  static async getRealmsPath(): Promise<string> {
    const projectRoot = await this.getProjectRoot();
    return path.join(projectRoot, "data", "realms.json");
  }

  static async getRealmDataDir(realmDatapath: string): Promise<string> {
    const projectRoot = await this.getProjectRoot();
    return path.join(projectRoot, "data", realmDatapath);
  }

  static async getOrdinizerRoot(): Promise<string> {
    const projectRoot = await this.getProjectRoot();
    // Check if we're in the ordinizer subdirectory or at workspace root
    const ordinizerPath = path.join(projectRoot, "ordinizer");
    try {
      await fs.access(ordinizerPath);
      return ordinizerPath;
    } catch {
      // Assume we're already in ordinizer directory
      return projectRoot;
    }
  }

  static async getAIModelsPath(): Promise<string> {
    const ordinizerRoot = await this.getOrdinizerRoot();
    return path.join(ordinizerRoot, "AI-models.json");
  }
}

// Initialize clients
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

interface AnalyzeOptions {
  domain?: string;
  municipality?: string;
  realm?: string; // Target realm for analysis
  force?: boolean;
  reindex?: boolean; // New: Re-upload statute chunks to Pinecone vector database
  verbose?: boolean;
  fixOrder?: boolean;
  setGrades?: boolean;
  useMeta?: boolean; // New: Compare against meta-analysis ideal answers
  generateMeta?: boolean; // New: Generate meta-analysis after completing analysis
  model?: "gpt-4o-mini" | "gpt-4-turbo"; // Model selection for testing
  questionId?: string; // New: Analyze only specific question ID
  skipRecent?: string; // New: Skip analysis if generated within specified time (e.g., "15m", "2h", "1d")
  generateScoreOnly?: boolean; // New: Only calculate and update normalized scores without re-analyzing
}

// Global verbose flag
let VERBOSE = false;

// Rate limiting globals
interface TokenUsage {
  timestamp: number;
  tokens: number;
}

let tokenUsageHistory: TokenUsage[] = [];
let currentModel = "gpt-4o-mini";
let modelConfig: any = null;
const QUESTION_PAUSE_MS = 200; // 200ms pause between questions

// Load AI models configuration
async function loadModelConfig() {
  if (!modelConfig) {
    try {
      const configPath = await PathResolver.getAIModelsPath();
      const configContent = await fs.readFile(configPath, "utf-8");
      modelConfig = JSON.parse(configContent);
    } catch (error) {
      console.warn("Could not load AI-models.json, using default rate limits");
      modelConfig = {
        models: {
          "gpt-4o": { tokensPerMinute: 30000 },
          "gpt-4o-mini": { tokensPerMinute: 200000 },
          "gpt-5": { tokensPerMinute: 30000 },
          "gpt-5-mini": { tokensPerMinute: 200000 },
          "gpt-4-turbo": { tokensPerMinute: 30000 },
        },
      };
    }
  }
  return modelConfig;
}

// Get current model's rate limit
function getModelRateLimit(): number {
  const config = modelConfig?.models?.[currentModel];
  return config?.tokensPerMinute || 30000; // Default fallback
}
const QUESTION_SET_PAUSE_MS = 1000; // 1s pause between sets of questions

// Verbose logging helper
function log(message: string, ...args: any[]) {
  if (VERBOSE) {
    console.log(`[VERBOSE] ${message}`, ...args);
  }
}

/**
 * Handle reindexing when analysis is skipped but --reindex flag is used
 */
async function handleReindexOnly(
  municDir: string,
  municipality: string,
  domain: string,
  index: any,
  options: AnalyzeOptions = {},
) {
  console.log(`🔄 ${municipality}: Reindexing documents in vector database...`);
  
  // Determine file name based on realm type
  let documentFileName = "statute.txt";
  if (options.realm && options.realm.includes("school")) {
    documentFileName = "policy.txt";
  }
  
  const statutePath = path.join(municDir, documentFileName);
  if (await fileExists(statutePath)) {
    const statute = await fs.readFile(statutePath, "utf-8");
    await indexDocumentInPinecone(statute, municipality, domain, index, "statute");
    
    // Load and index additional sources
    const additionalSources = await loadAdditionalSources(municDir);
    if (additionalSources.guidance) {
      await indexDocumentInPinecone(additionalSources.guidance, municipality, domain, index, "guidance");
    }
    
    console.log(`✅ ${municipality}: Reindexing complete`);
  }
}

/**
 * Load additional source files (guidance.txt, form.txt) from municipality directory
 */
async function loadAdditionalSources(municDir: string): Promise<{
  guidance?: string;
  form?: string;
}> {
  const additionalSources: { guidance?: string; form?: string } = {};
  
  // Try to load guidance.txt
  const guidancePath = path.join(municDir, "guidance.txt");
  if (await fileExists(guidancePath)) {
    try {
      additionalSources.guidance = await fs.readFile(guidancePath, "utf-8");
      log(`📋 Loaded guidance.txt (${additionalSources.guidance.length} chars)`);
    } catch (error) {
      log(`⚠️  Could not load guidance.txt: ${error.message}`);
    }
  }
  
  // Try to load form.txt
  const formPath = path.join(municDir, "form.txt");
  if (await fileExists(formPath)) {
    try {
      additionalSources.form = await fs.readFile(formPath, "utf-8");
      log(`📋 Loaded form.txt (${additionalSources.form.length} chars)`);
    } catch (error) {
      log(`⚠️  Could not load form.txt: ${error.message}`);
    }
  }
  
  return additionalSources;
}

// Token estimation function
function estimateTokens(text: string): number {
  // Rough estimation: ~4 characters per token for GPT models
  return Math.ceil(text.length / 4);
}

// Check if we need to pause based on token usage
async function checkRateLimit(estimatedTokens: number): Promise<void> {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;

  // Remove old entries (older than 1 minute)
  tokenUsageHistory = tokenUsageHistory.filter(
    (usage) => usage.timestamp > oneMinuteAgo,
  );

  // Calculate current usage in the last minute
  const currentUsage = tokenUsageHistory.reduce(
    (sum, usage) => sum + usage.tokens,
    0,
  );

  // Check if adding this request would exceed the limit
  const rateLimit = getModelRateLimit();
  if (currentUsage + estimatedTokens > rateLimit) {
    const oldestEntry = tokenUsageHistory[0];
    const waitTime = oldestEntry ? oldestEntry.timestamp + 60000 - now : 60000;

    if (waitTime > 0) {
      console.log(
        `⏳ Rate limit approached for ${currentModel}. Used: ${currentUsage}, Estimated: ${estimatedTokens}, Limit: ${rateLimit}`,
      );
      console.log(
        `⏳ Waiting ${(waitTime / 1000).toFixed(1)}s before next API call...`,
      );
      await sleep(waitTime);

      // Clear old entries after waiting
      const newNow = Date.now();
      tokenUsageHistory = tokenUsageHistory.filter(
        (usage) => usage.timestamp > newNow - 60000,
      );
    }
  }
}

// Record token usage
function recordTokenUsage(tokens: number): void {
  tokenUsageHistory.push({
    timestamp: Date.now(),
    tokens,
  });
}

// Get current total token usage
function getCurrentTokenUsage(): number {
  return tokenUsageHistory.reduce((total, usage) => total + usage.tokens, 0);
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Load meta-analysis for comparison
async function loadMetaAnalysis(
  domainId: string,
  dataDir: string = "data",
): Promise<any> {
  const metaPath = path.join(dataDir, domainId, "meta-analysis.json");
  try {
    if (await fileExists(metaPath)) {
      const content = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(content);
    }
  } catch (error) {
    log(`Could not load meta-analysis for ${domainId}:`, error.message);
  }
  return null;
}

// Add meta-analysis comparison to existing analysis
async function addMetaAnalysisComparison(
  analysis: any,
  metaAnalysis: any,
  municipalityId: string,
): Promise<any> {
  const updatedQuestions = analysis.questions.map((question: any) => {
    // Find the corresponding best practice from meta-analysis
    const bestPractice = metaAnalysis.bestPractices?.find(
      (bp) => bp.questionId === question.id,
    );

    if (bestPractice) {
      // Add comparison to the ideal answer
      const comparedToIdeal = {
        idealAnswer: bestPractice.bestAnswer,
        idealScore: bestPractice.bestScore,
        idealMunicipality: bestPractice.bestMunicipality.displayName,
        currentScore: question.score || 0,
        performanceGap: bestPractice.bestScore - (question.score || 0),
        improvementSuggestions: bestPractice.improvementRecommendations || [],
      };

      return {
        ...question,
        metaComparison: comparedToIdeal,
      };
    }

    return question;
  });

  // Add meta-analysis summary
  const metaSummary = {
    comparedAgainst: metaAnalysis.version,
    analysisDate: metaAnalysis.analysisDate,
    totalMunicipalitiesInMeta: metaAnalysis.totalMunicipalitiesAnalyzed,
    averageScoreAcrossMunicipalities: metaAnalysis.averageScore,
    rankingPosition: null, // Could be calculated if needed
  };

  return {
    ...analysis,
    questions: updatedQuestions,
    metaAnalysisSummary: metaSummary,
    processingMethod: analysis.processingMethod + "-with-meta-comparison",
  };
}

// Function to detect if content is HTML
function isHtmlContent(content: string): boolean {
  // Check for common HTML tags and patterns
  const htmlPatterns = [
    /<html[^>]*>/i,
    /<head[^>]*>/i,
    /<body[^>]*>/i,
    /<div[^>]*>/i,
    /<p[^>]*>/i,
    /<script[^>]*>/i,
    /<style[^>]*>/i,
    /<meta[^>]*>/i,
    /<title[^>]*>/i,
    /<link[^>]*>/i,
    /<!DOCTYPE\s+html/i,
    /<[a-z][a-z0-9]*[^<>]*>/i, // Generic HTML tag pattern
  ];

  // Check if content starts with HTML-like structure
  const trimmedContent = content.trim();
  if (
    trimmedContent.startsWith("<!DOCTYPE") ||
    trimmedContent.startsWith("<html") ||
    trimmedContent.startsWith("<HTML")
  ) {
    return true;
  }

  // Count HTML tag occurrences
  let htmlTagCount = 0;
  for (const pattern of htmlPatterns) {
    const matches = content.match(pattern);
    if (matches) {
      htmlTagCount += matches.length;
    }
  }

  // If we find more than 3 HTML tags, it's likely HTML content
  return htmlTagCount > 3;
}

// Order answers according to questions.json order
function orderAnswersByQuestions(
  questions: any[],
  existingAnswers: any[],
  newAnswers: any[],
): any[] {
  // Create a map of all available answers by ID
  const answersMap = new Map();

  // Add existing answers with safety check
  (existingAnswers || []).forEach((answer) => {
    answersMap.set(answer.id, answer);
  });

  // Add new answers (will overwrite if same ID) with safety check
  (newAnswers || []).forEach((answer) => {
    answersMap.set(answer.id, answer);
  });

  // Order according to questions.json sequence with safety check
  const orderedAnswers: any[] = [];
  for (const question of questions || []) {
    if (answersMap.has(question.id)) {
      orderedAnswers.push(answersMap.get(question.id));
    }
  }

  log(
    `Ordered ${orderedAnswers.length} answers according to questions.json sequence`,
  );
  return orderedAnswers;
}

// Set grades from metadata.json to analysis.json files
async function setGradesFromMetadata(options: AnalyzeOptions) {
  // Determine data directory based on realm
  let dataDir = await PathResolver.getDataDir();

  // Load realms configuration to get the correct datapath
  if (options.realm) {
    try {
      const realmsPath = await PathResolver.getRealmsPath();
      if (await fileExists(realmsPath)) {
        const realmsData = JSON.parse(await fs.readFile(realmsPath, "utf-8"));
        const realmConfig = realmsData.realms?.find(
          (r) => r.id === options.realm,
        );
        if (realmConfig && realmConfig.datapath) {
          dataDir = await PathResolver.getRealmDataDir(realmConfig.datapath);
          console.log("Using data directory for realm:", realmConfig.datapath);
        }
      }
    } catch (error) {
      log(
        `Could not load realm configuration for setGradesFromMetadata:`,
        error.message,
      );
    }
  }
  const domains = options.domain
    ? [options.domain]
    : await getDomainDirectories(dataDir);

  let totalUpdated = 0;
  let totalProcessed = 0;

  for (const domain of domains) {
    console.log(`\n📁 Processing domain: ${domain}`);
    const domainDir = path.join(dataDir, domain);

    if (!(await directoryExists(domainDir))) {
      console.log(`⚠️  Domain directory not found: ${domainDir}`);
      continue;
    }

    // Get realm type for proper directory filtering
    let realmType = "statute"; // default
    if (options.realm) {
      try {
        const realmsPath = await PathResolver.getRealmsPath();
        if (await fileExists(realmsPath)) {
          const realmsData = JSON.parse(await fs.readFile(realmsPath, "utf-8"));
          const realmConfig = realmsData.realms?.find(
            (r) => r.id === options.realm,
          );
          if (realmConfig && realmConfig.type) {
            realmType = realmConfig.type;
          }
        }
      } catch (error) {
        log(
          `Could not determine realm type in setGradesFromMetadata:`,
          error.message,
        );
      }
    }

    const allMunicipalityDirs = await getMunicipalityDirectories(
      domainDir,
      realmType,
    );
    const municipalityDirs = options.municipality
      ? allMunicipalityDirs.filter((dir) =>
          dir.toLowerCase().includes(options.municipality!.toLowerCase()),
        )
      : allMunicipalityDirs;

    for (const municipalityDir of municipalityDirs) {
      totalProcessed++;
      const fullMunicipalityPath = path.join(domainDir, municipalityDir);
      const metadataPath = path.join(fullMunicipalityPath, "metadata.json");
      const analysisPath = path.join(fullMunicipalityPath, "analysis.json");

      if (!(await fileExists(metadataPath))) {
        console.log(`⚠️  No metadata.json found for ${municipalityDir}`);
        continue;
      }

      if (!(await fileExists(analysisPath))) {
        console.log(`⚠️  No analysis.json found for ${municipalityDir}`);
        continue;
      }

      try {
        const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
        const analysis = JSON.parse(await fs.readFile(analysisPath, "utf-8"));

        // Extract grade from metadata
        let grade = null;
        if (metadata.originalCellValue) {
          // Extract grade prefix (like "G-", "R-", "Y+") from originalCellValue
          const gradeMatch = metadata.originalCellValue.match(/^([GRY][+-]?)/i);
          if (gradeMatch) {
            grade = gradeMatch[1].toUpperCase();
          }
        } else if (metadata.grade) {
          grade = metadata.grade;
        }

        if (!grade) {
          console.log(`⚠️  No grade found in metadata for ${municipalityDir}`);
          continue;
        }

        // Update analysis.json with grade
        if (!analysis.grades) {
          analysis.grades = {};
        }

        const previousGrade = analysis.grades.WEN;
        analysis.grades.WEN = grade;

        // Write updated analysis
        await fs.writeFile(analysisPath, JSON.stringify(analysis, null, 2));

        console.log(
          `✅ Updated ${municipalityDir}: ${previousGrade || "none"} → ${grade}`,
        );
        totalUpdated++;
      } catch (error) {
        console.error(`❌ Error processing ${municipalityDir}:`, error);
      }
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Processed: ${totalProcessed} municipalities`);
  console.log(`   Updated: ${totalUpdated} grades`);
}

// Fix question order in existing analysis.json files
async function fixQuestionOrder(options: AnalyzeOptions) {
  // Determine data directory based on realm
  let dataDir = await PathResolver.getDataDir();

  // Load realms configuration to get the correct datapath
  if (options.realm) {
    try {
      const realmsPath = await PathResolver.getRealmsPath();
      if (await fileExists(realmsPath)) {
        const realmsData = JSON.parse(await fs.readFile(realmsPath, "utf-8"));
        const realmConfig = realmsData.realms?.find(
          (r) => r.id === options.realm,
        );
        if (realmConfig && realmConfig.datapath) {
          dataDir = await PathResolver.getRealmDataDir(realmConfig.datapath);
        }
      }
    } catch (error) {
      log(
        `Could not load realm configuration for fixQuestionOrder:`,
        error.message,
      );
    }
  }
  const domains = options.domain
    ? [options.domain]
    : await getDomainDirectories(dataDir);

  let totalFixed = 0;
  let totalProcessed = 0;

  for (const domain of domains) {
    console.log(`\n📁 Processing domain: ${domain}`);
    const domainDir = path.join(dataDir, domain);

    if (!(await directoryExists(domainDir))) {
      console.log(`⚠️  Domain directory ${domain} not found, skipping`);
      continue;
    }

    // Load questions for this domain
    const questionsPath = path.join(domainDir, "questions.json");
    if (!(await fileExists(questionsPath))) {
      console.log(`⚠️  Questions file not found for ${domain}, skipping`);
      continue;
    }

    const questionsData = JSON.parse(await fs.readFile(questionsPath, "utf-8"));
    // Handle both array format and object format for questions
    const questions = Array.isArray(questionsData)
      ? questionsData
      : questionsData.questions || [];

    // Get realm type for proper directory filtering
    let realmType = "statute"; // default
    if (options.realm) {
      try {
        const realmsPath = await PathResolver.getRealmsPath();
        if (await fileExists(realmsPath)) {
          const realmsData = JSON.parse(await fs.readFile(realmsPath, "utf-8"));
          const realmConfig = realmsData.realms?.find(
            (r) => r.id === options.realm,
          );
          if (realmConfig && realmConfig.type) {
            realmType = realmConfig.type;
          }
        }
      } catch (error) {
        log(
          `Could not determine realm type in fixQuestionOrder:`,
          error.message,
        );
      }
    }

    // Get municipalities to process
    const municipalities = options.municipality
      ? [options.municipality]
      : await getMunicipalityDirectories(domainDir, realmType);

    for (const municipality of municipalities) {
      const analysisPath = path.join(domainDir, municipality, "analysis.json");

      if (!(await fileExists(analysisPath))) {
        log(`Analysis file not found for ${municipality}, skipping`);
        continue;
      }

      totalProcessed++;

      try {
        const analysisData = JSON.parse(
          await fs.readFile(analysisPath, "utf-8"),
        );
        const existingQuestions = analysisData.questions || [];

        if (existingQuestions.length === 0) {
          log(`No questions in analysis for ${municipality}, skipping`);
          continue;
        }

        // Re-order questions according to questions.json order
        const reorderedQuestions = orderAnswersByQuestions(
          questions,
          existingQuestions,
          [],
        );

        // Check if order actually changed
        const orderChanged =
          JSON.stringify(existingQuestions.map((q) => q.id)) !==
          JSON.stringify(reorderedQuestions.map((q) => q.id));

        if (orderChanged) {
          analysisData.questions = reorderedQuestions;
          analysisData.lastUpdated = new Date().toISOString();

          await fs.writeFile(
            analysisPath,
            JSON.stringify(analysisData, null, 2),
            "utf-8",
          );
          console.log(
            `✅ ${municipality}: Fixed question order (${reorderedQuestions.length} questions)`,
          );
          totalFixed++;
        } else {
          log(`${municipality}: Question order already correct`);
        }
      } catch (error) {
        console.error(
          `❌ ${municipality}: Error fixing order - ${error.message}`,
        );
      }
    }
  }

  console.log(`\n🎉 Question order fix complete!`);
  console.log(
    `📊 Processed ${totalProcessed} analysis files, fixed ${totalFixed} files`,
  );
}

// Intelligent question comparison function
function compareQuestions(
  newQuestions: any[],
  existingAnswers: any[],
  municipality: string,
  specificQuestionId?: string,
): {
  questionsToAnalyze: any[];
  questionsToKeep: any[];
  questionsToRemove: any[];
} {
  const questionsToAnalyze: any[] = [];
  const questionsToKeep: any[] = [];
  const questionsToRemove: any[] = [];

  // Create maps for efficient lookup with safety checks
  const newQuestionsMap = new Map(newQuestions?.map((q) => [q.id, q]) || []);
  const existingAnswersMap = new Map(
    existingAnswers?.map((a) => [a.id, a]) || [],
  );

  console.log(
    `📊 ${municipality}: Comparing ${newQuestions?.length || 0} current questions with ${existingAnswers?.length || 0} existing answers`,
  );

  // Check each new question with safety check
  for (const newQuestion of newQuestions || []) {
    const existingAnswer = existingAnswersMap.get(newQuestion.id);

    // If specific question ID is provided, only process that question
    if (
      specificQuestionId &&
      newQuestion.id.toString() !== specificQuestionId
    ) {
      if (existingAnswer) {
        questionsToKeep.push(existingAnswer);
        log(
          `✅ ${municipality}: Question ${newQuestion.id} skipped (not target question), keeping existing answer`,
        );
      }
      continue;
    }

    if (!existingAnswer) {
      // New question - needs analysis
      questionsToAnalyze.push(newQuestion);
      const questionText = newQuestion.question || "No question text";
      console.log(
        `➕ ${municipality}: New question ${newQuestion.id}: "${questionText.substring(0, 50)}..."`,
      );
    } else if (
      existingAnswer.question !== newQuestion.question ||
      specificQuestionId
    ) {
      // Question wording changed OR specific question ID requested - needs re-analysis
      questionsToAnalyze.push(newQuestion);
      if (specificQuestionId) {
        console.log(
          `🎯 ${municipality}: Targeting question ${newQuestion.id} for re-analysis`,
        );
      } else {
        console.log(
          `🔄 ${municipality}: Question ${newQuestion.id} wording changed, re-analyzing`,
        );
        const oldText = existingAnswer.question || "No question text";
        const newText = newQuestion.question || "No question text";
        log(`Old: "${oldText.substring(0, 80)}..."`);
        log(`New: "${newText.substring(0, 80)}..."`);
      }
    } else {
      // Question unchanged - keep existing answer
      questionsToKeep.push(existingAnswer);
      log(
        `✅ ${municipality}: Question ${newQuestion.id} unchanged, keeping existing answer`,
      );
    }
  }

  // Check for questions that exist in analysis but not in current questions with safety check
  for (const existingAnswer of existingAnswers || []) {
    if (!newQuestionsMap.has(existingAnswer.id)) {
      questionsToRemove.push(existingAnswer);
      const questionText = existingAnswer.question || "No question text";
      console.log(
        `🗑️  ${municipality}: Removing obsolete question ${existingAnswer.id}: "${questionText.substring(0, 50)}..."`,
      );
    }
  }

  const summary = {
    toAnalyze: questionsToAnalyze.length,
    toKeep: questionsToKeep.length,
    toRemove: questionsToRemove.length,
  };

  console.log(
    `📈 ${municipality}: Analysis plan - ${summary.toAnalyze} to analyze, ${summary.toKeep} to keep, ${summary.toRemove} to remove`,
  );

  return {
    questionsToAnalyze,
    questionsToKeep,
    questionsToRemove,
  };
}

async function analyzeStatutes(options: AnalyzeOptions = {}) {
  const { generateMetaAnalysis } = await import(
    "../app/server/lib/createMetaAnalysis.js"
  );
  VERBOSE = options.verbose || false;

  // Load model configuration first
  await loadModelConfig();

  // Set current model if specified in options
  if (options.model) {
    currentModel = options.model;
    const modelInfo = modelConfig.models[currentModel];
    console.log(
      `🤖 Using AI model: ${currentModel} (${modelInfo?.tokensPerMinute || "unknown"} TPM)`,
    );
  }

  if (options.fixOrder) {
    console.log(`🔧 Fixing question order in existing analysis.json files`);
    await fixQuestionOrder(options);
    return;
  }

  if (options.generateScoreOnly) {
    console.log(`🧮 Generating normalized scores for existing analysis files`);
    await generateScoresOnly(options);
    return;
  }

  if (options.setGrades) {
    console.log(
      `📊 Setting WEN grades from metadata.json to analysis.json files`,
    );
    await setGradesFromMetadata(options);
    return;
  }

  const targetDescription = options.domain || "all domains";
  console.log(`🔍 Starting statute analysis for ${targetDescription}`);

  if (VERBOSE) {
    console.log(
      `[VERBOSE] Analysis options:`,
      JSON.stringify(options, null, 2),
    );
  }

  // Determine data directory based on realm
  let dataDir = await PathResolver.getDataDir();

  // Load realms configuration to get the correct datapath
  if (options.realm) {
    try {
      const realmsPath = await PathResolver.getRealmsPath();
      if (await fileExists(realmsPath)) {
        const realmsData = JSON.parse(await fs.readFile(realmsPath, "utf-8"));
        const realmConfig = realmsData.realms?.find(
          (r) => r.id === options.realm,
        );
        if (realmConfig && realmConfig.datapath) {
          dataDir = await PathResolver.getRealmDataDir(realmConfig.datapath);
          console.log(
            `🏛️  Using data directory for realm ${options.realm}: ${dataDir}`,
          );
        }
      }
    } catch (error) {
      log(
        `Could not load realm configuration, using default data directory:`,
        error.message,
      );
    }
  }

  const domains = options.domain
    ? [options.domain]
    : await getDomainDirectories(dataDir);

  log(`Found ${domains.length} domains to process:`, domains);

  for (const domain of domains) {
    console.log(`\n📁 Processing domain: ${domain}`);

    const domainDir = path.join(dataDir, domain);
    log(`Checking domain directory: ${domainDir}`);

    if (!(await directoryExists(domainDir))) {
      console.log(`⚠️  Domain directory ${domain} not found, skipping`);
      continue;
    }

    // Generate questions if they don't exist
    await generateQuestionsIfNeeded(domainDir, domain);

    // Get realm type for proper directory filtering
    let realmType = "statute"; // default
    if (options.realm) {
      try {
        const realmsPath = await PathResolver.getRealmsPath();
        if (await fileExists(realmsPath)) {
          const realmsData = JSON.parse(await fs.readFile(realmsPath, "utf-8"));
          const realmConfig = realmsData.realms?.find(
            (r) => r.id === options.realm,
          );
          if (realmConfig && realmConfig.type) {
            realmType = realmConfig.type;
          }
        }
      } catch (error) {
        log(`Could not determine realm type in main analysis:`, error.message);
      }
    }

    // Get municipalities to process
    const municipalities = options.municipality
      ? [options.municipality]
      : await getMunicipalityDirectories(domainDir, realmType);

    log(
      `Found ${municipalities.length} municipalities in ${domain}:`,
      municipalities,
    );

    // Initialize Pinecone index
    const indexName = "ordinizer-statutes";
    log(`Initializing Pinecone index: ${indexName}`);

    // Check if index exists, create if it doesn't
    const indexes = await pinecone.listIndexes();
    const indexExists = indexes.indexes?.some((idx) => idx.name === indexName);

    if (!indexExists) {
      console.log(`📝 Creating Pinecone index: ${indexName}`);
      await pinecone.createIndex({
        name: indexName,
        dimension: 1536, // OpenAI text-embedding-ada-002 dimension
        metric: "cosine",
        spec: {
          serverless: {
            cloud: "aws",
            region: "us-east-1",
          },
        },
      });

      // Wait a moment for index to be ready
      console.log(`⏳ Waiting for index to be ready...`);
      await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 second wait
      log(`Index ${indexName} created and ready`);
    } else {
      log(`Index ${indexName} already exists`);
    }

    const index = pinecone.index(indexName);

    for (let i = 0; i < municipalities.length; i++) {
      const municipality = municipalities[i];
      const madeOpenAICalls = await processMunicipality(
        domainDir,
        domain,
        municipality,
        index,
        options.force,
        options.useMeta,
        options.questionId,
        options.skipRecent,
        options.realm,
        options,
      );

      // Add pause between municipalities only if OpenAI calls were made
      if (i < municipalities.length - 1 && madeOpenAICalls) {
        // Don't pause after the last municipality or if no API calls
        console.log(
          `⏳ Pausing ${QUESTION_SET_PAUSE_MS}ms before next municipality...`,
        );
        await sleep(QUESTION_SET_PAUSE_MS);
      }
    }
  }

  console.log("\n🎉 Statute analysis complete!");

  // Generate meta-analysis if requested
  if (options.generateMeta) {
    const targetDomain = options.domain;
    if (!targetDomain) {
      console.error(
        "❌ Meta-analysis generation requires a specific domain to be targeted.",
      );
    } else {
      console.log(`🔍 Generating meta-analysis for ${targetDomain} domain...`);
      try {
        await generateMetaAnalysis(targetDomain, options.realm);
        console.log(
          `🎉 Meta-analysis generated successfully for ${targetDomain}!`,
        );
      } catch (error) {
        console.error(
          `❌ Failed to generate meta-analysis for ${targetDomain}:`,
          error,
        );
      }
    }
  }
}

async function generateQuestionsIfNeeded(domainDir: string, domain: string) {
  const questionsPath = path.join(domainDir, "questions.json");
  log(`Checking for questions file: ${questionsPath}`);

  if (await fileExists(questionsPath)) {
    console.log(`✅ Questions already exist for ${domain}`);
    const questionsData = await fs.readFile(questionsPath, "utf-8");
    const questions = JSON.parse(questionsData);
    // Handle both array format and object format for questions
    const questionsArray = Array.isArray(questions)
      ? questions
      : questions.questions || [];
    log(`Loaded ${questionsArray.length} existing questions for ${domain}`);
    return;
  }

  const questions = [];

  const questionsData = {
    questions: questions.map((question, index) => ({
      id: (index + 1).toString(),
      question,
      category: "general",
    })),
  };

  await fs.writeFile(questionsPath, JSON.stringify(questionsData, null, 2));
  console.log(`✅ Generated ${questions.length} questions for ${domain}`);
}

async function processMunicipality(
  domainDir: string,
  domain: string,
  municipality: string,
  index: any,
  force: boolean = false,
  useMeta: boolean = false,
  questionId?: string,
  skipRecent?: string,
  realm?: string,
  options: AnalyzeOptions = {},
): Promise<boolean> {
  const municDir = path.join(domainDir, municipality);
  const analysisPath = path.join(municDir, "analysis.json");
  const metadataPath = path.join(municDir, "metadata.json");

  // Determine file name based on realm type (policy.txt for school realms, statute.txt for municipal)
  let documentFileName = "statute.txt"; // default for municipal realms

  // Check if this is a policy-based realm (like schools)
  if (realm && realm.includes("school")) {
    documentFileName = "policy.txt";
  }

  const statutePath = path.join(municDir, documentFileName);

  // Check if analysis should be skipped based on --skip-recent parameter
  if (
    !force &&
    skipRecent &&
    (await shouldSkipRecentAnalysis(analysisPath, skipRecent))
  ) {
    const timeAgo = await getTimeAgoString(analysisPath, skipRecent);
    console.log(
      `⏭️  ${municipality}: Analysis is recent (${timeAgo}), skipping due to --skip-recent ${skipRecent}`,
    );
    return false; // No OpenAI calls made
  }

  // Check if analysis exists and is recent, and if statute is newer than analysis
  if (!force && (await fileExists(analysisPath))) {
    const analysisStats = await fs.stat(analysisPath);
    const ageInDays =
      (Date.now() - analysisStats.mtime.getTime()) / (1000 * 60 * 60 * 24);

    // Check if analysis has empty questions (incomplete analysis)
    try {
      const existingAnalysis = JSON.parse(
        await fs.readFile(analysisPath, "utf-8"),
      );
      const hasEmptyQuestions =
        !existingAnalysis.questions || existingAnalysis.questions.length === 0;

      if (hasEmptyQuestions) {
        console.log(
          `🔄 ${municipality}: Analysis exists but has no questions, re-analyzing`,
        );
        log(
          `Analysis has ${existingAnalysis.questions?.length || 0} questions`,
        );
        // Continue with analysis - don't return here
      } else {
        // Check if questions.json has changed (need to check this early)
        let questionsChanged = false;
        try {
          const questionsPath = path.join(domainDir, "questions.json");
          if (await fileExists(questionsPath)) {
            const questionsData = JSON.parse(
              await fs.readFile(questionsPath, "utf-8"),
            );
            // Handle both array format and object format for questions
            const questionsArray = Array.isArray(questionsData)
              ? questionsData
              : questionsData.questions || [];
            const { questionsToAnalyze } = compareQuestions(
              questionsArray,
              existingAnalysis.questions || [],
              municipality,
              questionId, // Pass questionId for skip check
            );
            questionsChanged = questionsToAnalyze.length > 0;
          }
        } catch (error) {
          log(`Error checking questions changes: ${error.message}`);
          questionsChanged = true; // Force re-analysis if we can't check
        }

        if (questionsChanged) {
          console.log(
            `🔄 ${municipality}: Questions have changed, re-analyzing`,
          );
          // Continue with analysis - don't return here
        } else {
          // Check if statute.txt is newer than analysis.json
          if (await fileExists(statutePath)) {
            const statuteStats = await fs.stat(statutePath);
            const statuteNewer = statuteStats.mtime > analysisStats.mtime;

            if (statuteNewer) {
              console.log(
                `🔄 ${municipality}: Statute file is newer than analysis (statute: ${statuteStats.mtime.toISOString()}, analysis: ${analysisStats.mtime.toISOString()}), re-analyzing`,
              );
              log(`Statute modified: ${statuteStats.mtime.toISOString()}`);
              log(`Analysis modified: ${analysisStats.mtime.toISOString()}`);
              // Continue with analysis - don't return here
            } else if (!skipRecent && ageInDays < 30) {
              console.log(
                `⏭️  ${municipality}: Analysis is recent (${ageInDays.toFixed(1)} days old) and statute unchanged, skipping`,
              );
              
              // Handle reindexing even when analysis is skipped
              if (options.reindex) {
                await handleReindexOnly(municDir, municipality, domain, index, options);
              }
              
              return false; // No OpenAI calls made
            }
          } else if (!skipRecent && ageInDays < 30) {
            console.log(
              `⏭️  ${municipality}: Analysis is recent (${ageInDays.toFixed(1)} days old), skipping`,
            );
            
            // Handle reindexing even when analysis is skipped
            if (options.reindex) {
              await handleReindexOnly(municDir, municipality, domain, index, options);
            }
            
            return false; // No OpenAI calls made
          }
        }
      }
    } catch (error) {
      console.log(
        `🔄 ${municipality}: Analysis file is corrupted or unreadable, re-analyzing`,
      );
      log(`Error reading analysis file: ${error.message}`);
      // Continue with analysis - don't return here
    }
  }

  console.log(`🔍 Processing ${municipality}...`);
  log(`Municipality directory: ${municDir}`);
  log(`Analysis path: ${analysisPath}`);
  log(`Metadata path: ${metadataPath}`);
  log(`Statute path: ${statutePath}`);

  try {
    // Check if required files exist
    if (!(await fileExists(metadataPath)) || !(await fileExists(statutePath))) {
      console.log(
        `⚠️  ${municipality}: Missing metadata or statute file, skipping`,
      );
      log(
        `Metadata exists: ${await fileExists(metadataPath)}, Statute exists: ${await fileExists(statutePath)}`,
      );
      return false; // No OpenAI calls made
    }

    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
    log(
      `Loaded metadata for ${municipality}:`,
      JSON.stringify(metadata, null, 2),
    );

    const questionsPath = path.join(domainDir, "questions.json");
    const questionsData = JSON.parse(await fs.readFile(questionsPath, "utf-8"));
    // Handle both array format and object format for questions
    const questionsArray = Array.isArray(questionsData)
      ? questionsData
      : questionsData.questions || [];
    log(`Loaded ${questionsArray.length} questions for domain ${domain}`);

    // Check if this uses state code or local ordinance
    const isStateCode = metadata.sourceUrl?.includes(
      "up.codes/viewer/new_york/ny-property-maintenance-code-2020",
    );
    log(`Municipality ${municipality} uses state code: ${isStateCode}`);

    let analysis;

    if (domain === "property-maintenance" && isStateCode) {
      // Handle state code municipalities with intelligent question comparison
      let existingAnalysis: any = null;

      if (force) {
        console.log(
          `🔄 ${municipality}: Force mode - clearing existing analysis and reanalyzing all questions`,
        );
        log(`Force mode enabled - ignoring existing analysis.json`);
      } else {
        try {
          if (await fileExists(analysisPath)) {
            const analysisContent = await fs.readFile(analysisPath, "utf-8");
            existingAnalysis = JSON.parse(analysisContent);
          }
        } catch (error) {
          log(`Could not load existing analysis: ${error.message}`);
        }
      }

      const { questionsToAnalyze, questionsToKeep, questionsToRemove } =
        compareQuestions(
          questionsArray,
          force && !questionId ? [] : existingAnalysis?.questions || [], // Only clear existing questions in force mode when not targeting a specific question
          municipality,
          questionId, // Pass specific question ID if provided
        );

      // Generate standard state code answers for new/changed questions
      const newAnswers = questionsToAnalyze.map((q: any) => ({
        id: q.id,
        question: q.question,
        answer:
          "No local ordinance; state code applies. See New York State Property Maintenance Code for detailed requirements.",
        confidence: 100,
        sourceRefs: ["NY State Property Maintenance Code"],
      }));

      // Combine and order answers according to questions.json order
      const allAnswers = orderAnswersByQuestions(
        questionsArray,
        questionsToKeep,
        newAnswers,
      );

      // Log final summary for state code analysis
      if (questionsToAnalyze.length === 0 && questionsToRemove.length === 0) {
        console.log(
          `✅ ${municipality}: No changes needed - all ${questionsToKeep.length} state code questions are up to date`,
        );
      } else {
        console.log(
          `✅ ${municipality}: State code analysis updated - ${newAnswers.length} newly processed, ${questionsToKeep.length} kept, ${questionsToRemove.length} removed`,
        );
      }

      // Extract WEN grade from metadata for state code analysis
      const grades: { [key: string]: string | null } = {};

      // Check originalCellValue for WEN grade first
      if (metadata.originalCellValue) {
        const gradeMatch = metadata.originalCellValue.match(/^([A-Z][+-]?)\s/);
        if (gradeMatch) {
          grades["WEN"] = gradeMatch[1];
          log(`Extracted WEN grade from originalCellValue: ${grades["WEN"]}`);
        }
      }

      // Fallback to metadata.grade if no originalCellValue grade found
      if (!grades["WEN"] && metadata.grade) {
        grades["WEN"] = metadata.grade;
        log(`Using metadata.grade as WEN grade: ${grades["WEN"]}`);
      }

      analysis = {
        municipality: {
          id: municipality,
          displayName: `${metadata.municipalityName} - ${metadata.municipalityType}`,
        },
        domain: {
          id: domain,
          displayName: formatDomainName(domain),
        },
        grades,
        questions: allAnswers,
        lastUpdated: new Date().toISOString(),
        processingMethod: "state-code-detection",
        usesStateCode: true,
      };
    } else {
      // Process with vector analysis for local ordinances
      analysis = await generateVectorAnalysis(
        municDir,
        municipality,
        domain,
        metadata,
        questionsArray,
        index,
        force,
        questionId,
        options, // Pass options for reindex flag
      );
    }

    // Add meta-analysis comparison if requested
    if (useMeta) {
      const metaAnalysis = await loadMetaAnalysis(domain);
      if (metaAnalysis) {
        analysis = await addMetaAnalysisComparison(
          analysis,
          metaAnalysis,
          municipality,
        );
        console.log(`🎯 ${municipality}: Added meta-analysis comparison`);
      } else {
        console.log(
          `⚠️  ${municipality}: No meta-analysis found for comparison`,
        );
      }
    }

    await fs.writeFile(analysisPath, JSON.stringify(analysis, null, 2));
    console.log(`✅ ${municipality}: Analysis complete`);
    return true; // OpenAI calls were made
  } catch (error) {
    if (error.message.includes("HTML content")) {
      console.error(`🚫 SKIPPED ${municipality}: ${error.message}`);
      console.error(
        `   Please run convertHtmlToText.ts on this statute file first.`,
      );
    } else {
      console.error(`❌ Failed to process ${municipality}:`, error.message);
    }
    return false; // No successful OpenAI calls made
  }
}

async function generateVectorAnalysis(
  municDir: string,
  municipality: string,
  domain: string,
  metadata: any,
  questions: any[],
  index: any,
  force: boolean = false,
  questionId?: string,
  options: AnalyzeOptions = {},
) {
  // Determine file name based on realm type (policy.txt for school realms, statute.txt for municipal)
  let documentFileName = "statute.txt"; // default for municipal realms

  // Check if this is a policy-based realm (like schools)
  if (options.realm && options.realm.includes("school")) {
    documentFileName = "policy.txt";
  }

  const statutePath = path.join(municDir, documentFileName);
  const statute = await fs.readFile(statutePath, "utf-8");
  
  // Load additional source files (guidance.txt, form.txt)
  const additionalSources = await loadAdditionalSources(municDir);

  // Check if the statute file contains HTML content
  if (isHtmlContent(statute)) {
    throw new Error(
      `Statute file contains HTML content instead of plain text. File needs to be converted from HTML to text before analysis.`,
    );
  }

  // Check for corrupted or binary files
  if (statute.length > 5000000) {
    // 5MB limit
    throw new Error(
      `Statute file is too large (${statute.length} bytes). This may indicate a corrupted file.`,
    );
  }

  // Check for binary content (non-text characters)
  // Exclude common legal symbols like § (167), © (169), ® (174), etc.
  const binaryContentRegex = /[\x00-\x08\x0E-\x1F\x7F-\x9F\u2000-\u200F\uFEFF]/;
  if (binaryContentRegex.test(statute.substring(0, 1000))) {
    throw new Error(
      `Statute file appears to contain binary data instead of text. File may be corrupted.`,
    );
  }

  // Index documents in vector database if reindex is explicitly requested
  // This happens regardless of analysis mode (conversation vs vector)
  if (options.reindex) {
    await indexDocumentInPinecone(statute, municipality, domain, index, "statute");
    
    // Also index guidance document if available
    if (additionalSources.guidance) {
      await indexDocumentInPinecone(additionalSources.guidance, municipality, domain, index, "guidance");
    }
  }

  // Count words in the statute
  const wordCount = statute.trim().split(/\s+/).length;
  const useDirectAnalysis = wordCount < 1000; // Increased from 250 to 1000 words

  if (useDirectAnalysis) {
    console.log(
      `📏 ${municipality}: Statute is short (${wordCount} words < 1000), using direct analysis instead of vector search`,
    );
    return await generateDirectAnalysis(
      municDir,
      municipality,
      domain,
      metadata,
      questions,
      statute,
      force,
      questionId,
      options,
      additionalSources,
    );
  } else {
    console.log(
      `🔍 ${municipality}: Statute is long (${wordCount} words), using vector analysis`,
    );
  }
  const analysisPath = path.join(municDir, "analysis.json");

  // Create backup of existing analysis.json if it exists
  let existingAnalysis: any = null;
  if (await fileExists(analysisPath)) {
    try {
      const analysisContent = await fs.readFile(analysisPath, "utf-8");
      existingAnalysis = JSON.parse(analysisContent);

      // Create timestamped backup using the analysis file's modification time
      const analysisStats = await fs.stat(analysisPath);
      const timestamp = analysisStats.mtime
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19); // YYYY-MM-DDTHH-MM-SS
      const backupPath = path.join(
        municDir,
        `analysis-backup-${timestamp}.json`,
      );
      await fs.writeFile(backupPath, analysisContent, "utf-8");
      console.log(
        `📋 ${municipality}: Created backup: analysis-backup-${timestamp}.json (analysis from ${analysisStats.mtime.toISOString()})`,
      );
    } catch (error) {
      log(`Could not create backup of existing analysis: ${error.message}`);
    }
  }

  if (force && !questionId) {
    console.log(
      `🔄 ${municipality}: Force mode - clearing existing analysis and reanalyzing all questions`,
    );
    log(
      `Force mode enabled - ignoring existing analysis.json for vector analysis`,
    );
    existingAnalysis = null; // Clear existing analysis in force mode
  } else if (force && questionId) {
    console.log(
      `🎯 ${municipality}: Force mode with specific question - targeting question ${questionId} only`,
    );
    log(
      `Force mode enabled for specific question ${questionId} - preserving other questions`,
    );
  }

  // Perform intelligent question comparison (clear existing questions in force mode only when not targeting specific question)
  const { questionsToAnalyze, questionsToKeep, questionsToRemove } =
    compareQuestions(
      questions,
      force && !questionId ? [] : existingAnalysis?.questions || [], // Only clear existing questions in force mode when not targeting a specific question
      municipality,
      questionId, // Pass specific question ID if provided
    );

  // Note: Indexing is now handled earlier in the function for both analysis modes

  // Choose analysis method based on statute size
  const statuteSize = statute.length;
  const useConversationMode = statuteSize <= 50000; // ~17.5K tokens, well under 128K limit

  // Track token usage for efficiency analysis
  let totalVectorTokens = 0;
  const statuteTokens = estimateTokens(statute);

  // Track total tokens used for this municipality analysis
  const startTokenUsage = getCurrentTokenUsage(); // Get current global token count

  const newAnswers: any[] = [];

  if (useConversationMode && questionsToAnalyze.length > 1) {
    // Conversation mode: analyze all questions together with full statute context
    console.log(
      `💬 ${municipality}: Using conversation mode for ${questionsToAnalyze.length} questions (statute: ${statuteSize.toLocaleString()} chars)`,
    );

    // Track conversation mode tokens
    const conversationStartTokens = getCurrentTokenUsage();

    const questionTexts = questionsToAnalyze.map((q) => q.question);
    const municipalityDisplayName = municipality
      .replace("NY-", "")
      .replace("-", " ");

    const conversationResults = await analyzeQuestionsWithFullStatute(
      questionTexts,
      statute,
      municipalityDisplayName,
      domain,
      questionsToAnalyze, // Pass full question objects with scoreInstructions
      options, // Pass options for model selection
      additionalSources, // Pass additional sources for form/guidance questions
      metadata, // Pass metadata for enhanced sourceRefs
    );

    // Calculate conversation mode tokens used
    const conversationEndTokens = getCurrentTokenUsage();
    const conversationTokensUsed =
      conversationEndTokens - conversationStartTokens;

    if (VERBOSE) {
      log(
        `Conversation mode analysis: ${conversationTokensUsed} tokens for ${questionsToAnalyze.length} questions`,
      );
    }

    // Process conversation results and add scoring/gap analysis
    for (let i = 0; i < questionsToAnalyze.length; i++) {
      const question = questionsToAnalyze[i];
      const result = conversationResults[i];

      // Calculate score based on answer quality and content
      const score = calculateAnswerScore(result.answer, result.confidence);

      // Generate gap analysis for this question
      const gap = await generateGapAnalysis(
        question.question,
        result.answer,
        result.confidence,
        municipality,
        domain,
        options,
      );

      const newAnswer: any = {
        id: question.id,
        question: question.question,
        answer: result.answer,
        confidence: result.confidence,
        sourceRefs: result.sourceRefs || [],
        score: parseFloat(score.toFixed(2)),
      };

      // Only include gap if it exists
      if (gap) {
        newAnswer.gap = gap;
      }

      newAnswers.push(newAnswer);
    }
  } else {
    // Vector mode: analyze questions individually using Pinecone chunks
    console.log(
      `🔍 ${municipality}: Using vector mode for ${questionsToAnalyze.length} questions (statute: ${statuteSize.toLocaleString()} chars)`,
    );

    for (const question of questionsToAnalyze) {
      console.log(
        `🔍 ${municipality}: Analyzing question "${question.question.substring(0, 60)}..."`,
      );

      // Create context from existing answers to avoid repetition
      const existingAnswersContext =
        questionsToKeep.length > 0
          ? `\n\nNOTE: Other questions in this analysis have already covered these topics:\n${questionsToKeep.map((q) => `- Q${q.id}: ${q.answer.substring(0, 100)}...`).join("\n")}\n\nProvide unique information that doesn't repeat what's already been covered.`
          : "";

      const answer = await answerQuestionWithVector(
        question.question,
        municipality,
        domain,
        index,
        existingAnswersContext,
        question.scoreInstructions,
      );

      // Track vector tokens used for this question
      if (answer.vectorTokensUsed) {
        totalVectorTokens += answer.vectorTokensUsed;
      }
      // Calculate score based on answer quality and content
      const score = calculateAnswerScore(answer.answer, answer.confidence);

      // Generate gap analysis for this question
      const gap = await generateGapAnalysis(
        question.question,
        answer.answer,
        answer.confidence,
        municipality,
        domain,
        options,
      );

      const newAnswer: any = {
        id: question.id,
        question: question.question,
        answer: answer.answer,
        confidence: answer.confidence,
        sourceRefs: answer.sourceRefs || [],
        score: parseFloat(score.toFixed(2)),
        analyzedAt: new Date().toISOString(),
      };

      // Only include gap if it exists
      if (gap) {
        newAnswer.gap = gap;
      }

      newAnswers.push(newAnswer);
    }
  }

  // Calculate total tokens used for this municipality analysis
  const endTokenUsage = getCurrentTokenUsage();
  const municipalityTokensUsed = endTokenUsage - startTokenUsage;

  // Always show token usage summary for municipality
  const analysisMethod = useConversationMode
    ? questionsToAnalyze.length > 1
      ? "conversation"
      : "direct"
    : "vector";
  console.log(
    `📊 ${municipality}: Token usage summary (${analysisMethod} mode):`,
  );
  console.log(
    `   Total tokens used: ${municipalityTokensUsed.toLocaleString()}`,
  );
  console.log(`   Statute size: ${statuteTokens.toLocaleString()} tokens`);
  console.log(`   Questions analyzed: ${questionsToAnalyze.length}`);

  if (VERBOSE) {
    log(
      `Municipality analysis: ${municipalityTokensUsed} tokens for ${questionsToAnalyze.length} questions using ${analysisMethod} mode`,
    );
  }

  // Show vector-specific efficiency analysis if we used vector mode
  if (!useConversationMode && questionsToAnalyze.length > 0) {
    const vectorEfficiency = (
      (totalVectorTokens / statuteTokens) *
      100
    ).toFixed(1);
    const worthIt = totalVectorTokens < statuteTokens * 0.8; // Vector worth it if <80% of statute tokens

    console.log(
      `   Vector chunks used: ${totalVectorTokens.toLocaleString()} tokens (${vectorEfficiency}% of statute)`,
    );
    console.log(
      `   Vector approach: ${worthIt ? "✅ Efficient" : "⚠️  Consider conversation mode"} (${worthIt ? "Used less than 80%" : "Used more than 80%"} of statute tokens)`,
    );

    if (VERBOSE) {
      log(
        `Vector efficiency: ${vectorEfficiency}% - Statute: ${statuteTokens} tokens, Vector chunks: ${totalVectorTokens} tokens`,
      );
    }
  }

  // Add gap analysis to existing questions that don't have it (only when not targeting specific question)
  const enhancedQuestionsToKeep: any[] = [];
  for (const existingQuestion of questionsToKeep) {
    // Calculate or use existing score, ensure 2 decimal places
    const score =
      existingQuestion.score !== undefined
        ? parseFloat(existingQuestion.score.toFixed(2))
        : parseFloat(
            calculateAnswerScore(
              existingQuestion.answer,
              existingQuestion.confidence || 50,
            ).toFixed(2),
          );

    // Only process gap analysis for existing questions when NOT targeting a specific question
    // When targeting specific question, preserve existing questions exactly as they are
    if (!questionId && !existingQuestion.gap && score < 1.0) {
      console.log(
        `🔍 ${municipality}: Adding missing gap analysis for question ${existingQuestion.id} (score: ${score.toFixed(2)})`,
      );
      const gap = await generateGapAnalysis(
        existingQuestion.question,
        existingQuestion.answer,
        existingQuestion.confidence || 50,
        municipality,
        domain,
        options,
      );

      const enhanced: any = {
        ...existingQuestion,
        score: parseFloat(score.toFixed(2)),
      };

      // Only include gap if it exists
      if (gap) {
        enhanced.gap = gap;
      }

      enhancedQuestionsToKeep.push(enhanced);
    } else if (!questionId && existingQuestion.gap && score >= 1.0) {
      // Remove gap from questions that now score perfectly (only when not targeting specific question)
      console.log(
        `🔍 ${municipality}: Removing gap from question ${existingQuestion.id} (perfect score: ${score.toFixed(2)})`,
      );
      const { gap, ...questionWithoutGap } = existingQuestion;
      enhancedQuestionsToKeep.push({
        ...questionWithoutGap,
        score: parseFloat(score.toFixed(2)),
      });
    } else {
      // Keep question as-is but ensure score is included
      enhancedQuestionsToKeep.push({
        ...existingQuestion,
        score: parseFloat(score.toFixed(2)),
      });
    }
  }

  // Combine and order answers according to questions.json order
  const allAnswers = orderAnswersByQuestions(
    questions,
    enhancedQuestionsToKeep,
    newAnswers,
  );

  // Log final summary
  if (questionsToAnalyze.length === 0 && questionsToRemove.length === 0) {
    console.log(
      `✅ ${municipality}: No changes needed - all ${questionsToKeep.length} questions are up to date`,
    );
  } else {
    console.log(
      `✅ ${municipality}: Analysis updated - ${newAnswers.length} newly analyzed, ${questionsToKeep.length} kept, ${questionsToRemove.length} removed`,
    );
  }

  // Extract WEN grade from metadata
  const grades: { [key: string]: string | null } = {};

  // Check originalCellValue for WEN grade first
  if (metadata.originalCellValue) {
    const gradeMatch = metadata.originalCellValue.match(/^([A-Z][+-]?)\s/);
    if (gradeMatch) {
      grades["WEN"] = gradeMatch[1];
      log(`Extracted WEN grade from originalCellValue: ${grades["WEN"]}`);
    }
  }

  // Fallback to metadata.grade if no originalCellValue grade found
  if (!grades["WEN"] && metadata.grade) {
    grades["WEN"] = metadata.grade;
    log(`Using metadata.grade as WEN grade: ${grades["WEN"]}`);
  }

  // Calculate overall scores with proper normalization using question weights
  const scores = calculateNormalizedScores(allAnswers, questions);

  return {
    municipality: {
      id: municipality,
      displayName: `${metadata.municipality || "Unknown"} - ${metadata.municipalityType || "Municipality"}`,
    },
    domain: {
      id: domain,
      displayName: formatDomainName(domain),
    },
    grades,
    questions: allAnswers,
    scores: scores,
    overallScore: scores.normalizedScore, // Keep for backward compatibility
    averageConfidence: scores.averageConfidence,
    questionsAnswered: scores.questionsAnswered,
    totalQuestions: scores.totalQuestions,
    lastUpdated: new Date().toISOString(),
    processingMethod: "vector-search-rag",
    usesStateCode: false,
  };
}

// Direct analysis for short statutes (bypasses vector search)
async function generateDirectAnalysis(
  municDir: string,
  municipality: string,
  domain: string,
  metadata: any,
  questions: any[],
  statute: string,
  force: boolean = false,
  questionId?: string,
  options: AnalyzeOptions = {},
  additionalSources: { guidance?: string; form?: string } = {},
) {
  // Track total tokens used for this municipality analysis
  const startTokenUsage = getCurrentTokenUsage();
  const statuteTokens = estimateTokens(statute);

  const analysisPath = path.join(municDir, "analysis.json");

  // Create backup of existing analysis.json if it exists
  let existingAnalysis: any = null;
  if (await fileExists(analysisPath)) {
    try {
      const analysisContent = await fs.readFile(analysisPath, "utf-8");
      existingAnalysis = JSON.parse(analysisContent);

      // Create timestamped backup using the analysis file's modification time
      const analysisStats = await fs.stat(analysisPath);
      const timestamp = analysisStats.mtime
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19); // YYYY-MM-DDTHH-MM-SS
      const backupPath = path.join(
        municDir,
        `analysis-backup-${timestamp}.json`,
      );
      await fs.writeFile(backupPath, analysisContent, "utf-8");
      console.log(
        `📋 ${municipality}: Created backup: analysis-backup-${timestamp}.json (analysis from ${analysisStats.mtime.toISOString()})`,
      );
    } catch (error) {
      log(`Could not create backup of existing analysis: ${error.message}`);
    }
  }

  if (force && !questionId) {
    console.log(
      `🔄 ${municipality}: Force mode - clearing existing analysis and reanalyzing all questions`,
    );
    log(
      `Force mode enabled - ignoring existing analysis.json for direct analysis`,
    );
    existingAnalysis = null; // Clear existing analysis in force mode
  } else if (force && questionId) {
    console.log(
      `🎯 ${municipality}: Force mode with specific question - targeting question ${questionId} only`,
    );
    log(
      `Force mode enabled for specific question ${questionId} - preserving other questions`,
    );
  }

  // Determine which questions to analyze
  const { questionsToAnalyze, questionsToKeep, questionsToRemove } =
    compareQuestions(
      questions,
      existingAnalysis?.questions || [],
      municipality,
      questionId,
    );

  // Generate answers for questions that need analysis
  const newAnswers: any[] = [];

  for (const question of questionsToAnalyze) {
    const questionText = question.question || "No question text available";

    console.log(
      `🔍 ${municipality}: Analyzing question "${questionText.substring(0, 50)}..." (direct analysis)`,
    );

    try {
      const result = await answerQuestionDirectly(
        questionText,
        statute,
        domain,
        municipality,
        question.scoreInstructions,
        options,
      );

      // Calculate individual question score
      const questionScore = calculateAnswerScore(
        result.answer,
        result.confidence,
      );

      const answer = {
        id: question.id,
        question: question.question,
        answer: result.answer,
        confidence: result.confidence,
        sourceRefs: result.sourceRefs,
        score: questionScore,
        analyzedAt: new Date().toISOString(),
      };

      newAnswers.push(answer);

      if (VERBOSE) {
        console.log(
          `[VERBOSE] Generated answer: ${result.answer.substring(0, 100)}... (confidence: ${result.confidence}%, ${result.sourceRefs.length} refs)`,
        );
      }
    } catch (error) {
      console.error(
        `❌ Error analyzing question ${question.id}:`,
        error.message,
      );
      // Add a fallback answer
      const answer = {
        id: question.id,
        question: question.question,
        answer: "Not specified in the statute.",
        confidence: 0,
        sourceRefs: [],
        score: 0,
        analyzedAt: new Date().toISOString(),
        error: error.message,
      };
      newAnswers.push(answer);
    }
  }

  // Combine all answers: existing ones to keep + new ones + gap analysis
  const allAnswers = [...questionsToKeep, ...newAnswers];

  // Sort answers to match questions.json order
  const orderedAnswers = orderAnswersByQuestions(questions, [], newAnswers);
  if (VERBOSE) {
    log(
      `Ordered ${orderedAnswers.length} answers according to questions.json sequence`,
    );
  }

  // Calculate total tokens used for this municipality analysis
  const endTokenUsage = getCurrentTokenUsage();
  const municipalityTokensUsed = endTokenUsage - startTokenUsage;

  // Show token usage summary for municipality
  console.log(`📊 ${municipality}: Token usage summary (direct mode):`);
  console.log(
    `   Total tokens used: ${municipalityTokensUsed.toLocaleString()}`,
  );
  console.log(`   Statute size: ${statuteTokens.toLocaleString()} tokens`);
  console.log(`   Questions analyzed: ${questionsToAnalyze.length}`);

  if (VERBOSE) {
    log(
      `Municipality analysis: ${municipalityTokensUsed} tokens for ${questionsToAnalyze.length} questions using direct mode`,
    );
  }

  // Calculate overall scores with proper normalization using question weights
  const scores = calculateNormalizedScores(orderedAnswers, questions);

  // Skip gap analysis for direct analysis to avoid dependencies
  const gapAnalysis = existingAnalysis?.gapAnalysis || "";

  console.log(
    `✅ ${municipality}: Analysis updated - ${newAnswers.length} newly analyzed, ${questionsToKeep.length} kept, ${questionsToRemove.length} removed`,
  );

  const analysis = {
    municipality: municipality,
    domain: domain,
    analyzedAt: new Date().toISOString(),
    questions: orderedAnswers,
    scores: scores,
    overallScore: scores.normalizedScore, // Keep for backward compatibility
    averageConfidence: scores.averageConfidence,
    questionsAnswered: scores.questionsAnswered,
    totalQuestions: scores.totalQuestions,
    gapAnalysis,
    wenGrade: metadata.originalCellValue?.match(/^([A-Z][+-]?)\s/)?.[1] || null,
    usesStateCode: false,
  };

  return analysis;
}

// Answer a question directly using the full statute text (for short statutes)
async function answerQuestionDirectly(
  question: string,
  statute: string,
  domain: string,
  municipalityId: string,
  scoreInstructions?: string,
  options: AnalyzeOptions = {},
) {
  log(
    `Answering question for ${municipalityId}-${domain} using direct analysis: "${question.substring(0, 100)}..."`,
  );

  try {
    const scoreInstructionsText = scoreInstructions
      ? `

SCORING GUIDANCE: ${scoreInstructions}`
      : "";
    const systemPrompt = `You are analyzing municipal statutes. Based ONLY on the provided statute text, answer the user's question. If the information is not in the statute, respond with "Not specified in the statute." Be precise and cite section numbers when available.
IMPORTANT: Focus on providing unique information for this specific question. Do not repeat details that would be better covered in answers to other typical municipal questions (like permit requirements, which are usually addressed in permit-specific questions).${scoreInstructionsText}`;

    const userPrompt = `STATUTE TEXT:
${statute}

QUESTION: ${question}

Please provide a clear, concise answer based solely on the statute text above. If the information is not explicitly stated in the statute, respond with "Not specified in the statute."`;

    if (VERBOSE) {
      log(
        `Sending direct analysis request to GPT-4o for question: "${question.substring(0, 50)}..."`,
      );
      log(`Statute length: ${statute.length} characters`);
      log(`First 200 chars of statute: "${statute.substring(0, 200)}..."`);
    }

    // Rate limiting for direct analysis
    const estimatedTokens = estimateTokens(systemPrompt + userPrompt) + 500; // Add response estimate
    await checkRateLimit(estimatedTokens);

    const response = await openai.chat.completions.create({
      model: options.model || "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
    });

    // Record actual token usage
    const actualTokens = response.usage?.total_tokens || estimatedTokens;
    recordTokenUsage(actualTokens);

    const answer =
      response.choices[0]?.message?.content || "Not specified in the statute.";

    // Calculate confidence based on answer quality
    let confidence = 0;
    if (answer !== "Not specified in the statute.") {
      confidence = 80; // Higher confidence for direct analysis since we have the full text
      if (answer.includes("§") || answer.includes("Section")) {
        confidence = 90; // Even higher if section numbers are cited
      }
    }

    // Extract section references
    const sourceRefs = extractSectionReferences(answer);

    if (VERBOSE) {
      log(
        `Generated direct answer: ${answer.substring(0, 100)}... (confidence: ${confidence}%, ${sourceRefs.length} refs)`,
      );
    }

    return {
      answer,
      confidence,
      sourceRefs,
      vectorTokensUsed: actualTokens, // Total tokens used for this question
    };
  } catch (error) {
    console.error("Error in direct statute analysis:", error);
    return {
      answer: "Not specified in the statute.",
      confidence: 0,
      sourceRefs: [],
      vectorTokensUsed: 0,
    };
  }
}

async function indexDocumentInPinecone(
  documentText: string,
  municipalityId: string,
  domain: string,
  index: any,
  documentType: "statute" | "guidance" = "statute",
) {
  const chunks = chunkText(documentText, 2000); // Larger character limit but with token validation
  log(
    `Indexing ${documentType} for ${municipalityId}-${domain}: ${chunks.length} chunks, ${documentText.length} total characters`,
  );
  const vectors: any[] = [];

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    let tokenCount = estimateTokenCount(chunk);
    log(
      `Generating embedding for chunk ${i + 1}/${chunks.length} (${chunk.length} chars, ~${tokenCount} tokens)`,
    );

    // Skip chunks that are too large for embedding model (strict limit enforcement)
    if (tokenCount > 8000) {
      console.warn(
        `⚠️ Skipping chunk ${i + 1}: ${tokenCount} tokens exceeds embedding model limit`,
      );
      continue;
    }

    // If chunk is close to the limit, truncate it to be safe
    if (tokenCount > 7500) {
      const maxSafeChars = Math.floor(7500 * 3); // Conservative character estimate
      const truncatedChunk =
        chunk.substring(0, maxSafeChars) +
        "\n\n[Content truncated to fit embedding model limit]";
      const newTokenCount = estimateTokenCount(truncatedChunk);
      log(
        `Truncating large chunk ${i + 1}: ${tokenCount} → ${newTokenCount} tokens`,
      );
      chunk = truncatedChunk;
      tokenCount = newTokenCount;
    }

    try {
      // Rate limiting for embeddings
      const estimatedTokens = estimateTokens(chunk);
      await checkRateLimit(estimatedTokens);

      const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunk,
      });

      // Record token usage
      const actualTokens = response.usage?.total_tokens || estimatedTokens;
      recordTokenUsage(actualTokens);

      vectors.push({
        id: `${municipalityId}-${domain}-${documentType}-chunk-${i}`,
        values: response.data[0].embedding,
        metadata: {
          municipalityId,
          domainId: domain,
          documentType,
          chunkIndex: i,
          content: chunk, // Store full chunk content for retrieval
        },
      });
    } catch (error) {
      console.error(`Error generating embedding for chunk ${i}:`, error);
      console.error(
        `Chunk length: ${chunk.length} chars, estimated tokens: ${tokenCount}`,
      );
    }
  }

  if (vectors.length > 0) {
    log(
      `Upserting ${vectors.length} ${documentType} vectors to Pinecone for ${municipalityId}-${domain}`,
    );
    await index.upsert(vectors);
    log(`Successfully indexed ${vectors.length} ${documentType} chunks in Pinecone`);
  } else {
    log(`No vectors to upsert for ${municipalityId}-${domain}`);
  }
}

// Helper function to estimate token count (conservative approximation: 1 token ≈ 3 characters for safety)
function estimateTokenCount(text: string): number {
  // More conservative estimate - shorter texts tend to have higher token density
  // Add padding for special characters, punctuation, and whitespace patterns common in legal text
  const baseTokens = Math.ceil(text.length / 3);
  const punctuationPadding =
    (text.match(/[§\(\)\[\]\.,:;]/g) || []).length * 0.1;
  const numberPadding = (text.match(/\d+/g) || []).length * 0.2;
  return Math.ceil(baseTokens + punctuationPadding + numberPadding);
}

// Helper function to truncate text to fit within token limit
function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4; // Conservative estimate
  if (text.length <= maxChars) {
    return text;
  }

  // Truncate and add indicator
  const truncated = text.substring(0, maxChars - 100); // Leave some buffer
  return truncated + "\n\n[Text truncated to fit context limit...]";
}

// Enhance question with domain-specific keywords for better vector matching
function enhanceQuestionForVectorSearch(
  question: string,
  domain: string,
): string {
  const lowerQuestion = question.toLowerCase();
  let enhancedQuestion = question;

  // Add specific terms based on domain and question content
  if (domain === "property-maintenance") {
    if (lowerQuestion.includes("yard") || lowerQuestion.includes("landscape")) {
      enhancedQuestion +=
        " curtilage vegetation grasses brush briars 10 inches 15 feet perimeter structure uncultivated plants flowers gardens pollinator";
    }
    if (lowerQuestion.includes("penalty") || lowerQuestion.includes("fine")) {
      enhancedQuestion += " $200 per day violation continues penalty fine";
    }
    if (
      lowerQuestion.includes("timeline") ||
      lowerQuestion.includes("resolving")
    ) {
      enhancedQuestion +=
        " 30 days 10 days certified mail notice violation hearing";
    }
  }

  if (domain === "trees") {
    if (lowerQuestion.includes("permit") || lowerQuestion.includes("removal")) {
      enhancedQuestion +=
        " tree removal permit application DBH diameter inches";
    }
  }

  if (domain === "glb" || domain === "gas-leaf-blower") {
    if (lowerQuestion.includes("hours") || lowerQuestion.includes("time")) {
      enhancedQuestion += " 8 AM 9 AM 5 PM 6 PM hours operation blower leaf";
    }
  }

  return enhancedQuestion;
}

async function analyzeQuestionsWithFullStatute(
  questions: string[],
  statuteText: string,
  municipalityName: string,
  domainName: string,
  questionsWithInstructions: any[] = [],
  options: AnalyzeOptions = {},
  additionalSources: { guidance?: string; form?: string } = {},
  metadata?: any,
): Promise<
  Array<{ answer: string; confidence: number; sourceRefs: string[] | SourceRef[] }>
> {
  log(
    `🔄 Starting conversation-based analysis for ${municipalityName} ${domainName} (${questions.length} questions)`,
  );

  try {
    const messages: any[] = [
      {
        role: "system",
        content: `You are analyzing municipal statutes. You will answer a series of questions about the statute in conversation format.

CRITICAL INSTRUCTIONS:
- Answer based ONLY on what is explicitly stated in the statute text provided
- If information is not found in the statute, respond with EXACTLY "Not specified in the statute." and use low confidence (0-20)
- Do not infer, assume, or elaborate beyond what is written
- ALWAYS include specific statute section references (like § 112-4A, § 112-5B) in your answers when citing information
- Use plain language residents can understand
- Include specific details like fees, timeframes, requirements ONLY if they are explicitly stated

SCORING GUIDANCE: 
- Give precise, factual answers based ONLY on what is stated in the statute
- "Not specified in the statute" answers should have very low confidence (0-20) and low scores (0.1-0.2)
- Higher scores reflect more restrictive/qualified environmental protection requirements
- Lower scores for vague, permissive, or missing regulations
${questionsWithInstructions
  .map((q, i) =>
    q.scoreInstructions
      ? `
Question ${i + 1} specific scoring: ${q.scoreInstructions}`
      : "",
  )
  .filter((s) => s)
  .join("")}`,
      },
      {
        role: "user",
        content: `Here is the complete statute for ${municipalityName} ${domainName}:

${statuteText}${additionalSources.guidance ? `

=== ADDITIONAL GUIDANCE DOCUMENT ===
${additionalSources.guidance}` : ""}${additionalSources.form ? `

=== OFFICIAL FORM DOCUMENT ===
${additionalSources.form}` : ""}

I will now ask you ${questions.length} questions about this statute${additionalSources.guidance || additionalSources.form ? " and the additional documents provided" : ""}. Please analyze it carefully and answer each question based solely on the content above.`,
      },
    ];

    const results: Array<{
      answer: string;
      confidence: number;
      sourceRefs: string[];
    }> = [];

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      log(
        `  🤖 Question ${i + 1}/${questions.length}: ${question.substring(0, 80)}...`,
      );

      // Check if this question should reference additional sources
      const questionObj = questionsWithInstructions[i];
      const hasFormSource = questionObj?.additionalSource === "form";
      const formInstructions = hasFormSource && additionalSources.form 
        ? "\n\nNOTE: This question specifically asks about information that may be found in the official form document provided above. Please check both the statute AND the form document for your answer."
        : "";
        
      // Add question to conversation
      messages.push({
        role: "user",
        content: `Question ${i + 1}: ${question}${formInstructions}

Please provide your answer in this JSON format:
{
  "answer": "Your detailed answer in plain language, including specific section references (like § 112-4A) when citing statute information",
  "sourceReference": "Specific statute section or form document section if identifiable", 
  "confidence": 85
}`,
      });

      // Rate limiting for conversation analysis
      const conversationText = messages.map((m) => m.content).join(" ");
      const estimatedTokens = estimateTokens(conversationText) + 300; // Add response estimate
      await checkRateLimit(estimatedTokens);

      const response = await openai.chat.completions.create({
        model: options.model || "gpt-4o",
        messages: messages,
        response_format: { type: "json_object" },
      });

      // Record actual token usage
      const actualTokens = response.usage?.total_tokens || estimatedTokens;
      recordTokenUsage(actualTokens);

      // Pause between questions in conversation mode
      await sleep(QUESTION_PAUSE_MS);

      const result = JSON.parse(response.choices[0].message.content || "{}");
      const answer = result.answer || "Not specified in the statute.";
      const confidence = Math.max(0, Math.min(100, result.confidence || 50));
      
      // Detect which documents were referenced in the AI response
      const referencedDocuments = detectReferencedDocuments(
        answer, 
        response.choices[0].message.content || undefined
      );
      
      // Generate enhanced sourceRefs in new object format (if metadata available)
      const enhancedSourceRefs = metadata ? generateEnhancedSourceRefs(
        answer,
        metadata,
        referencedDocuments
      ) : [];
      
      // For backward compatibility, also generate legacy string array
      // Check both sourceReference field and the answer text for section references
      const legacySourceRefs = result.sourceReference
        ? extractSectionReferences(result.sourceReference)
        : extractSectionReferences(answer);
      
      // Add sections found in answer to enhanced refs if metadata is available
      if (metadata && legacySourceRefs.length > 0) {
        // Update referencedDocuments to include statute if sections found
        referencedDocuments.add('statute');
        
        // Regenerate enhanced sourceRefs with updated referenced documents
        const updatedEnhancedSourceRefs = generateEnhancedSourceRefs(
          answer,
          metadata,
          referencedDocuments
        );
        
        // Replace the enhancedSourceRefs with the updated version
        enhancedSourceRefs.length = 0;
        enhancedSourceRefs.push(...updatedEnhancedSourceRefs);
      }

      // Add AI response to conversation for context in next questions
      messages.push({
        role: "assistant",
        content: response.choices[0].message.content || "{}",
      });

      results.push({ 
        answer, 
        confidence, 
        sourceRefs: enhancedSourceRefs.length > 0 ? enhancedSourceRefs as any : legacySourceRefs
      });

      const refCount = Array.isArray(enhancedSourceRefs) && enhancedSourceRefs.length > 0 
        ? enhancedSourceRefs.length 
        : legacySourceRefs.length;
      log(
        `    ✓ Answer: ${answer.substring(0, 100)}... (confidence: ${confidence}%, ${refCount} refs)`,
      );
    }

    log(
      `🎉 Completed conversation analysis: ${results.length} questions answered`,
    );

    // Pause between question sets to respect rate limits
    await sleep(QUESTION_SET_PAUSE_MS);

    return results;
  } catch (error) {
    console.error("Error in conversation analysis:", error);
    // Return default answers if conversation fails
    return questions.map(() => ({
      answer: "Not specified in the statute.",
      confidence: 0,
      sourceRefs: [],
    }));
  }
}

async function answerQuestionWithVector(
  question: string,
  municipalityId: string,
  domain: string,
  index: any,
  existingAnswersContext: string = "",
  scoreInstructions?: string,
) {
  log(
    `Answering question for ${municipalityId}-${domain}: "${question.substring(0, 100)}..."`,
  );

  try {
    // Enhance question with domain-specific keywords for better vector matching
    const enhancedQuestion = enhanceQuestionForVectorSearch(question, domain);

    // Rate limiting for question embeddings
    const embeddingTokens = estimateTokens(enhancedQuestion);
    await checkRateLimit(embeddingTokens);

    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: enhancedQuestion,
    });

    // Record token usage
    const actualEmbeddingTokens =
      response.usage?.total_tokens || embeddingTokens;
    recordTokenUsage(actualEmbeddingTokens);
    if (VERBOSE) {
      log(`Enhanced question: "${enhancedQuestion}"`);
    }
    log(`Generated question embedding, searching Pinecone index`);

    const searchResults = await index.query({
      vector: response.data[0].embedding,
      filter: { municipalityId, domainId: domain },
      topK: 5,
      includeMetadata: true,
    });

    log(`Vector search returned ${searchResults.matches?.length || 0} matches`);
    if (searchResults.matches?.length > 0) {
      log(
        `Match scores: ${searchResults.matches.map((m) => `${m.score?.toFixed(3)} (chunk ${m.metadata?.chunkIndex})`).join(", ")}`,
      );
    }

    if (!searchResults.matches || searchResults.matches.length === 0) {
      log(`No matches found, returning default "Not specified" answer`);
      return {
        answer: "Not specified in the statute.",
        confidence: 0,
        sourceRefs: [],
        vectorTokensUsed: actualEmbeddingTokens, // Only embedding tokens used when no matches
      };
    }

    // Format relevant texts with chunk information and section identifiers
    let relevantTexts = searchResults.matches
      .map((match, index) => {
        const text = match.metadata?.content || match.metadata?.text || "";
        const chunkIndex = match.metadata?.chunkIndex || "unknown";
        const score = match.score?.toFixed(3) || "0.000";

        // Extract section references from the chunk text for better context
        const sectionRefs = extractSectionReferences(text);
        const sectionInfo =
          sectionRefs.length > 0 ? ` (${sectionRefs.join(", ")})` : "";

        return `--- STATUTE CHUNK ${index + 1} (score: ${score}, chunk: ${chunkIndex}${sectionInfo}) ---\n${text}`;
      })
      .join("\n\n");

    // Calculate token estimates for context management
    const scoreInstructionsText = scoreInstructions
      ? `\n\nSCORING GUIDANCE: ${scoreInstructions}`
      : "";
    const systemPrompt = `You are analyzing municipal statutes. Based ONLY on the provided statute text, answer the user's question. If the information is not in the statute, respond with "Not specified in the statute." Be precise and cite section numbers when available.

IMPORTANT: Focus on providing unique information for this specific question. Do not repeat details that would be better covered in answers to other typical municipal questions (like permit requirements, which are usually addressed in permit-specific questions).${scoreInstructionsText}`;
    const userPromptPrefix = `Question: ${question}\n\nRelevant statute text:\n`;

    const systemTokens = estimateTokenCount(systemPrompt);
    const userPrefixTokens = estimateTokenCount(userPromptPrefix);
    const maxContextTokens = 6000; // Conservative limit to leave room for response
    const availableTokensForText =
      maxContextTokens - systemTokens - userPrefixTokens;

    // Truncate relevant texts if they exceed available token budget
    if (estimateTokenCount(relevantTexts) > availableTokensForText) {
      log(
        `Truncating context: ${estimateTokenCount(relevantTexts)} tokens → ${availableTokensForText} tokens`,
      );
      relevantTexts = truncateToTokenLimit(
        relevantTexts,
        availableTokensForText,
      );
    }

    log(
      `Extracted ${relevantTexts.length} characters of relevant text, generating answer with GPT-4o`,
    );

    const userPrompt = `${userPromptPrefix}${relevantTexts}${existingAnswersContext}`;

    // Log the full prompts when verbose mode is enabled
    if (VERBOSE) {
      console.log(`\n📝 SYSTEM PROMPT:`);
      console.log(`${systemPrompt}`);
      console.log(
        `\n📝 USER PROMPT (${estimateTokenCount(userPrompt)} estimated tokens):`,
      );
      console.log(`${userPrompt}`);
      console.log(`\n🔄 Sending to GPT-4o...`);
    }

    // Rate limiting for vector-based analysis
    const vectorTokens = estimateTokens(systemPrompt + userPrompt) + 1000; // Add max_tokens estimate
    await checkRateLimit(vectorTokens);

    const answerResponse = await openai.chat.completions.create({
      model: currentModel || "gpt-4o",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 1000, // Limit response length
    });

    // Record actual token usage
    const actualVectorTokens =
      answerResponse.usage?.total_tokens || vectorTokens;
    recordTokenUsage(actualVectorTokens);

    // Pause between questions in vector mode
    await sleep(QUESTION_PAUSE_MS);

    const answer =
      answerResponse.choices[0].message.content ||
      "Not specified in the statute.";
    const avgScore =
      searchResults.matches.reduce(
        (sum, match) => sum + (match.score || 0),
        0,
      ) / searchResults.matches.length;
    const confidence = Math.round(avgScore * 100);
    const sourceRefs = extractSectionReferences(relevantTexts);

    log(
      `Generated answer: ${answer.substring(0, 100)}... (confidence: ${confidence}%, ${sourceRefs.length} refs)`,
    );

    return {
      answer,
      confidence: Math.max(0, Math.min(100, confidence)),
      sourceRefs,
      vectorTokensUsed: actualVectorTokens + actualEmbeddingTokens, // Total tokens used for this question
    };
  } catch (error) {
    console.error("Error in vector search:", error);
    return {
      answer: "Not specified in the statute.",
      confidence: 0,
      sourceRefs: [],
      vectorTokensUsed: 0,
    };
  }
}

// Helper functions
async function getDomainDirectories(
  dataDir: string = "data",
): Promise<string[]> {
  console.log("Reading domains under " + dataDir);
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

async function getMunicipalityDirectories(
  domainDir: string,
  realmType?: string,
): Promise<string[]> {
  const entries = await fs.readdir(domainDir, { withFileTypes: true });

  // Filter based on realm type
  if (realmType === "policy") {
    // For school realms: accept any directory that doesn't start with '.'
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } else {
    // For municipal realms: only NY- prefixed directories
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("NY-"))
      .map((entry) => entry.name);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function chunkText(text: string, maxChunkSize: number = 1000): string[] {
  const chunks: string[] = [];
  const maxTokens = 5000; // Very conservative limit well below 8192 token OpenAI limit

  log(
    `Starting intelligent chunking: ${text.length} characters, max chunk size: ${maxChunkSize}, max tokens: ${maxTokens}`,
  );

  // First try to split by sentence endings with double newlines (preferred for context preservation)
  // Then fall back to single newlines, and finally section markers as last resort
  let sections: string[] = [];

  // Primary separator: period followed by double newline (paragraph breaks)
  const doubleNewlineSections = text
    .split(/\.\n\n/)
    .filter((section) => section.trim())
    .map((section, index, array) => {
      // Add back the period except for the last section (if it doesn't end with one)
      return index < array.length - 1 && !section.endsWith(".")
        ? section + "."
        : section;
    });

  if (
    doubleNewlineSections.length > 1 &&
    doubleNewlineSections.every((s) => s.length < maxChunkSize)
  ) {
    sections = doubleNewlineSections;
    log(`Split into ${sections.length} sections by .\n\n separators`);
  } else {
    // Secondary separator: period followed by single newline
    const singleNewlineSections = text
      .split(/\.\n/)
      .filter((section) => section.trim())
      .map((section, index, array) => {
        return index < array.length - 1 && !section.endsWith(".")
          ? section + "."
          : section;
      });

    if (
      singleNewlineSections.length > 1 &&
      singleNewlineSections.some((s) => s.length < maxChunkSize * 0.8)
    ) {
      sections = singleNewlineSections;
      log(`Split into ${sections.length} sections by .\n separators`);
    } else {
      // Fallback: section markers (less preferred as it breaks up individual statute sections)
      const sectionSplitRegex =
        /(?=§\s*\d+|Section\s+\d+|SECTION\s+\d+|Article\s+[IVXLCDM]+)/i;
      sections = text
        .split(sectionSplitRegex)
        .filter((section) => section.trim());
      log(
        `Split into ${sections.length} sections by § markers (fallback method)`,
      );
    }
  }

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const sectionTokens = estimateTokenCount(section);
    log(
      `Processing section ${i + 1}: ${section.length} characters (~${sectionTokens} tokens)`,
    );

    if (section.length <= maxChunkSize && sectionTokens <= maxTokens) {
      // Section fits in one chunk based on both character and token limits
      chunks.push(section.trim());
      log(
        `  → Added as single chunk (${section.length} chars, ~${sectionTokens} tokens)`,
      );
    } else {
      // Section is too large, split by sentences while preserving structure
      log(`  → Section too large, splitting by sentences`);

      // Split by sentence endings, preserving the sentence endings
      const sentences = section.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
      log(`  → Found ${sentences.length} sentences`);

      let currentChunk = "";

      for (const sentence of sentences) {
        const proposedChunk =
          currentChunk + (currentChunk ? " " : "") + sentence;
        const proposedTokens = estimateTokenCount(proposedChunk);
        const wouldExceedCharLimit = proposedChunk.length > maxChunkSize;
        const wouldExceedTokenLimit = proposedTokens > maxTokens;
        const currentChunkHasContent = currentChunk.trim().length > 0;

        if (
          (wouldExceedCharLimit || wouldExceedTokenLimit) &&
          currentChunkHasContent
        ) {
          // Save current chunk and start new one
          const currentTokens = estimateTokenCount(currentChunk);
          chunks.push(currentChunk.trim());
          log(
            `  → Added sentence chunk (${currentChunk.length} chars, ~${currentTokens} tokens)`,
          );
          currentChunk = sentence;
        } else {
          // Add sentence to current chunk
          currentChunk = proposedChunk;
        }
      }

      // Add final chunk if it has content
      if (currentChunk.trim()) {
        const finalTokens = estimateTokenCount(currentChunk);
        chunks.push(currentChunk.trim());
        log(
          `  → Added final sentence chunk (${currentChunk.length} chars, ~${finalTokens} tokens)`,
        );
      }
    }
  }

  // Filter out very short chunks that might not contain meaningful content
  const filteredChunks = chunks.filter((chunk) => chunk.length > 400);

  // Final validation: ensure no chunk exceeds token limit with extra safety margin
  const validatedChunks = filteredChunks.filter((chunk) => {
    const tokens = estimateTokenCount(chunk);
    if (tokens > maxTokens) {
      console.warn(
        `⚠️ Filtering out oversized chunk: ${chunk.length} chars (~${tokens} tokens)`,
      );
      return false;
    }
    // Additional safety check - if a chunk is over 12000 characters, it's likely too big regardless of token estimate
    if (chunk.length > 12000) {
      console.warn(
        `⚠️ Filtering out large character chunk: ${chunk.length} chars (safety limit: 12000)`,
      );
      return false;
    }
    return true;
  });

  log(
    `Chunking complete: ${chunks.length} total chunks → ${filteredChunks.length} after filtering → ${validatedChunks.length} after token validation (removed ${chunks.length - validatedChunks.length} problematic chunks)`,
  );

  return validatedChunks;
}

// Legacy function for backward compatibility
function extractSectionReferences(text: string): string[] {
  const sectionRegex = /(?:§|Section)\s*(\d+(?:[.-]\d+)*[A-Z]*)/gi;
  const matches = [...text.matchAll(sectionRegex)];
  const sections = matches.map((match) => match[0]).slice(0, 3);
  return [...new Set(sections)];
}

// Enhanced source reference types
interface SourceRef {
  type: 'statute' | 'guidance' | 'form';
  name: string;
  url?: string;
  sections?: string[];
}

// Enhanced function to generate new object-based sourceRefs
function generateEnhancedSourceRefs(
  answer: string,
  metadata: any,
  referencedDocuments: Set<string> = new Set()
): SourceRef[] {
  const sourceRefs: SourceRef[] = [];
  
  // Extract section references from the answer
  const sections = extractSectionReferences(answer);
  
  // Add statute references if sections are found or statute is referenced
  if (sections.length > 0 || referencedDocuments.has('statute')) {
    const statuteSource = metadata.sources?.find((s: any) => s.type === 'statute');
    
    // For statute references, name should be the specific section(s), not the document title
    const statuteName = sections.length > 0 
      ? sections.join(', ') 
      : metadata.statuteNumber || 'Municipal Code';
    
    sourceRefs.push({
      type: 'statute',
      name: statuteName,
      url: statuteSource?.sourceUrl,
      sections: sections.length > 0 ? sections : undefined
    });
  }
  
  // Add guidance references if guidance document was referenced
  if (referencedDocuments.has('guidance')) {
    const guidanceSource = metadata.sources?.find((s: any) => s.type === 'guidance');
    if (guidanceSource) {
      sourceRefs.push({
        type: 'guidance',
        name: guidanceSource.title || 'Guidance Document',
        url: guidanceSource.sourceUrl
      });
    }
  }
  
  // Add form references if form document was referenced
  if (referencedDocuments.has('form')) {
    const formSource = metadata.sources?.find((s: any) => s.type === 'form');
    if (formSource) {
      sourceRefs.push({
        type: 'form',
        name: formSource.title || 'Application Form',
        url: formSource.sourceUrl
      });
    }
  }
  
  return sourceRefs;
}

// Function to detect which documents were referenced in the AI response
function detectReferencedDocuments(answer: string, aiResponse?: string): Set<string> {
  const referenced = new Set<string>();
  const textToAnalyze = `${answer} ${aiResponse || ''}`.toLowerCase();
  
  // Detect statute references
  if (textToAnalyze.includes('statute') || 
      textToAnalyze.includes('code') || 
      textToAnalyze.includes('§') ||
      /section\s+\d+/i.test(textToAnalyze)) {
    referenced.add('statute');
  }
  
  // Detect guidance document references
  if (textToAnalyze.includes('guidance') ||
      textToAnalyze.includes('guide') ||
      textToAnalyze.includes('explanation') ||
      textToAnalyze.includes('understanding') ||
      textToAnalyze.includes('clarification')) {
    referenced.add('guidance');
  }
  
  // Detect form document references
  if (textToAnalyze.includes('form') ||
      textToAnalyze.includes('application') ||
      textToAnalyze.includes('permit application') ||
      textToAnalyze.includes('fee') ||
      textToAnalyze.includes('$')) {
    referenced.add('form');
  }
  
  return referenced;
}

// Calculate environmental protection score based on answer content quality and specificity
function calculateAnswerScore(answer: string, confidence: number): number {
  // Normalize and clean the answer for analysis
  const lowerAnswer = answer.toLowerCase();

  // Category 1: No Protection (0.0-0.2)
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

  // Category 2: Minimal Protection (0.2-0.4)
  // General statements, state code references, vague language
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

  // Start with moderate base score for answers that specify something
  let score = 0.5;

  // Category 3: Moderate Protection - Add points for specific regulatory elements

  // Specific measurements and standards (+0.1 each)
  if (
    lowerAnswer.match(/\d+\s*(inches?|feet|days?|hours?|percent|%|dollars?|\$)/)
  )
    score += 0.15;
  if (
    lowerAnswer.includes("diameter") ||
    lowerAnswer.includes("dbh") ||
    lowerAnswer.includes("height")
  )
    score += 0.1;

  // Clear procedures and requirements (+0.1 each)
  if (lowerAnswer.includes("permit") || lowerAnswer.includes("application"))
    score += 0.1;
  if (lowerAnswer.includes("approval") || lowerAnswer.includes("authorization"))
    score += 0.1;
  if (lowerAnswer.includes("inspection") || lowerAnswer.includes("review"))
    score += 0.1;

  // Enforcement mechanisms (+0.1 each)
  if (
    lowerAnswer.includes("fine") ||
    lowerAnswer.includes("penalty") ||
    lowerAnswer.includes("violation")
  )
    score += 0.1;
  if (lowerAnswer.match(/\$\d+/) || lowerAnswer.includes("fee")) score += 0.1;

  // Environmental protection specifics (+0.1 each)
  if (
    lowerAnswer.includes("replacement") ||
    lowerAnswer.includes("replant") ||
    lowerAnswer.includes("restore")
  )
    score += 0.15;
  if (
    lowerAnswer.includes("native") ||
    lowerAnswer.includes("species") ||
    lowerAnswer.includes("indigenous")
  )
    score += 0.1;
  if (
    lowerAnswer.includes("prohibited") ||
    lowerAnswer.includes("required") ||
    lowerAnswer.includes("mandatory")
  )
    score += 0.1;

  // Comprehensive regulatory framework (+0.05 each)
  if (lowerAnswer.includes("arborist") || lowerAnswer.includes("professional"))
    score += 0.05;
  if (
    lowerAnswer.includes("plan") ||
    lowerAnswer.includes("schedule") ||
    lowerAnswer.includes("timeline")
  )
    score += 0.05;
  if (
    lowerAnswer.includes("notice") ||
    lowerAnswer.includes("hearing") ||
    lowerAnswer.includes("appeal")
  )
    score += 0.05;

  // Length bonus for comprehensive answers (but only if substantive)
  if (answer.length > 200 && !lowerAnswer.includes("does not")) score += 0.05;
  if (answer.length > 400 && !lowerAnswer.includes("does not")) score += 0.05;

  // Penalty for qualified/uncertain language
  if (
    lowerAnswer.includes("may") ||
    lowerAnswer.includes("might") ||
    lowerAnswer.includes("could")
  )
    score -= 0.05;
  if (
    lowerAnswer.includes("unclear") ||
    lowerAnswer.includes("vague") ||
    lowerAnswer.includes("limited")
  )
    score -= 0.1;

  // Cap at 1.0 and ensure minimum
  return Math.max(0.1, Math.min(1.0, score));
}

// Calculate normalized scores for an analysis with proper weighted scoring
function calculateNormalizedScores(answers: any[], questions: any[]): any {
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

  if (answers.length > 0 && questions.length > 0) {
    // Create a map of questions by ID for quick lookup
    const questionMap = new Map(questions.map(q => [String(q.id), q]));
    
    // Count questions with actual answers (not "Not specified")
    scores.questionsAnswered = answers.filter(
      (a) => a.answer !== "Not specified in the statute.",
    ).length;

    // Calculate average confidence
    scores.averageConfidence = Math.round(
      answers.reduce((sum, a) => sum + (a.confidence || 0), 0) / answers.length,
    );

    // Calculate weighted scores for each question
    let totalWeightedScore = 0;
    let totalPossibleWeight = 0;
    const questionsWithScores: any[] = [];

    for (const answer of answers) {
      const questionId = String(answer.questionId ?? answer.id);
      const question = questionMap.get(questionId);
      const weight = question?.weight ?? 1;
      const score = answer.score ?? 0;
      const weightedScore = score * weight;

      questionsWithScores.push({
        id: questionId,
        question: answer.question || question?.question || question?.text || '',
        answer: answer.answer || "Not analyzed",
        score,
        weight,
        weightedScore,
        maxWeightedScore: weight,
        confidence: answer.confidence ?? 0
      });

      totalWeightedScore += weightedScore;
      totalPossibleWeight += weight;
    }

    // Extract individual question scores
    scores.scoreBreakdown.questionScores = answers.map((a) => a.score || 0);

    // Calculate average question score (0-1 scale)
    scores.scoreBreakdown.averageQuestionScore =
      scores.scoreBreakdown.questionScores.reduce(
        (sum, score) => sum + score,
        0,
      ) / answers.length;

    // Calculate weighted score using proper weights
    scores.scoreBreakdown.totalWeightedScore = totalWeightedScore;
    scores.scoreBreakdown.totalPossibleWeight = totalPossibleWeight;
    scores.scoreBreakdown.questionsWithScores = questionsWithScores;
    
    // Calculate normalized score (0-1 scale) based on weighted scores
    const normalizedScore = totalPossibleWeight > 0 ? totalWeightedScore / totalPossibleWeight : 0;
    scores.scoreBreakdown.weightedScore = parseFloat(normalizedScore.toFixed(4));
    
    // The normalized score is scaled to 0-10 for display
    scores.normalizedScore = parseFloat((normalizedScore * 10).toFixed(2));

    // Keep legacy overallScore for backward compatibility (0-10 scale, same as normalizedScore)
    scores.overallScore = scores.normalizedScore;
  }

  return scores;
}

// Generate scores only for existing analysis files
async function generateScoresOnly(options: AnalyzeOptions) {
  // Determine data directory based on realm
  let dataDir = await PathResolver.getDataDir();

  if (options.realm) {
    try {
      const realmsPath = await PathResolver.getRealmsPath();
      if (await fileExists(realmsPath)) {
        const realmsData = JSON.parse(await fs.readFile(realmsPath, "utf-8"));
        const realmConfig = realmsData.realms?.find(
          (r) => r.id === options.realm,
        );
        if (realmConfig && realmConfig.datapath) {
          dataDir = await PathResolver.getRealmDataDir(realmConfig.datapath);
        }
      }
    } catch (error) {
      log(
        `Could not load realm configuration for generateScoresOnly:`,
        error.message,
      );
    }
  }

  // Get available domains from filesystem
  const getAvailableDomains = async (): Promise<string[]> => {
    if (!(await fileExists(dataDir))) return [];

    const entries = await fs.readdir(dataDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  };

  const domainsToProcess = options.domain
    ? [options.domain]
    : await getAvailableDomains();

  for (const domainId of domainsToProcess) {
    console.log(`\n📊 Processing domain: ${domainId}`);

    const domainDir = path.join(dataDir, domainId);
    if (!(await fileExists(domainDir))) {
      console.log(`⚠️  Domain directory not found: ${domainDir}`);
      continue;
    }

    // Get all municipality directories
    const municipalityDirs = await fs.readdir(domainDir, {
      withFileTypes: true,
    });
    const municipalities = municipalityDirs
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    // Load domain questions with weights
    const questionsPath = path.join(domainDir, "questions.json");
    let domainQuestions: any[] = [];
    
    if (await fileExists(questionsPath)) {
      const questionsContent = await fs.readFile(questionsPath, "utf-8");
      const questionsData = JSON.parse(questionsContent);
      domainQuestions = questionsData.questions || [];
    }

    for (const municipalityId of municipalities) {
      if (options.municipality && municipalityId !== options.municipality) {
        continue;
      }

      const analysisPath = path.join(
        domainDir,
        municipalityId,
        "analysis.json",
      );
      if (!(await fileExists(analysisPath))) {
        log(`⚠️  Analysis file not found: ${analysisPath}`);
        continue;
      }

      try {
        console.log(`🧮 ${municipalityId}: Calculating normalized scores...`);

        // Load existing analysis
        const analysisContent = await fs.readFile(analysisPath, "utf-8");
        const analysis = JSON.parse(analysisContent);

        // Skip if already has normalized scores (unless force)
        if (analysis.scores?.normalizedScore && !options.force) {
          console.log(
            `✓ ${municipalityId}: Already has normalized scores (use --force to recalculate)`,
          );
          continue;
        }

        // Recalculate individual question scores using new methodology
        const questions = analysis.questions || [];
        const updatedQuestions = questions.map((question) => ({
          ...question,
          score: parseFloat(
            calculateAnswerScore(
              question.answer || "",
              question.confidence || 50,
            ).toFixed(2),
          ),
        }));

        // Calculate normalized scores with updated question scores using question weights
        const scores = calculateNormalizedScores(updatedQuestions, domainQuestions);

        // Update the analysis with new scores and updated questions
        const updatedAnalysis = {
          ...analysis,
          questions: updatedQuestions, // Save updated questions with new scores
          scores: scores,
          overallScore: scores.normalizedScore, // Update legacy field
          normalizedScore: scores.normalizedScore,
          scoresUpdatedAt: new Date().toISOString(),
        };

        // Write updated analysis
        await fs.writeFile(
          analysisPath,
          JSON.stringify(updatedAnalysis, null, 2),
        );

        console.log(
          `✅ ${municipalityId}: Normalized score: ${scores.normalizedScore.toFixed(2)}/5.0 (${scores.questionsAnswered}/${scores.totalQuestions} questions answered)`,
        );
      } catch (error) {
        console.error(`❌ Error processing ${municipalityId}:`, error.message);
      }
    }
  }

  console.log(`\n🎉 Score generation complete!`);
}

// Generate gap analysis for individual questions
async function generateGapAnalysis(
  question: string,
  answer: string,
  confidence: number,
  municipality: string,
  domain: string,
  options: AnalyzeOptions = {},
): Promise<string | null> {
  try {
    // Calculate score to determine if gap analysis is needed
    const score = calculateAnswerScore(answer, confidence);

    // No gap analysis for perfect scores
    if (score >= 1.0) {
      return null;
    }

    // Load meta-analysis for context if available
    const metaAnalysis = await loadMetaAnalysis(domain);
    let metaContext = "";

    if (metaAnalysis && metaAnalysis.bestPractices) {
      // Find relevant best practice for this question by matching keywords or question ID
      const bestPractice = metaAnalysis.bestPractices.find((bp) => {
        if (!bp.questionText) return false;

        // Try exact match first
        if (bp.questionText.toLowerCase() === question.toLowerCase()) {
          return true;
        }

        // Try keyword matching for similar questions
        const questionWords = question
          .toLowerCase()
          .split(" ")
          .filter((word) => word.length > 3);
        const practiceWords = bp.questionText
          .toLowerCase()
          .split(" ")
          .filter((word) => word.length > 3);
        const matchCount = questionWords.filter((word) =>
          practiceWords.includes(word),
        ).length;

        // Require at least 2 keyword matches
        return matchCount >= 2;
      });

      if (bestPractice) {
        metaContext = `\n\nBEST PRACTICE CONTEXT: The highest-performing municipality (${bestPractice.bestMunicipality?.displayName || "unknown"}) achieved a score of ${bestPractice.bestScore}/1.0 with this approach: "${bestPractice.bestAnswer?.substring(0, 200)}..." Consider recommending similar comprehensive standards.`;
      }
    }

    // For "Not specified" answers or low confidence, still use AI-powered gap analysis
    // but with specialized prompts for missing information
    const isNotSpecified = answer === "Not specified in the statute.";
    const isLowConfidence = confidence < 40;

    // Generate targeted gap analysis using GPT-4o
    let gapPrompt: string;

    if (isNotSpecified || isLowConfidence) {
      // For missing or unclear statute information
      gapPrompt = `Analyze what appears to be missing from a municipal statute based on this question and result:

Question: ${question}
Municipality Result: ${answer}
Domain: ${domain}${metaContext}

The statute appears to not address this topic. Provide specific regulatory recommendations for what the municipality should establish:

${getQuestionTypeGuidance(question)}

IMPORTANT: Start your response with "Consider adding..." and provide one concrete, actionable recommendation (1 sentence max). Focus on what regulatory framework the municipality should establish.`;
    } else {
      // For substantive answers that could be improved
      gapPrompt = `Analyze this municipal statute answer for specific improvement opportunities:

Question: ${question}
Municipality Answer: ${answer}
Confidence: ${confidence}% | Score: ${score.toFixed(2)}/1.0${metaContext}

Identify SPECIFIC gaps and improvements (not generic advice). Focus on what's missing or could be strengthened in the existing regulation:

${getQuestionTypeGuidance(question)}

IMPORTANT: Start your response with "Consider adding..." to provide constructive recommendations for statute improvements.

Be specific about what improvements would strengthen this statute. If the statute is already comprehensive, respond with "Consider this statute comprehensive - no significant regulatory gaps identified"

Provide one concrete, actionable gap (1 sentence max):`;
    }

    // Rate limiting for gap analysis
    const estimatedTokens = estimateTokens(gapPrompt) + 150; // Add max_tokens estimate
    await checkRateLimit(estimatedTokens);

    const gapResponse = await openai.chat.completions.create({
      model: options.model || "gpt-4o",
      messages: [
        {
          role: "user",
          content: gapPrompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 150,
    });

    // Record actual token usage
    const actualTokens = gapResponse.usage?.total_tokens || estimatedTokens;
    recordTokenUsage(actualTokens);

    const gap = gapResponse.choices[0].message.content || null;

    // Don't return generic responses or responses that don't start correctly
    if (
      gap &&
      (gap.includes("establish comprehensive regulations") ||
        gap.includes("Gap analysis not available") ||
        gap.length < 20 ||
        gap.toLowerCase().startsWith("the answer"))
    ) {
      return null;
    }

    log(
      `Generated gap analysis for ${municipality}: ${gap?.substring(0, 100)}...`,
    );
    return gap;
  } catch (error) {
    log(`Error generating gap analysis: ${error.message}`);
    return null;
  }
}

// Parse time string like "15m", "2h", "1d" into milliseconds
function parseTimeToMs(timeStr: string): number {
  const match = timeStr.match(/^(\d+)([mhd])$/i);
  if (!match) {
    throw new Error(
      `Invalid time format: ${timeStr}. Use format like "15m", "2h", "1d"`,
    );
  }

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "m":
      return value * 60 * 1000; // minutes to milliseconds
    case "h":
      return value * 60 * 60 * 1000; // hours to milliseconds
    case "d":
      return value * 24 * 60 * 60 * 1000; // days to milliseconds
    default:
      throw new Error(`Unknown time unit: ${unit}`);
  }
}

// Check if analysis should be skipped based on --skip-recent parameter
async function shouldSkipRecentAnalysis(
  analysisPath: string,
  skipRecentTime: string,
): Promise<boolean> {
  try {
    if (!(await fileExists(analysisPath))) {
      return false; // No existing analysis, don't skip
    }

    const stats = await fs.stat(analysisPath);
    const ageMs = Date.now() - stats.mtime.getTime();
    const skipThresholdMs = parseTimeToMs(skipRecentTime);

    return ageMs < skipThresholdMs;
  } catch (error) {
    console.warn(`Error checking analysis age: ${error.message}`);
    return false; // If we can't determine age, don't skip
  }
}

// Helper function to get human-readable time ago string
async function getTimeAgoString(
  analysisPath: string,
  skipRecentTime: string,
): Promise<string> {
  try {
    const stats = await fs.stat(analysisPath);
    const ageMs = Date.now() - stats.mtime.getTime();
    const ageMinutes = Math.floor(ageMs / (1000 * 60));
    const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    if (ageDays > 0) {
      return `${ageDays}d ago`;
    } else if (ageHours > 0) {
      return `${ageHours}h ago`;
    } else {
      return `${ageMinutes}m ago`;
    }
  } catch (error) {
    return "unknown age";
  }
}

// Helper function to provide AI guidance based on question type
function getQuestionTypeGuidance(question: string): string {
  const lowerQuestion = question.toLowerCase();

  if (lowerQuestion.includes("permit")) {
    return "For permit questions: Focus on application procedures, review criteria, appeal processes, timelines, and approval standards.";
  }

  if (lowerQuestion.includes("penalt") || lowerQuestion.includes("fine")) {
    return "For penalty questions: Focus on fine amounts, escalation for repeat offenses, enforcement mechanisms, and violation categories.";
  }

  if (lowerQuestion.includes("fee")) {
    return "For fee questions: Focus on fee schedules, payment options, exemptions, and administrative cost coverage.";
  }

  if (
    lowerQuestion.includes("replant") ||
    lowerQuestion.includes("replacement")
  ) {
    return "For replacement questions: Focus on species requirements, survival monitoring, replacement ratios, and native plant preferences.";
  }

  if (lowerQuestion.includes("notif") || lowerQuestion.includes("neighbor")) {
    return "For notification questions: Focus on neighbor distance requirements, timing, notification methods, and affected party identification.";
  }

  if (lowerQuestion.includes("canopy")) {
    return "For canopy questions: Focus on coverage targets, measurement methods, maintenance plans, and long-term preservation strategies.";
  }

  if (
    lowerQuestion.includes("maintain") ||
    lowerQuestion.includes("responsibilit")
  ) {
    return "For maintenance questions: Focus on property owner duties, inspection schedules, care standards, and hazard management responsibilities.";
  }

  if (lowerQuestion.includes("data") || lowerQuestion.includes("report")) {
    return "For reporting questions: Focus on data collection requirements, public reporting, transparency measures, and tracking mechanisms.";
  }

  return "Focus on what specific regulatory framework, standards, or requirements the municipality should establish for this topic.";
}

function formatDomainName(domain: string): string {
  return domain
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function showHelp(): void {
  console.log(`
🔍 Municipal Statute & Policy Analysis with AI & Vector Search

This script analyzes municipal statutes and school district policies using OpenAI GPT-4o 
and Pinecone vector database to generate Q&A analysis for each entity and domain combination.

Usage:
  tsx scripts/analyzeStatutes.ts [options]

Options:
  --domain <name>           Process specific domain only (e.g., "property-maintenance")
  --municipality <id>       Process specific municipality only (e.g., "NY-Bedford-Town")
  --force                   Force re-analysis even if recent analysis exists
  --reindex                 Re-upload document chunks to Pinecone vector database
  --verbose, -v             Enable detailed logging of processing steps
  --fixorder                Fix question order in existing analysis.json files to match questions.json
  --setgrades               Copy grades from metadata.json to analysis.json WEN grades field
  --usemeta                 Compare analysis against meta-analysis best practices
  --questionId <id>         Analyze only the specified question ID (e.g., "9")
  --generate-meta           Generate meta-analysis after completing analysis
  --skip-recent <time>      Skip analysis if generated within specified time (e.g., "15m", "2h", "1d")
  --generate-score-only     Calculate and update normalized scores for existing analysis files
  --model <model>           AI model to use: gpt-4o, gpt-4o-mini, gpt-5, gpt-5-mini, gpt-4-turbo
  --help, -h               Show this help message

Examples:
  # Analyze all domains and municipalities with verbose output
  tsx scripts/analyzeStatutes.ts --verbose

  # Process only property-maintenance domain
  tsx scripts/analyzeStatutes.ts --domain property-maintenance

  # Force re-analysis of Bedford's property maintenance
  tsx scripts/analyzeStatutes.ts --domain property-maintenance --municipality NY-Bedford-Town --force

  # Process specific municipality with verbose logging
  tsx scripts/analyzeStatutes.ts --municipality NY-Ardsley-Village --verbose

  # Fix question order for all analysis files
  tsx scripts/analyzeStatutes.ts --fixorder

  # Generate normalized scores for existing analysis files
  tsx scripts/analyzeStatutes.ts --generate-score-only --domain trees --verbose

  # Fix question order for specific domain
  tsx scripts/analyzeStatutes.ts --domain property-maintenance --fixorder

  # Set WEN grades from metadata for all domains
  tsx scripts/analyzeStatutes.ts --setgrades

  # Set WEN grades for specific domain
  tsx scripts/analyzeStatutes.ts --domain property-maintenance --setgrades
  
  # Analyze with meta-analysis comparison to best practices
  tsx scripts/analyzeStatutes.ts --domain trees --municipality NY-Bedford-Town --usemeta --force

  # Skip analysis if generated within last 30 minutes
  tsx scripts/analyzeStatutes.ts --domain property-maintenance --skip-recent 30m

  # Skip analysis if generated within last 2 hours
  tsx scripts/analyzeStatutes.ts --skip-recent 2h

  # Generate meta-analysis after completing statute analysis
  tsx scripts/analyzeStatutes.ts --domain trees --generate-meta

  # Analyze only a specific question (useful when question text changes)
  tsx scripts/analyzeStatutes.ts --domain trees --questionId 9

  # Re-analyze a specific question for one municipality
  tsx scripts/analyzeStatutes.ts --domain trees --municipality NY-NewCastle-Town --questionId 9

Environment Variables Required:
  OPENAI_API_KEY          OpenAI API key for GPT-4o and embeddings
  PINECONE_API_KEY        Pinecone API key for vector database

Processing Details:
  - Uses text-embedding-3-small for vector embeddings
  - Chunks statute text into 1000-character segments
  - Searches top 5 most relevant chunks per question
  - Generates answers using GPT-4o with retrieved context
  - Returns "Not specified in the statute" when information not found
  - Calculates confidence scores based on vector similarity
`);
}

// CLI argument parsing
async function parseArgs() {
  const args = process.argv.slice(2);
  const options: AnalyzeOptions = {};

  // First check CURRENT_REALM environment variable
  if (process.env.CURRENT_REALM) {
    options.realm = process.env.CURRENT_REALM;
    console.log(
      `📖 Using CURRENT_REALM environment variable: ${options.realm}`,
    );
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
        break;
      case "--domain":
        options.domain = args[++i];
        break;
      case "--municipality":
        options.municipality = args[++i];
        break;
      case "--realm":
        options.realm = args[++i];
        // Set environment variable when --realm is provided
        process.env.CURRENT_REALM = options.realm;
        console.log(
          `💾 Set CURRENT_REALM environment variable from --realm parameter: ${options.realm}`,
        );
        break;
      case "--force":
        options.force = true;
        break;
      case "--reindex":
        options.reindex = true;
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--fixorder":
        options.fixOrder = true;
        break;
      case "--setgrades":
        options.setGrades = true;
        break;
      case "--usemeta":
        options.useMeta = true;
        break;
      case "--generate-meta":
        options.generateMeta = true;
        break;
      case "--questionId":
        options.questionId = args[++i];
        break;
      case "--skip-recent":
        options.skipRecent = args[++i];
        break;
      case "--generate-score-only":
        options.generateScoreOnly = true;
        break;
      case "--model":
        options.model = args[++i] as any;
        break;
      default:
        if (args[i].startsWith("-")) {
          // Handle --realm=value format
          if (args[i].startsWith("--realm=")) {
            options.realm = args[i].split("=")[1];
            // Set environment variable when --realm is provided
            process.env.CURRENT_REALM = options.realm;
            console.log(
              `💾 Set CURRENT_REALM environment variable from --realm parameter: ${options.realm}`,
            );
          } else {
            console.error(`Unknown option: ${args[i]}`);
            showHelp();
            process.exit(1);
          }
        }
    }
  }

  // If no realm is set, prompt user to select from available realms
  if (!options.realm) {
    try {
      const realmsPath = await PathResolver.getRealmsPath();
      if (await fileExists(realmsPath)) {
        const realmsData = JSON.parse(await fs.readFile(realmsPath, "utf-8"));
        const availableRealms = realmsData.realms || [];

        if (availableRealms.length === 0) {
          console.error("❌ No realms found in realms.json");
          process.exit(1);
        }

        console.log("\n🏛️  Available realms:");
        availableRealms.forEach((realm: any, index: number) => {
          const marker = realm.isDefault ? " (default)" : "";
          console.log(
            `  ${index + 1}. ${realm.id} - ${realm.displayName}${marker}`,
          );
        });

        // Find default realm
        const defaultRealm = availableRealms.find((r: any) => r.isDefault);
        if (defaultRealm) {
          options.realm = defaultRealm.id;
          process.env.CURRENT_REALM = defaultRealm.id;
          console.log(`\n🎯 Using default realm: ${defaultRealm.id}`);
          console.log(
            `💾 Set CURRENT_REALM environment variable: ${defaultRealm.id}`,
          );
        } else {
          console.error(
            "❌ No default realm found. Please set CURRENT_REALM environment variable or use --realm parameter.",
          );
          console.error(
            "Example: export CURRENT_REALM=westchester-municipal-environmental",
          );
          process.exit(1);
        }
      } else {
        console.error(
          "❌ realms.json not found. Cannot determine available realms.",
        );
        process.exit(1);
      }
    } catch (error) {
      console.error("❌ Error loading realms configuration:", error.message);
      process.exit(1);
    }
  }

  return options;
}

// Run the script
(async () => {
  const options = await parseArgs();
  analyzeStatutes(options).catch(console.error);
})();
