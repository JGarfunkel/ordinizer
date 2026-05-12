import dotenv from "dotenv";
dotenv.config();
import {
  loadModelConfig, setCurrentModel,
  getCurrentTokenUsage, estimateTokens, sleep, QUESTION_SET_PAUSE_MS,
  getModelRateLimit,
  setVerbose as setOpenaiVerbose,
  createChatCompletion,
} from "../services/aiService.js";
import { calculateAnswerScore, calculateNormalizedScores } from "./scoring.js";
import { getVectorService, VectorService, getDocumentKey, DocumentType } from "../services/vectorService.js";
import { Analysis, Ruleset, MetaAnalysis, getDefaultStorage, getRealmsFromStorage, IStorage, FileStat 

} from "@civillyengaged/ordinizer-servercore";

import { generateMetaAnalysis } from "./createMetaAnalysis.js";
import { indexEntity } from "./indexDocumentService.js";
import { generateGapAnalysis, loadMetaAnalysis } from "./analysisHelpers.js";
import { analyzeQuestions } from "./analyzeQuestions.js";
import { parseCommonCliArgs } from "./scriptArgs.js";

// TODO - put this into a config file or environment variable
const GRADING_ID = process.env.GRADING_ID || "${GRADING_ID}";
const MAX_WORDS_FOR_DIRECT_ANALYSIS = parseInt(process.env.MAX_WORDS_FOR_DIRECT_ANALYSIS || "1000", 10); // If statute text is under this word count, analyze directly without chunking
const USE_CONVERSATION = true;


// Storage singleton — initialized lazily with the correct data directory.
let _storage: IStorage | null = null;
async function getStorage(options: AnalyzeOptions): Promise<IStorage> {
  if (!_storage) {
    _storage = getDefaultStorage(options.realm || "");
  }
  return _storage;
}

export interface AnalyzeOptions {
  domain?: string;
  entity?: string;
  realm?: string; // Target realm for analysis
  force?: boolean;
  reindex?: boolean; // New: Re-upload statute chunks to Pinecone vector database
  verbose?: boolean;
  fixOrder?: boolean;
  setGrades?: boolean;
  useMeta?: boolean; // New: Compare against meta-analysis ideal answers
  generateMeta?: boolean; // New: Generate meta-analysis after completing analysis
  model?: "gpt-5.4-mini" | "gpt-5.4" | "gpt-5.5"; // Model selection for testing
  questionId?: string; // New: Analyze only specific question ID
  skipRecent?: string; // New: Skip analysis if generated within specified time (e.g., "15m", "2h", "1d")
  generateScoreOnly?: boolean; // New: Only calculate and update normalized scores without re-analyzing
  generateQuestions?: boolean; // New: Generate questions.json using AI if it doesn't exist
  dryRun?: boolean; // Perform a dry-run: load and plan analysis without making OpenAI calls or writing files
}

// Global verbose flag
let VERBOSE = false;

// Verbose logging helper
function log(message: string, ...args: any[]) {
  if (VERBOSE) {
    console.log(`[VERBOSE] ${message}`, ...args);
  }
}

// Safe error message extraction
function errMsg(error: unknown, withStack: boolean = false): string {
  if (error instanceof Error) {
    return withStack ? error.stack || error.message : error.message;
  }
  return String(error);
}

async function getVisibleDomainIds(
  st: IStorage,
  requestedDomain?: string,
): Promise<string[]> {
  const domains = await st.getDomains();
  const visibleDomains = domains.filter((domain) => domain.show !== false);

  if (!requestedDomain) {
    return visibleDomains.map((domain) => domain.id);
  }

  const requestedVisibleDomain = visibleDomains.find(
    (domain) => domain.id === requestedDomain || domain.name === requestedDomain,
  );
  if (requestedVisibleDomain) {
    return [requestedVisibleDomain.id];
  }

  const requestedDomainConfig = domains.find(
    (domain) => domain.id === requestedDomain || domain.name === requestedDomain,
  );
  if (requestedDomainConfig && requestedDomainConfig.show === false) {
    console.warn(
      `⚠️  Domain ${requestedDomain} is hidden (show=false); skipping per visible-domain filtering.`,
    );
  } else {
    console.warn(`⚠️  Domain ${requestedDomain} not found in realm domains config; skipping.`);
  }

  return [];
}

// Add meta-analysis comparison to existing analysis
async function addMetaAnalysisComparison(
  analysis: Analysis,
  metaAnalysis: MetaAnalysis,
  entityId: string,
): Promise<Analysis> {
  const updatedQuestions = analysis.questions.map((question) => {
    // Find the corresponding best practice from meta-analysis
    const bestPractice = metaAnalysis.bestPractices?.find(
      (bp) => bp.questionId === question.id,
    );

    if (bestPractice) {
      // Add comparison to the ideal answer
      const comparedToIdeal = {
        idealAnswer: bestPractice.bestAnswer,
        idealScore: bestPractice.bestScore,
        idealEntity: bestPractice.bestEntity.displayName,
        currentScore: question.score || 0,
        performanceGap: bestPractice.bestScore - (question.score || 0),
        improvementSuggestions: bestPractice.improvementSuggestions || [],
      };

      return {
        ...question,
        metaComparison: comparedToIdeal,
      };
    }

    return question;
  });

  // TODO - this is unused, we'll need to add it somehow
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
//    metaAnalysisSummary: metaSummary,
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
  const st = await getStorage(options);
  const domains = options.domain
    ? await getVisibleDomainIds(st, options.domain)
    : await getVisibleDomainIds(st);

  let totalUpdated = 0;
  let totalProcessed = 0;

  for (const domain of domains) {
    console.log(`\n📂 Processing domain: ${domain}`);
    const realm = options.realm ? await st.getRealm(options.realm) : null;
    if (options.realm && !realm) {
      console.log(`⚠️  Realm not found: ${options.realm}`);
      continue;
    }

    const entityIds = await getRequestedEntityIds(options, st, domain);

    for (const entityId of entityIds) {
      totalProcessed++;
      const metadata = await st.getRuleset(domain, entityId) as any;
      if (!metadata) {
        console.log(`⚠️  No metadata.json found for ${entityId}`);
        continue;
      }
      const analysis = await st.getAnalysis(domain, entityId, options.realm);
      if (!analysis) {
        console.log(`⚠️  No analysis.json found for ${entityId}`);
        continue;
      }

      let grade = null;
      if (metadata.originalCellValue) {
        const gradeMatch = metadata.originalCellValue.match(/^([GRY][+-]?)/i);
        if (gradeMatch) grade = gradeMatch[1].toUpperCase();
      } else if (metadata.grade) {
        grade = metadata.grade;
      }

      if (!grade) {
        console.log(`⚠️  No grade found in metadata for ${entityId}`);
        continue;
      }

      if (!analysis.grades) analysis.grades = {};
      const previousGrade = analysis.grades[GRADING_ID];
      analysis.grades[GRADING_ID] = grade;

      await st.saveAnalysis(analysis);
      console.log(`✅ Updated ${entityId}: ${previousGrade || "none"} → ${grade}`);
      totalUpdated++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Processed: ${totalProcessed} entities`);
  console.log(`   Updated: ${totalUpdated} grades`);
}
// Fix question order in existing analysis.json files
async function fixQuestionOrder(options: AnalyzeOptions) {

  const storage = await getStorage(options);
  const domains = options.domain
    ? await getVisibleDomainIds(storage, options.domain)
    : await getVisibleDomainIds(storage);

  let totalFixed = 0;
  let totalProcessed = 0;

  for (const domain of domains) {
    console.log(`\nProcessing domain: ${domain}`);
    const questions = await storage.getQuestionsByDomain(domain, options.realm);

    const entities: string[] = await getRequestedEntityIds(options, storage, domain);

    for (const entity of entities) {
      const analysis = await storage.getAnalysis(domain, entity);

      if (!analysis) {
        log(`Analysis file not found for ${entity}, skipping`);
        continue;
      }
      totalProcessed++;

      try {
        const existingQuestions = analysis.questions || [];
        if (existingQuestions.length === 0) {
          log(`No questions in analysis for ${entity}, skipping`);
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
          analysis.questions = reorderedQuestions;

          await storage.saveAnalysis(analysis);
          console.log(
            `${entity}: Fixed question order (${reorderedQuestions.length} questions)`,
          );
          totalFixed++;
        } else {
          log(`${entity}: Question order already correct`);
        }
      } catch (error) {
        console.error(
          `⚠️ ${entity}: Error fixing order - ${errMsg(error)}`,
        );
      }
    }
  }

  console.log(`\n📊 Question order fix complete!`);
  console.log(
    `📊 Processed ${totalProcessed} analysis files, fixed ${totalFixed} files`,
  );
}

// Intelligent question comparison function
function compareQuestions(
  newQuestions: any[],
  existingAnswers: any[],
  entity: string,
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
    `📊 ${entity}: Comparing ${newQuestions?.length || 0} current questions with ${existingAnswers?.length || 0} existing answers`,
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
          `✅ ${entity}: Question ${newQuestion.id} skipped (not target question), keeping existing answer`,
        );
      }
      continue;
    }

    if (!existingAnswer) {
      // New question - needs analysis
      questionsToAnalyze.push(newQuestion);
      const questionText = newQuestion.question || "No question text";
      console.log(
        `➕ ${entity}: New question ${newQuestion.id}: "${questionText.substring(0, 50)}..."`,

      );
    } else if (
      existingAnswer.question !== newQuestion.question ||
      specificQuestionId
    ) {
      // Question wording changed OR specific question ID requested - needs re-analysis
      questionsToAnalyze.push(newQuestion);
      if (specificQuestionId) {
        console.log(
          `🎯 ${entity}: Targeting question ${newQuestion.id} for re-analysis`,
        );
      } else {
        console.log(
          `🔄 ${entity}: Question ${newQuestion.id} wording changed, re-analyzing`,
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
        `✅ ${entity}: Question ${newQuestion.id} unchanged, keeping existing answer`,
      );
    }
  }

  // Check for questions that exist in analysis but not in current questions with safety check
  for (const existingAnswer of existingAnswers || []) {
    if (!newQuestionsMap.has(existingAnswer.id)) {
      questionsToRemove.push(existingAnswer);
      const questionText = existingAnswer.question || "No question text";
      console.log(
        `🗑️  ${entity}: Removing obsolete question ${existingAnswer.id}: "${questionText.substring(0, 50)}..."`,
      );
    }
  }

  const summary = {
    toAnalyze: questionsToAnalyze.length,
    toKeep: questionsToKeep.length,
    toRemove: questionsToRemove.length,
  };

  console.log(
    `📈 ${entity}: Analysis plan - ${summary.toAnalyze} to analyze, ${summary.toKeep} to keep, ${summary.toRemove} to remove`,
  );

  return {
    questionsToAnalyze,
    questionsToKeep,
    questionsToRemove,
  };
}

export async function analyzeStatutes(options: AnalyzeOptions = {}) {
  VERBOSE = options.verbose || false;
  if (!options.realm) {
    throw new Error(" Realm is required to analyze the statutes");
  }
  const vectorService = getVectorService(options.realm);
  vectorService.setVerbose(VERBOSE);
  setOpenaiVerbose(VERBOSE);

  // Load model configuration first
  await loadModelConfig();

  // Set current model if specified in options
  if (options.model) {
    setCurrentModel(options.model);
    console.log(
      `🤖 Using AI model: ${options.model} (${getModelRateLimit()} TPM)`,
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
      `📊 Setting ${GRADING_ID} grades from metadata.json to analysis.json files`,
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

  const st = await getStorage(options);

  const domains = options.domain
    ? await getVisibleDomainIds(st, options.domain)
    : await getVisibleDomainIds(st);

  log(`Found ${domains.length} domains to process:`, domains);

  for (const domain of domains) {
    console.log(`\n📁 Processing domain: ${domain}`);

    // Get entities to process
    const entities = await getRequestedEntityIds(options, st, domain);

    // Initialize Pinecone index
    const indexName = "ordinizer-statutes";
    log(`Initializing Pinecone index: ${indexName}`);

    // Check if index exists, create if it doesn't
    await vectorService.initializeIndex();

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const madeOpenAICalls = await processEntity(
        domain,
        entity,
        vectorService,
        options,
      );

      // Add pause between entities only if OpenAI calls were made
      if (i < entities.length - 1 && madeOpenAICalls) {
        console.log(
          `⏳ Pausing ${QUESTION_SET_PAUSE_MS}ms before next entity...`,
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
        await generateMetaAnalysis(st, targetDomain);
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

async function getRequestedEntityIds(options: AnalyzeOptions, st: IStorage, domain: string) {
  return options.entity
    ? [options.entity]
    : await st.getEntityIds(domain);
}

// Returns true if there are no questions or the array is empty
function hasEmptyAnalysisQuestions(existingAnalysis: any): boolean {
  return !existingAnalysis?.questions || existingAnalysis.questions.length === 0;
}

// Returns true if questions.json has changed (i.e., questions to analyze exist)
async function questionsJsonChanged(
  st: IStorage,
  domain: string,
  existingAnalysis: any,
  entity: string,
  options: AnalyzeOptions
): Promise<boolean> {
  try {
    const questionsArray = await st.getQuestionsByDomain(domain, options.realm);
    if (questionsArray.length === 0) return false;
    const { questionsToAnalyze } = compareQuestions(
      questionsArray,
      existingAnalysis?.questions || [],
      entity,
      options.questionId
    );
    return questionsToAnalyze.length > 0;
  } catch (error) {
    log(`Error checking questions changes: ${errMsg(error)}`);
    return true; // Force re-analysis if we can't check
  }
}

// Returns true if statute file is newer than analysis file
async function checkIfAnalysisRefreshNeeded(
  st: IStorage,
  domain: string,
  entity: string,
  analysisStat: FileStat,
  options: AnalyzeOptions
): Promise<boolean> {
  const docStat = await st.getDocumentStat(domain, entity, options.realm);
  if (docStat.exists && docStat.mtime > analysisStat.mtime) {
    log(`Statute file is newer than analysis (statute: ${docStat.mtime.toISOString()}, analysis: ${analysisStat.mtime.toISOString()})`);
    return true;
  }
  return false;
}



async function processEntity(
  domain: string,
  entity: string,
  vectorService: VectorService,
  options: AnalyzeOptions = {},
): Promise<boolean> {
  const st = await getStorage(options);
  const force = options.force || false;
  const useMeta = options.useMeta || false;
  const questionId = options.questionId;
  const skipRecent = options.skipRecent;

  // Check if analysis should be skipped based on --skip-recent parameter
  if (
    !force &&
    skipRecent &&
    (await shouldSkipRecentAnalysis(st, domain, entity, skipRecent))
  ) {
    const timeAgo = await getTimeAgoString(st, domain, entity);
    console.log(
      `⏭️  ${entity}: Analysis is recent (${timeAgo}), skipping due to --skip-recent ${skipRecent}`,
    );
    return false; // No OpenAI calls made
  }

  // Check if analysis exists and is recent, and if statute is newer than analysis
  const analysisStat = await st.getAnalysisStat(domain, entity);
  const existingAnalysis = await st.getAnalysis(domain, entity);
  
  if (!force && analysisStat.exists) {
    const ageInDays = (Date.now() - analysisStat.mtime.getTime()) / (1000 * 60 * 60 * 24);
    try {
      if (hasEmptyAnalysisQuestions(existingAnalysis)) {
        console.log(`🔄 ${entity}: Analysis exists but has no questions, re-analyzing`);
        log(`Analysis has ${existingAnalysis?.questions?.length || 0} questions`);
        // Continue with analysis - don't return here
      } else if (await questionsJsonChanged(st, domain, existingAnalysis, entity, options)) {
        console.log(`🔄 ${entity}: Questions have changed, re-analyzing`);
        // Continue with analysis - don't return here
      } else if (await checkIfAnalysisRefreshNeeded(st, domain, entity, analysisStat, options)) {
        // Statute file is newer than analysis
        const docStat = await st.getDocumentStat(domain, entity, options.realm);
        console.log(`🔄 ${entity}: Statute file is newer than analysis (statute: ${docStat.mtime.toISOString()}, analysis: ${analysisStat.mtime.toISOString()}), re-analyzing`);
        log(`Statute modified: ${docStat.mtime.toISOString()}`);
        log(`Analysis modified: ${analysisStat.mtime.toISOString()}`);
        // Continue with analysis - don't return here
      } else if (!skipRecent && ageInDays < 30) {
        console.log(`⏭️  ${entity}: Analysis is recent (${ageInDays.toFixed(1)} days old) and statute unchanged, skipping`);
        if (options.reindex) {
          await indexEntity(entity, { ...options, force: true });
        }
        return false; // No OpenAI calls made
      }
    } catch (error) {
      console.log(`🔄 ${entity}: Analysis file is corrupted or unreadable, re-analyzing`);
      log(`Error reading analysis file: ${errMsg(error)}`);
      // Continue with analysis - don't return here
    }
  }
  console.log(`🔍 Processing ${entity}...`);

  try {
    // Check if required files exist
    const hasMetadata = await st.rulesetExists(domain, entity);
    const hasDocument = await st.documentExists(domain, entity);
    // if (!hasMetadata || !hasDocument) {
    //   console.log(
    //     `⚠️  ${entity}: Missing metadata or statute file, skipping`,
    //   );
    //   log(
    //     `Metadata exists: ${hasMetadata}, Document exists: ${hasDocument}`,
    //   );
    //   return false; // No OpenAI calls made
    // }

    let metadata = await st.getRuleset(domain, entity) as Ruleset;
    log(
      `Loaded metadata for ${entity}:`,
      JSON.stringify(metadata, null, 2),
    );

    // create metadata if it doesn't exist (to avoid errors in analysis)
    if (!metadata) {
      const entityObj = await st.getEntity(entity);
      if (!entityObj) {
        log(`Entity object not found for ${entity}, creating metadata with limited info`);
        throw new Error(`Metadata not found for ${entity} and entity object could not be loaded`);
      }
      metadata = {
        entityId: entity,
        domainId: domain,
        domain: domain,
        sources: [],
        metadataCreated: new Date().toISOString(),
        homePage: "",
        municipality: entityObj.name,
        municipalityType: entityObj.type
      };
      await st.saveRuleset(metadata);
      log(`Created default metadata for ${entity}`);
    }

    const questionsArray = await st.getQuestionsByDomain(domain, options.realm);
    log(`Loaded ${questionsArray.length} questions for domain ${domain}`);

    // Check if this uses state code or local ordinance
    // const isStateCode = metadata?.sourceUrl?.includes(
    //   "up.codes/viewer/new_york/ny-property-maintenance-code-2020",
    // );
    // log(`Entity ${entity} uses state code: ${isStateCode}`);

    let analysis: GeneratedAnalysisResult;

    // Process with vector analysis for local ordinances
    analysis = await generateVectorAnalysis(
      entity,
      domain,
      metadata,
      questionsArray,
      vectorService,
      options,
    );

    // Add meta-analysis comparison if requested
    if (useMeta) {
      const metaAnalysis = await loadMetaAnalysis(domain);
      if (metaAnalysis) {
        analysis = (await addMetaAnalysisComparison(
          analysis as Analysis,
          metaAnalysis,
          entity,
        )) as GeneratedAnalysisResult;
        console.log(`🎯 ${entity}: Added meta-analysis comparison`);
      } else {
        console.log(
          `⚠️  ${entity}: No meta-analysis found for comparison`,
        );
      }
    }

    if (options.dryRun) {
      console.log(`🧪 ${entity}: Dry-run mode active, skipping analysis save`);
      return false;
    }

    await st.saveAnalysis(analysis as Parameters<IStorage["saveAnalysis"]>[0]);
    console.log(`✅ ${entity}: Analysis complete`);
    return true; // OpenAI calls were made
  } catch (error) {
    if (errMsg(error).includes("HTML content")) {
      console.error(`🚫 SKIPPED ${entity}: ${errMsg(error)}`);
      console.error(
        `   Please run convertHtmlToText.ts on this statute file first.`,
      );
    } else {
      console.error(`❌ Failed to process ${entity}:`, errMsg(error, true));
    }
    return false; // No successful OpenAI calls made
  }
}

  /**
   * @deprecated This function handles state code analysis for property-maintenance entities using NY State code.
   * It is deprecated and should be replaced with a more generic, configurable approach in the future.
   */
  async function handleStateCodeAnalysis({
      st,
      domain,
      entity,
      metadata,
      questionsArray,
      force,
      questionId,
    }: {
      st: any;
      domain: string;
      entity: string;
      metadata: any;
      questionsArray: any[];
      force: boolean;
      questionId?: string;
    }): Promise<any> {
      let existingAnalysis: any = null;
      if (force) {
        console.log(
          `🔄 ${entity}: Force mode - clearing existing analysis and reanalyzing all questions`,
        );
        if (typeof log === "function") log(`Force mode enabled - ignoring existing analysis.json`);
      } else {
        try {
          existingAnalysis = await st.getAnalysis(domain, entity);
        } catch (error) {
          if (typeof log === "function") log(`Could not load existing analysis: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const { questionsToAnalyze, questionsToKeep, questionsToRemove } =
        compareQuestions(
          questionsArray,
          force && !questionId ? [] : existingAnalysis?.questions || [],
          entity,
          questionId,
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
          `✅ ${entity}: No changes needed - all ${questionsToKeep.length} state code questions are up to date`,
        );
      } else {
        console.log(
          `✅ ${entity}: State code analysis updated - ${newAnswers.length} newly processed, ${questionsToKeep.length} kept, ${questionsToRemove.length} removed`,
        );
      }

      // Extract GRADING_ID grade from metadata for state code analysis
      const GRADING_ID = process.env.GRADING_ID || "${GRADING_ID}";
      const grades: { [key: string]: string | null } = {};

      if (metadata.originalCellValue) {
        const gradeMatch = metadata.originalCellValue.match(/^([A-Z][+-]?)\s/);
        if (gradeMatch) {
          grades[GRADING_ID] = gradeMatch[1];
          if (typeof log === "function") log(`Extracted ${GRADING_ID} grade from originalCellValue: ${grades[GRADING_ID]}`);
        }
      }

      if (!grades[GRADING_ID] && metadata.grade) {
        grades[GRADING_ID] = metadata.grade;
        if (typeof log === "function") log(`Using metadata.grade as ${GRADING_ID} grade: ${grades[GRADING_ID]}`);
      }

      return {
        municipality: {
          id: entity,
          displayName: `${metadata.municipalityName} - ${metadata.municipalityType}`,
        },
        domain: {
          id: domain,
          displayName: (typeof formatDomainName === "function" ? formatDomainName(domain) : domain),
        },
        grades,
        questions: allAnswers,
        lastUpdated: new Date().toISOString(),
        processingMethod: "state-code-detection",
        usesStateCode: true,
      };
    }


interface AnalysisContent {
  includeFullStatuteText: boolean;
  statuteText: string;
  authoritativeDocumentType?: DocumentType;
}

type GeneratedAnalysisResult = {
  entityId: string;
  domainId: string;
  entity: { id: string; displayName: string };
  domain: string | { id: string; displayName: string };
  questions: any[];
  scores?: any;
  overallScore?: number;
  averageConfidence?: number;
  questionsAnswered?: number;
  totalQuestions?: number;
  analyzedAt?: string;
  lastUpdated?: string;
  processingMethod?: string;
  usesStateCode?: boolean;
  grades?: { [key: string]: string | null };
  gapAnalysis?: string;
};

async function buildAnswersFromResults(
  entity: string,
  domain: string,
  questionsToAnalyze: any[],
  results: Array<{
    answer: string;
    confidence: number;
    sourceRefs?: string[];
    vectorTokensUsed?: number;
    researchSuggestions?: string[];
  }>,
  model: AnalyzeOptions["model"],
  includeAnalyzedAt: boolean,
  dryRun: boolean,
): Promise<{ newAnswers: any[]; totalVectorTokens: number }> {
  const newAnswers: any[] = [];
  let totalVectorTokens = 0;

  for (let i = 0; i < questionsToAnalyze.length; i++) {
    const question = questionsToAnalyze[i];
    const result = results[i];

    if (result.vectorTokensUsed) {
      totalVectorTokens += result.vectorTokensUsed;
    }

    const score = calculateAnswerScore(result.answer, result.confidence);
    let gap: string | null = null;
    if (!dryRun) {
      gap = await generateGapAnalysis(
        question.question,
        result.answer,
        result.confidence,
        entity,
        domain,
        calculateAnswerScore,
        model,
      );
    }

    const newAnswer: any = {
      id: question.id,
      question: question.question,
      answer: result.answer,
      confidence: result.confidence,
      sourceRefs: result.sourceRefs || [],
      score: parseFloat(score.toFixed(2)),
    };

    if (result.researchSuggestions && result.researchSuggestions.length > 0) {
      newAnswer.vectorResearchSuggestions = result.researchSuggestions;
      console.log(
        `🧭 ${entity}: Question ${question.id} suggests further vector research: ${result.researchSuggestions.join(", ")}`,
      );
    } else if (
      /further research|additional (?:research|documents|sources)|need more information|look for documents/i.test(
        result.answer || "",
      )
    ) {
      console.log(
        `🧭 ${entity}: Question ${question.id} answer suggests further vector research.`,
      );
    }

    if (includeAnalyzedAt) {
      newAnswer.analyzedAt = new Date().toISOString();
    }

    if (gap) {
      newAnswer.gap = gap;
    }

    newAnswers.push(newAnswer);
  }

  return {
    newAnswers,
    totalVectorTokens,
  };
}

async function getPrioritizedDiscoveredChunks(
  vectorService: VectorService,
  questionText: string,
  entity: string,
  domain: string,
  domainForEntityText: string,
  isGeneralDomain: boolean,
  authoritativeDocumentType: DocumentType | undefined,
): Promise<{ chunks: string[]; sourceRefs: string[]; tokenUsage: number }> {
  const uniqueRefs = new Set<string>();
  let tokenUsage = 0;

  const mergeRefs = (refs: string[] | undefined) => {
    for (const ref of refs || []) {
      if (ref) uniqueRefs.add(ref);
    }
  };

  if (isGeneralDomain) {
    const sharedOnly = await vectorService.getRelevantChunksForQuestion(
      questionText,
      entity,
      domain,
      5,
      "shared",
    );
    tokenUsage += sharedOnly.tokenUsage;
    mergeRefs(sharedOnly.sourceRefs);
    return {
      chunks: sharedOnly.chunks,
      sourceRefs: [...uniqueRefs],
      tokenUsage,
    };
  }

  const authoritative = authoritativeDocumentType
    ? await vectorService.getRelevantChunksForQuestion(
        questionText,
        entity,
        domain,
        5,
        authoritativeDocumentType,
      )
    : { chunks: [], sourceRefs: [], tokenUsage: 0 };

  tokenUsage += authoritative.tokenUsage;
  mergeRefs(authoritative.sourceRefs);

  const shared = await vectorService.getRelevantChunksForQuestion(
    questionText,
    entity,
    domain,
    5,
    "shared",
  );

  tokenUsage += shared.tokenUsage;
  mergeRefs(shared.sourceRefs);

  if (authoritative.chunks.length > 0 && shared.chunks.length > 0) {
    return {
      chunks: [...authoritative.chunks, ...shared.chunks],
      sourceRefs: [...uniqueRefs],
      tokenUsage,
    };
  }

  if (authoritative.chunks.length > 0) {
    return {
      chunks: authoritative.chunks,
      sourceRefs: [...uniqueRefs],
      tokenUsage,
    };
  }

  if (shared.chunks.length > 0) {
    // Optionally prepend a notice chunk
    return {
      chunks: [`There are no known statutes for ${domainForEntityText}.`, ...shared.chunks],
      sourceRefs: [...uniqueRefs],
      tokenUsage,
    };
  }

  return {
    chunks: [],
    sourceRefs: [],
    tokenUsage,
  };
}

/**
 * Run conversation-mode analysis for questions
 */
async function runConversationAnalysis(
  domain: string,
  entity: string,
  domainForEntityText: string,
  questionsToAnalyze: any[],
  statute: string | undefined,
  statuteSize: number,
  isGeneralDomain: boolean,
  vectorService: VectorService,
  authoritativeDocumentType: DocumentType | undefined,
  questionsToKeep: any[],
  options: AnalyzeOptions,
): Promise<{ newAnswers: any[]; totalVectorTokens: number }> {
  console.log(
    `💬 ${entity}: Using conversation mode for ${questionsToAnalyze.length} questions (statute: ${statuteSize.toLocaleString()} chars)`,
  );

  const conversationStartTokens = getCurrentTokenUsage();
  const conversationResults = await analyzeQuestions({
    mode: statute ? "full" : "chunks",
    domain,
    entity,
    domainForEntityText,
    questions: questionsToAnalyze,
    model: options.model,
    verbose: options.verbose,
    dryRun: options.dryRun,
    isGeneralDomain,
    fullText: statute,
    getDiscoveredChunks: async (questionText: string) => {
      return getPrioritizedDiscoveredChunks(
        vectorService,
        questionText,
        entity,
        domain,
        domainForEntityText,
        isGeneralDomain,
        authoritativeDocumentType,
      );
    },
    existingAnswersContextBuilder: () =>
      questionsToKeep.length > 0
        ? `\n\nNOTE: Other questions in this analysis have already covered these topics:\n${questionsToKeep.map((q) => `- Q${q.id}: ${q.answer.substring(0, 100)}...`).join("\n")}\n\nProvide unique information that doesn't repeat what's already been covered.`
        : "",
  });

  const conversationEndTokens = getCurrentTokenUsage();
  const conversationTokensUsed = conversationEndTokens - conversationStartTokens;
  if (VERBOSE) {
    log(`Conversation mode analysis: ${conversationTokensUsed} tokens for ${questionsToAnalyze.length} questions`);
  }

  return buildAnswersFromResults(
    entity,
    domain,
    questionsToAnalyze,
    conversationResults,
    options.model,
    false,
    options.dryRun || false,
  );
}

/**
 * Run vector-mode analysis for questions
 */
async function runVectorAnalysis(
  domain: string,
  entity: string,
  domainForEntityText: string,
  questionsToAnalyze: any[],
  questionsToKeep: any[],
  statuteSize: number,
  isGeneralDomain: boolean,
  authoritativeDocumentType: DocumentType | undefined,
  vectorService: VectorService,
  options: AnalyzeOptions,
): Promise<{ newAnswers: any[]; totalVectorTokens: number }> {
  console.log(
    `🔍 ${entity}: Using vector mode for ${questionsToAnalyze.length} questions (statute: ${statuteSize.toLocaleString()} chars), authoritativeDocumentType=${authoritativeDocumentType || "undefined"}`,
  );

  const chunkResults = await analyzeQuestions({
    mode: "chunks",
    domain,
    entity,
    domainForEntityText,
    questions: questionsToAnalyze,
    model: options.model,
    verbose: options.verbose,
    dryRun: options.dryRun,
    isGeneralDomain,
    getDiscoveredChunks: async (questionText: string) => {
      return getPrioritizedDiscoveredChunks(
        vectorService,
        questionText,
        entity,
        domain,
        domainForEntityText,
        isGeneralDomain,
        authoritativeDocumentType,
      );
    },
    existingAnswersContextBuilder: () =>
      questionsToKeep.length > 0
        ? `\n\nNOTE: Other questions in this analysis have already covered these topics:\n${questionsToKeep.map((q) => `- Q${q.id}: ${q.answer.substring(0, 100)}...`).join("\n")}\n\nProvide unique information that doesn't repeat what's already been covered.`
        : "",
  });

  return buildAnswersFromResults(
    entity,
    domain,
    questionsToAnalyze,
    chunkResults,
    options.model,
    true,
    options.dryRun || false,
  );
}

/**
 * Enhance existing questions with gap analysis where needed
 */
async function enhanceQuestionsWithGapAnalysis(
  entity: string,
  domain: string,
  questionsToKeep: any[],
  questionId: string | undefined,
  options: AnalyzeOptions,
): Promise<any[]> {
  const enhancedQuestionsToKeep: any[] = [];

  for (const existingQuestion of questionsToKeep) {
    const score =
      existingQuestion.score !== undefined
        ? parseFloat(existingQuestion.score.toFixed(2))
        : parseFloat(
            calculateAnswerScore(
              existingQuestion.answer,
              existingQuestion.confidence || 50,
            ).toFixed(2),
          );

    if (!options.dryRun && !questionId && !existingQuestion.gap && score < 1.0) {
      console.log(
        `🔎 ${entity}: Adding missing gap analysis for question ${existingQuestion.id} (score: ${score.toFixed(2)})`,
      );
      const gap = await generateGapAnalysis(
        existingQuestion.question,
        existingQuestion.answer,
        existingQuestion.confidence || 50,
        entity,
        domain,
        calculateAnswerScore,
        options.model,
      );

      const enhanced: any = {
        ...existingQuestion,
        score: parseFloat(score.toFixed(2)),
      };

      if (gap) {
        enhanced.gap = gap;
      }

      enhancedQuestionsToKeep.push(enhanced);
    } else if (!questionId && existingQuestion.gap && score >= 1.0) {
      console.log(
        `🔎 ${entity}: Removing gap from question ${existingQuestion.id} (perfect score: ${score.toFixed(2)})`,
      );
      const { gap, ...questionWithoutGap } = existingQuestion;
      enhancedQuestionsToKeep.push({
        ...questionWithoutGap,
        score: parseFloat(score.toFixed(2)),
      });
    } else {
      enhancedQuestionsToKeep.push({
        ...existingQuestion,
        score: parseFloat(score.toFixed(2)),
      });
    }
  }

  return enhancedQuestionsToKeep;
}

/**
 * Log token usage details for analysis
 */
function logTokenUsageSummary(
  entity: string,
  useConversationMode: boolean,
  questionsToAnalyze: any[],
  municipalityTokensUsed: number,
  statuteTokens: number,
  totalVectorTokens: number,
): string {
  const analysisMethod = useConversationMode
    ? questionsToAnalyze.length > 1
      ? "conversation"
      : "direct"
    : "vector";

  console.log(
    `📊 ${entity}: Token usage summary (${analysisMethod} mode):`,
  );
  console.log(
    `   Total tokens used: ${municipalityTokensUsed.toLocaleString()}`,
  );
  console.log(`   Statute size: ${statuteTokens.toLocaleString()} tokens`);
  console.log(`   Questions analyzed: ${questionsToAnalyze.length}`);

  if (VERBOSE) {
    log(
      `Entity analysis: ${municipalityTokensUsed} tokens for ${questionsToAnalyze.length} questions using ${analysisMethod} mode`,
    );
  }

  if (!useConversationMode && questionsToAnalyze.length > 0) {
    const denominator = statuteTokens > 0 ? statuteTokens : Math.max(totalVectorTokens, 1);
    const vectorEfficiency = (
      (totalVectorTokens / denominator) *
      100
    ).toFixed(1);
    const worthIt = statuteTokens > 0 ? totalVectorTokens < statuteTokens * 0.8 : true;

    console.log(
      `   Vector chunks used: ${totalVectorTokens.toLocaleString()} tokens (${vectorEfficiency}% of statute)`,
    );
    if (statuteTokens > 0) {
      console.log(
        `   Vector approach: ${worthIt ? "✅ Efficient" : "⚠️  Consider conversation mode"} (${worthIt ? "Used less than 80%" : "Used more than 80%"} of statute tokens)`,
      );
    }

    if (VERBOSE) {
      log(
        `Vector efficiency: ${vectorEfficiency}% - Statute: ${statuteTokens} tokens, Vector chunks: ${totalVectorTokens} tokens`,
      );
    }
  }

  return analysisMethod;
}

const newLocal = 1000;
/**
 * Fetches and validates the statute text, triggers any necessary reindexing,
 * and determines which analysis mode to use:
 *   "direct"       — statute < 1000 words; pass full text to LLM directly
 *   "conversation" — statute ≤ 50 000 chars; pass full text in a single LLM conversation
 *   "vector"       — statute > 50 000 chars; query Pinecone per question
 */
async function prepareAnalysisContent(
  entity: string,
  domain: string,
  vectorService: VectorService,
  options: AnalyzeOptions,
): Promise<AnalysisContent> {
  const st = await getStorage(options);
  const domainConfig = await st.getDomain(domain);
  const realmConfig = options.realm ? await st.getRealm(options.realm) : undefined;
  const isGeneralDomain = domainConfig?.type === "general";
  const authoritativeDocumentType: DocumentType = realmConfig?.ruleType === "policy" ? "policy" : "statute";

  if (options.reindex) {
      await indexEntity(entity, { ...options, force: true });
  }

  if (isGeneralDomain) {
    return {
      includeFullStatuteText: false,
      statuteText: "",
    };
  }

  // for statute files
  const ruleset = st.getRuleset(domain, entity); // will throw if ruleset/metadata.json is missing, which is required for analysis

  const text = await st.getDocumentText(domain, entity, options.realm);
  if (!text) {
    console.log("No text found in statute document, but we can use other documents.");
    return {
      includeFullStatuteText: false,
      statuteText: "",
      authoritativeDocumentType,
    };
  }

   // Unsure if need the below - these were guards for an earlier time
  // if (isHtmlContent(text)) {
  //   throw new Error(
  //     `Statute file contains HTML content instead of plain text. File needs to be converted from HTML to text before analysis.`,
  //   );
  // }

  // if (text.length > 5000000) {
  //   throw new Error(
  //     `Statute file is too large (${text.length} bytes). This may indicate a corrupted file.`,
  //   );
  // }

  // const binaryContentRegex = /[\x00-\x08\x0E-\x1F\x7F-\x9F\u2000-\u200F\uFEFF]/;
  // if (binaryContentRegex.test(text.substring(0, 1000))) {
  //   throw new Error(
  //     `Statute file appears to contain binary data instead of text. File may be corrupted.`,
  //   );
  // }

  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount < MAX_WORDS_FOR_DIRECT_ANALYSIS) {
    return {
      includeFullStatuteText: true,
      statuteText: text,
      authoritativeDocumentType,
    };
  }

  // For longer statutes, rely on vector retrieval for both statutes and EntityDownloads.
  console.log(`[DEBUG] prepareAnalysisContent for ${entity}/${domain}: statute is ${wordCount.toLocaleString()} words (>= ${MAX_WORDS_FOR_DIRECT_ANALYSIS}), using vector retrieval`);
  return {
    includeFullStatuteText: false,
    statuteText: "",
    authoritativeDocumentType,
  };
}

async function generateVectorAnalysis(
  entity: string,
  domain: string,
  metadata: Ruleset,
  questions: any[],
  vectorService: VectorService,
  options: AnalyzeOptions = {},
): Promise<GeneratedAnalysisResult> {
  const st = await getStorage(options);
  const force = options.force || false;
  const questionId = options.questionId;

  const content = await prepareAnalysisContent(entity, domain, vectorService, options);
  const statute = content.statuteText;
  const domainConfig = await st.getDomain(domain);
  const isGeneralDomain = domainConfig?.type === "general";

  // Log domain analysis method
  if (isGeneralDomain) {
    console.log(`🔍 ${entity}: Domain ${domain} is general; using vector search only`);
  } else if (content.includeFullStatuteText) {
    const wordCount = statute.trim().split(/\s+/).length;
    console.log(
      `🔍 ${entity}: Statute is short (${wordCount} words < ${MAX_WORDS_FOR_DIRECT_ANALYSIS}), using full statute text + EntityDownloads vectors`,
    );
  } else {
    console.log(`🔍 ${entity}: Using vector retrieval for statutes and EntityDownloads`);
  }

  // Determine which questions need analysis
  let existingAnalysis = await st.getAnalysis(domain, entity);

  if (force && !questionId) {
    console.log(
      `🔄 ${entity}: Force mode - clearing existing analysis and reanalyzing all questions`,
    );
    log(
      `Force mode enabled - ignoring existing analysis.json for vector analysis`,
    );
    existingAnalysis = null;
  } else if (force && questionId) {
    console.log(
      `🎯 ${entity}: Force mode with specific question - targeting question ${questionId} only`,
    );
    log(
      `Force mode enabled for specific question ${questionId} - preserving other questions`,
    );
  }

  const { questionsToAnalyze, questionsToKeep, questionsToRemove } =
    compareQuestions(
      questions,
      force && !questionId ? [] : existingAnalysis?.questions || [],
      entity,
      questionId,
    );

  // Prepare analysis parameters
  const statuteSize = statute.length;
  const useConversationMode = USE_CONVERSATION;
  const statuteTokens = statute ? estimateTokens(statute) : 0;
  const startTokenUsage = getCurrentTokenUsage();

  // Run appropriate analysis mode
  let newAnswers: any[] = [];
  let totalVectorTokens = 0;

  const domainObj = await st.getDomain(domain);
  const entityObj = await st.getEntity(entity);
  if (!domainObj) {
    throw new Error(`Domain object not found for ${domain}`);
  }
  if (!entityObj) {
    throw new Error(`Entity object not found for ${entity}`);
  }
  const domainForEntityText = domainObj.displayName || domain + " applying to " + entityObj.displayName;


  if (useConversationMode) {
    const result = await runConversationAnalysis(
      domain,
      entity,
      domainForEntityText,
      questionsToAnalyze,
      content.includeFullStatuteText ? statute : undefined,
      statuteSize,
      isGeneralDomain,
      vectorService,
      content.authoritativeDocumentType,
      questionsToKeep,
      options,
    );
    newAnswers = result.newAnswers;
    totalVectorTokens = result.totalVectorTokens;
  } else {
    const result = await runVectorAnalysis(
      domain,
      entity,
      domainForEntityText,
      questionsToAnalyze,
      questionsToKeep,
      statuteSize,
      isGeneralDomain,
      content.authoritativeDocumentType,
      vectorService,
      options,
    );
    newAnswers = result.newAnswers;
    totalVectorTokens = result.totalVectorTokens;
  }

  const endTokenUsage = getCurrentTokenUsage();
  const municipalityTokensUsed = endTokenUsage - startTokenUsage;

  // Log token usage
  const analysisMethod = logTokenUsageSummary(
    entity,
    useConversationMode,
    questionsToAnalyze,
    municipalityTokensUsed,
    statuteTokens,
    totalVectorTokens,
  );

  // Enhance existing questions with gap analysis
  const enhancedQuestionsToKeep = await enhanceQuestionsWithGapAnalysis(
    entity,
    domain,
    questionsToKeep,
    questionId,
    options,
  );

  // Combine and order final answers
  const allAnswers = orderAnswersByQuestions(
    questions,
    enhancedQuestionsToKeep,
    newAnswers,
  );

  // Log analysis summary
  if (questionsToAnalyze.length === 0 && questionsToRemove.length === 0) {
    console.log(
      `✅ ${entity}: No changes needed - all ${questionsToKeep.length} questions are up to date`,
    );
  } else {
    console.log(
      `✅ ${entity}: Analysis updated - ${newAnswers.length} newly analyzed, ${questionsToKeep.length} kept, ${questionsToRemove.length} removed`,
    );
  }

  const grades: { [key: string]: string | null } = {};
  const scores = calculateNormalizedScores(allAnswers, questions);

  return {
    entityId: entity,
    domainId: domain,
    entity: {
      id: entity,
      displayName: `${metadata.municipality} - ${metadata.municipalityType}`,
    },
    domain: {
      id: domain,
      displayName: formatDomainName(domain),
    },
    grades,
    questions: allAnswers,
    scores: scores,
    overallScore: scores.normalizedScore,
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
  entity: string,
  domain: string,
  metadata: any,
  questions: any[],
  statute: string,
  options: AnalyzeOptions = {},
) {
  const st = await getStorage(options);
  const force = options.force || false;
  const questionId = options.questionId;

  // Track total tokens used for this entity analysis
  const startTokenUsage = getCurrentTokenUsage();
  const statuteTokens = estimateTokens(statute);

  // Create backup of existing analysis.json if it exists
  let existingAnalysis: Analysis | null = await st.getAnalysis(domain, entity);

  if (force && !questionId) {
    console.log(
      `🔄 ${entity}: Force mode - clearing existing analysis and reanalyzing all questions`,
    );
    log(
      `Force mode enabled - ignoring existing analysis.json for direct analysis`,
    );
    existingAnalysis = null;
  } else if (force && questionId) {
    console.log(
      `🎯 ${entity}: Force mode with specific question - targeting question ${questionId} only`,
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
      entity,
      questionId,
    );

  // Generate answers for questions that need analysis
  const newAnswers: any[] = [];

  for (const question of questionsToAnalyze) {
    const questionText = question.question || "No question text available";

    console.log(
      `📝 ${entity}: Analyzing question "${questionText.substring(0, 50)}..." (direct analysis)`,
    );

    try {
      const answer = await evaluateQuestion(questionText, statute, domain, entity, question, options);
      newAnswers.push(answer);
    } catch (error) {
      console.error(
        `❌ Error analyzing question ${question.id}:`,
        errMsg(error),
      );
      const answer = createEmptyAnswer(question, error);
      newAnswers.push(answer);
    }
  }

  // Combine all answers
  const allAnswers = [...questionsToKeep, ...newAnswers];

  // Sort answers to match questions.json order
  const orderedAnswers = orderAnswersByQuestions(questions, [], newAnswers);
  if (VERBOSE) {
    log(
      `Ordered ${orderedAnswers.length} answers according to questions.json sequence`,
    );
  }

  const endTokenUsage = getCurrentTokenUsage();
  const municipalityTokensUsed = endTokenUsage - startTokenUsage;

  if (VERBOSE) {
    log(
      `Entity analysis: ${municipalityTokensUsed} tokens for ${questionsToAnalyze.length} questions using direct mode`,
    );
  }

  const scores = calculateNormalizedScores(orderedAnswers, questions);

  const gapAnalysis = existingAnalysis?.gapAnalysis || "";

  console.log(
    `✅ ${entity}: Analysis updated - ${newAnswers.length} newly analyzed, ${questionsToKeep.length} kept, ${questionsToRemove.length} removed`,
  );

  const analysis = {
    entityId: entity,
    domainId: domain,
    entity: { id: entity, displayName: entity },
    domain: domain,
    analyzedAt: new Date().toISOString(),
    questions: orderedAnswers,
    scores: scores,
    overallScore: scores.normalizedScore,
    averageConfidence: scores.averageConfidence,
    questionsAnswered: scores.questionsAnswered,
    totalQuestions: scores.totalQuestions,
    gapAnalysis,
  };

  return analysis;
}


function createEmptyAnswer(question: any, error: unknown) {
  return {
    id: question.id,
    question: question.question,
    answer: "Not specified in the statute.",
    confidence: 0,
    sourceRefs: [],
    score: 0,
    analyzedAt: new Date().toISOString(),
    error: errMsg(error),
  };
}

async function evaluateQuestion(questionText: any, statute: string, domain: string, entity: string, question: any, options: AnalyzeOptions) {
  const [result] = await analyzeQuestions({
    mode: "full",
    domain,
    entity,
    domainForEntityText: `${domain} applying to ${entity}`,
    questions: [{ question: questionText, scoreInstructions: question.scoreInstructions }],
    model: options.model,
    verbose: options.verbose,
    dryRun: options.dryRun,
    fullText: statute,
    additionalSources: { data: [] },
  });

  const questionScore = calculateAnswerScore(
    result.answer,
    result.confidence
  );

  if (VERBOSE) {
    console.log(
      `[VERBOSE] Generated answer: ${result.answer.substring(0, 100)}... (confidence: ${result.confidence}%, ${result.sourceRefs.length} refs)`,
    );
  }

  return {
    id: question.id,
    question: question.question,
    answer: result.answer,
    confidence: result.confidence,
    sourceRefs: result.sourceRefs,
    score: questionScore,
    analyzedAt: new Date().toISOString(),
  };
}

// Generate scores only for existing analysis files
async function generateScoresOnly(options: AnalyzeOptions) {
  const st = await getStorage(options);

  const domainsToProcess = options.domain
    ? await getVisibleDomainIds(st, options.domain)
    : await getVisibleDomainIds(st);

  for (const domainId of domainsToProcess) {
    console.log(`\n📊 Processing domain: ${domainId}`);

    // Load domain questions with weights
    const domainQuestions = await st.getQuestionsByDomain(domainId, options.realm);

    const entityIds = await getRequestedEntityIds(options, st, domainId);

    for (const entityId of entityIds) {
      const analysis = await st.getAnalysis(domainId, entityId, options.realm);
      if (!analysis) {
        log(`⚠️  Analysis file not found for ${entityId}`);
        continue;
      }

      try {
        console.log(`🧮 ${entityId}: Calculating normalized scores...`);

        // Skip if already has normalized scores (unless force)
        if (analysis.scores?.normalizedScore && !options.force) {
          console.log(
            `✔ ${entityId}: Already has normalized scores (use --force to recalculate)`
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
          questions: updatedQuestions,
          scores: scores,
          overallScore: scores.normalizedScore,
          normalizedScore: scores.normalizedScore,
          scoresUpdatedAt: new Date().toISOString(),
        };

        await st.saveAnalysis(updatedAnalysis);

        console.log(
          `✅ ${entityId}: Normalized score: ${scores.normalizedScore.toFixed(2)}/5.0 (${scores.questionsAnswered}/${scores.totalQuestions} questions answered)`
        );
      } catch (error) {
        console.error(`❌ Error processing ${entityId}:`, errMsg(error));
      }
    }
  }

  console.log(`\n🎉 Score generation complete!`);
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

/**
 * Check if we should skip doing an analysis because a recent analysis already exists and the statute hasn't changed. This helps avoid unnecessary OpenAI calls when data is still fresh.
 * @param st 
 * @param domain 
 * @param entity 
 * @param skipRecentTime 
 * @returns true if we should skip it as it's too recent
 */
async function shouldSkipRecentAnalysis(
  st: IStorage,
  domain: string,
  entity: string,
  skipRecentTime: string,
): Promise<boolean> {
  try {
    const stat = await st.getAnalysisStat(domain, entity);
    if (!stat.exists) return false;
    const ageMs = Date.now() - stat.mtime.getTime();
    const skipThresholdMs = parseTimeToMs(skipRecentTime);
    return ageMs < skipThresholdMs;
  } catch (error) {
    console.warn(`Error checking analysis age: ${errMsg(error)}`);
    return false;
  }
}

// Helper function to get human-readable time ago string
async function getTimeAgoString(
  st: IStorage,
  domain: string,
  entity: string,
): Promise<string> {
  try {
    const stat = await st.getAnalysisStat(domain, entity);
    const ageMs = Date.now() - stat.mtime.getTime();
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
  --entity <id>       Process specific entity only (e.g., "NY-Bedford-Town")
  --realm <id>              Target realm (or set CURRENT_REALM env var)
  --force                   Force re-analysis even if recent analysis exists
  --dry-run                 Plan analysis without making OpenAI calls or writing files
  --reindex                 Re-upload document chunks to Pinecone vector database
  --verbose, -v             Enable detailed logging of processing steps
  --fixorder                Fix question order in existing analysis.json files to match questions.json
  --setgrades               Copy grades from metadata.json to analysis.json ${GRADING_ID} grades field
  --usemeta                 Compare analysis against meta-analysis best practices
  --questionId <id>         Analyze only the specified question ID (e.g., "9")
  --generate-meta           Generate meta-analysis after completing analysis
  --generate-questions      Generate questions.json using AI if it doesn't already exist
  --skip-recent <time>      Skip analysis if generated within specified time (e.g., "15m", "2h", "1d")
  --generate-score-only     Calculate and update normalized scores for existing analysis files
  --model <model>           AI model to use: gpt-5.4-mini, gpt-5.4, gpt-5.5
  --help, -h               Show this help message

Examples:
  # Analyze all domains and entities with verbose output
  tsx scripts/analyzeStatutes.ts --verbose

  # Process only property-maintenance domain
  tsx scripts/analyzeStatutes.ts --domain property-maintenance

  # Force re-analysis of Bedford's property maintenance
  tsx scripts/analyzeStatutes.ts --domain property-maintenance --entity NY-Bedford-Town --force

  # Process specific entity with verbose logging
  tsx scripts/analyzeStatutes.ts --entity NY-Ardsley-Village --verbose

  # Fix question order for all analysis files
  tsx scripts/analyzeStatutes.ts --fixorder

  # Generate normalized scores for existing analysis files
  tsx scripts/analyzeStatutes.ts --generate-score-only --domain trees --verbose

  # Fix question order for specific domain
  tsx scripts/analyzeStatutes.ts --domain property-maintenance --fixorder

  # Set ${GRADING_ID} grades from metadata for all domains
  tsx scripts/analyzeStatutes.ts --setgrades

  # Set ${GRADING_ID} grades for specific domain
  tsx scripts/analyzeStatutes.ts --domain property-maintenance --setgrades
  
  # Analyze with meta-analysis comparison to best practices
  tsx scripts/analyzeStatutes.ts --domain trees --entity NY-Bedford-Town --usemeta --force

  # Skip analysis if generated within last 30 minutes
  tsx scripts/analyzeStatutes.ts --domain property-maintenance --skip-recent 30m

  # Skip analysis if generated within last 2 hours
  tsx scripts/analyzeStatutes.ts --skip-recent 2h

  # Generate meta-analysis after completing statute analysis
  tsx scripts/analyzeStatutes.ts --domain trees --generate-meta

  # Analyze only a specific question (useful when question text changes)
  tsx scripts/analyzeStatutes.ts --domain trees --questionId 9

  # Re-analyze a specific question for one entity
  tsx scripts/analyzeStatutes.ts --domain trees --entity NY-NewCastle-Town --questionId 9

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
  // Load environment variables from .env file
  dotenv.config();

  // Delegate common flags (--realm, --domain, --entity, --force, --dry-run, --data-root)
  // to the shared helper; remaining args are script-specific.
  const { common, rest } = parseCommonCliArgs(process.argv.slice(2));

  const options: AnalyzeOptions = {
    realm: common.realm,
    domain: common.domain,
    entity: common.entity,
    force: common.force,
    dryRun: common.dryRun,
  };

  if (common.realm) {
    process.env.CURRENT_REALM = common.realm;
    console.log(`📖 Using realm: ${common.realm}`);
  }

  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
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
      case "--generate-questions":
        options.generateQuestions = true;
        break;
      case "--questionId":
        options.questionId = rest[++i];
        break;
      case "--skip-recent":
        options.skipRecent = rest[++i];
        break;
      case "--generate-score-only":
        options.generateScoreOnly = true;
        break;
      case "--model":
        options.model = rest[++i] as any;
        break;
      default:
        console.error(`Unknown option: ${rest[i]}`);
        showHelp();
        process.exit(1);
    }
  }

  // If no realm is set, prompt user to select from available realms
  if (!options.realm) {
    try {

      const availableRealms = await getRealmsFromStorage();
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
    } catch (error) {
      console.error("❌ Error loading realms configuration:", errMsg(error));
      process.exit(1);
    }
  }


  return options;
}


// // Run the script
// if (require.main === module) {
//   (async () => {
    const options = await parseArgs();
    analyzeStatutes(options).catch(console.error);
//   })();
// }


