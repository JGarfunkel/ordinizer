#!/usr/bin/env tsx

import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";
import {
  loadModelConfig, setCurrentModel, checkRateLimit, recordTokenUsage,
  getCurrentTokenUsage, estimateTokens, sleep, QUESTION_PAUSE_MS, QUESTION_SET_PAUSE_MS,
  getModelRateLimit, extractSectionReferences,
  setVerbose as setOpenaiVerbose,
  answerQuestionDirectly, analyzeQuestionsWithFullStatute, generateGapAnalysis,
  loadMetaAnalysis,
} from "../services/openai.js";
import { calculateAnswerScore, calculateNormalizedScores } from "./scoring.js";
import {
  indexDocumentInPinecone, answerQuestionWithVector,
  setVerbose as setVectorVerbose,
} from "../services/vectorService.js";
import { Analysis, MetaAnalysis, JsonFileStorage, type FileStat } from "@ordinizer/servercore";


// Storage singleton — initialized lazily with the correct data directory.
let _storage: JsonFileStorage | null = null;
async function getStorage(options: AnalyzeOptions): Promise<JsonFileStorage> {
  if (!_storage) {
    _storage = new JsonFileStorage(options.realm || "");
  }
  return _storage;
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
  generateQuestions?: boolean; // New: Generate questions.json using AI if it doesn't exist
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
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Handle reindexing when analysis is skipped but --reindex flag is used
 */
async function handleReindexOnly(
  municipality: string,
  domain: string,
  index: any,
  options: AnalyzeOptions = {},
) {
  console.log(`🔄 ${municipality}: Reindexing documents in vector database...`);
  const st = await getStorage(options);
  const statute = await st.getDocumentText(domain, municipality, options.realm);
  if (statute) {
    await indexDocumentInPinecone(statute, municipality, domain, index, "statute");
    const additionalSources = await st.getAdditionalSources(domain, municipality, options.realm);
    if (additionalSources.guidance) {
      await indexDocumentInPinecone(additionalSources.guidance, municipality, domain, index, "guidance");
    }
    console.log(`✅ ${municipality}: Reindexing complete`);
  }
}

// Add meta-analysis comparison to existing analysis
async function addMetaAnalysisComparison(
  analysis: Analysis,
  metaAnalysis: MetaAnalysis,
  municipalityId: string,
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
  const st = await getStorage(options);
  const domains = options.domain
    ? [options.domain]
    : await st.listDomainIds(options.realm);

  let totalUpdated = 0;
  let totalProcessed = 0;

  for (const domain of domains) {
    console.log(`\n📂 Processing domain: ${domain}`);
    const realm = options.realm ? await st.getRealm(options.realm) : null;
    if (options.realm && !realm) {
      console.log(`⚠️  Realm not found: ${options.realm}`);
      continue;
    }

    const realmType = (realm as any)?.type ?? (realm as any)?.realmType ?? "statute";
    const allEntityIds = await st.listEntityIds(domain, options.realm);
    const entityIds = options.municipality
      ? allEntityIds.filter((id) => id.toLowerCase().includes(options.municipality!.toLowerCase()))
      : allEntityIds;

    for (const entityId of entityIds) {
      totalProcessed++;
      const metadata = await st.getRegulationMetadata(domain, entityId, options.realm) as any;
      if (!metadata) {
        console.log(`⚠️  No metadata.json found for ${entityId}`);
        continue;
      }
      const analysis = await st.getAnalysisRaw(domain, entityId, options.realm);
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
      const previousGrade = analysis.grades.WEN;
      analysis.grades.WEN = grade;

      await st.writeAnalysis(domain, entityId, analysis, options.realm);
      console.log(`✅ Updated ${entityId}: ${previousGrade || "none"} → ${grade}`);
      totalUpdated++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Processed: ${totalProcessed} municipalities`);
  console.log(`   Updated: ${totalUpdated} grades`);
}
// Fix question order in existing analysis.json files
async function fixQuestionOrder(options: AnalyzeOptions) {

  const storage = await getStorage(options);
  const domains = options.domain
    ? [options.domain]
    : await storage.listDomainIds(options.realm);

  let totalFixed = 0;
  let totalProcessed = 0;

  for (const domain of domains) {
    console.log(`\nProcessing domain: ${domain}`);
    const questions = await storage.getQuestionsByDomain(domain, options.realm);

    const municipalities = options.municipality 
      ? [options.municipality] 
      : await storage.getMunicipalIds();

    for (const municipality of municipalities) {
      const analysis = await storage.getAnalysisByEntityAndDomain(municipality, domain);

      if (!analysis) {
        log(`Analysis file not found for ${municipality}, skipping`);
        continue;
      }
      totalProcessed++;

      try {
        const existingQuestions = analysis.questions || [];
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
          analysis.questions = reorderedQuestions;
          analysis.lastUpdated = new Date().toISOString();

          storage.writeAnalysis(domain, municipality, analysis, options.realm);
          console.log(
            `${municipality}: Fixed question order (${reorderedQuestions.length} questions)`,
          );
          totalFixed++;
        } else {
          log(`${municipality}: Question order already correct`);
        }
      } catch (error) {
        console.error(
          `⚠️ ${municipality}: Error fixing order - ${errMsg(error)}`,
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
  VERBOSE = options.verbose || false;
  setVectorVerbose(VERBOSE);
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

  const st = await getStorage(options);

  const domains = options.domain
    ? [options.domain]
    : await st.listDomainIds(options.realm);

  log(`Found ${domains.length} domains to process:`, domains);

  for (const domain of domains) {
    console.log(`\n📁 Processing domain: ${domain}`);

    // Generate questions if they don't exist
    await generateQuestionsIfNeeded(domain, options);

    // Get municipalities to process
    const municipalities = options.municipality
      ? [options.municipality]
      : await st.listEntityIds(domain, options.realm);

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
      await new Promise((resolve) => setTimeout(resolve, 10000));
      log(`Index ${indexName} created and ready`);
    } else {
      log(`Index ${indexName} already exists`);
    }

    const index = pinecone.index(indexName);

    for (let i = 0; i < municipalities.length; i++) {
      const municipality = municipalities[i];
      const madeOpenAICalls = await processEntity(
        domain,
        municipality,
        index,
        options,
      );

      // Add pause between municipalities only if OpenAI calls were made
      if (i < municipalities.length - 1 && madeOpenAICalls) {
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

async function generateQuestionsIfNeeded(domain: string, options: AnalyzeOptions = {}) {
  const st = await getStorage(options);
  const hasQuestions = await st.questionsExist(domain, options.realm);
  log(`Checking for questions for domain: ${domain}`);

  if (hasQuestions) {
    console.log(`✅ Questions already exist for ${domain}`);
    const questionsArray = await st.getQuestionsByDomain(domain, options.realm);
    log(`Loaded ${questionsArray.length} existing questions for ${domain}`);
    return;
  }

  if (!options.generateQuestions) {
    log(`No questions.json found for ${domain} and --generate-questions not set, skipping`);
    return;
  }

  console.log(`🤖 Generating questions for ${domain} using AI...`);

  // Sample up to 3 statute files from the domain directory
  const entityIds = await st.listEntityIds(domain, options.realm);
  const sampleStatutes: string[] = [];
  for (const entityId of entityIds) {
    if (sampleStatutes.length >= 3) break;
    const content = await st.getDocumentText(domain, entityId, options.realm);
    if (content && content.trim()) sampleStatutes.push(content);
  }

  if (sampleStatutes.length === 0) {
    console.warn(`⚠️  No statute files found for ${domain}, cannot generate questions`);
    return;
  }

  const domainDisplayNames: Record<string, string> = {
    Trees: "Trees & Urban Forestry - Tree removal, planting, and maintenance regulations",
    Zoning: "Zoning & Land Use - Land use regulations and zoning ordinances",
    Parking: "Parking Regulations - Parking rules and enforcement",
    Noise: "Noise Control - Noise ordinances and quiet hours",
    Building: "Building Codes - Construction and building regulations",
    Environmental: "Environmental Protection - Environmental protection and conservation",
    Business: "Business Licensing - Business permits and licensing requirements",
  };

  const description = domainDisplayNames[domain] || `${domain} municipal regulations`;

  const prompt = `You are analyzing municipal statutes for the domain "${domain}" (${description}).

Based on the following sample statutes, generate a comprehensive list of plain-language questions that would help residents understand the key differences between municipalities in this domain.

Sample statutes:
${sampleStatutes.map((statute, i) => `--- Sample ${i + 1} ---\n${statute.substring(0, 2000)}`).join("\n\n")}

Generate 5-10 important questions that would reveal meaningful differences between municipalities. Focus on practical aspects that residents care about like:
- Requirements and procedures
- Fees and penalties
- Restrictions and permissions
- Timelines and processes
- Exceptions and exemptions

Return your response as JSON in this format:
{
  "questions": [
    {
      "id": 1,
      "question": "What are the permit requirements for tree removal on private property?",
      "category": "permits"
    }
  ]
}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content || "{}");
  const generatedQuestions = (result.questions || []).map((q: any, index: number) => ({
    id: q.id?.toString() ?? (index + 1).toString(),
    question: q.question || q.text || "",
    category: q.category || "general",
  }));

  const questionsData = { questions: generatedQuestions };
  await st.writeQuestions(domain, questionsData, options.realm);
  console.log(`✅ Generated ${generatedQuestions.length} questions for ${domain}`);
}

async function processEntity(
  domain: string,
  municipality: string,
  index: any,
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
    (await shouldSkipRecentAnalysis(domain, municipality, skipRecent, options))
  ) {
    const timeAgo = await getTimeAgoString(domain, municipality, options);
    console.log(
      `⏭️  ${municipality}: Analysis is recent (${timeAgo}), skipping due to --skip-recent ${skipRecent}`,
    );
    return false; // No OpenAI calls made
  }

  // Check if analysis exists and is recent, and if statute is newer than analysis
  const analysisStat = await st.getAnalysisStat(domain, municipality, options.realm);
  if (!force && analysisStat.exists) {
    const ageInDays =
      (Date.now() - analysisStat.mtime.getTime()) / (1000 * 60 * 60 * 24);

    // Check if analysis has empty questions (incomplete analysis)
    try {
      const existingAnalysis = await st.getAnalysisRaw(domain, municipality, options.realm);
      const hasEmptyQuestions =
        !existingAnalysis?.questions || existingAnalysis.questions.length === 0;

      if (hasEmptyQuestions) {
        console.log(
          `🔄 ${municipality}: Analysis exists but has no questions, re-analyzing`,
        );
        log(
          `Analysis has ${existingAnalysis?.questions?.length || 0} questions`,
        );
        // Continue with analysis - don't return here
      } else {
        // Check if questions.json has changed (need to check this early)
        let questionsChanged = false;
        try {
          const questionsArray = await st.getQuestionsByDomain(domain, options.realm);
          if (questionsArray.length > 0) {
            const { questionsToAnalyze } = compareQuestions(
              questionsArray,
              existingAnalysis?.questions || [],
              municipality,
              questionId, // Pass questionId for skip check
            );
            questionsChanged = questionsToAnalyze.length > 0;
          }
        } catch (error) {
          log(`Error checking questions changes: ${errMsg(error)}`);
          questionsChanged = true; // Force re-analysis if we can't check
        }

        if (questionsChanged) {
          console.log(
            `🔄 ${municipality}: Questions have changed, re-analyzing`,
          );
          // Continue with analysis - don't return here
        } else {
          // Check if document is newer than analysis
          const docStat = await st.getDocumentStat(domain, municipality, options.realm);
          if (docStat.exists) {
            const statuteNewer = docStat.mtime > analysisStat.mtime;

            if (statuteNewer) {
              console.log(
                `🔄 ${municipality}: Statute file is newer than analysis (statute: ${docStat.mtime.toISOString()}, analysis: ${analysisStat.mtime.toISOString()}), re-analyzing`,
              );
              log(`Statute modified: ${docStat.mtime.toISOString()}`);
              log(`Analysis modified: ${analysisStat.mtime.toISOString()}`);
              // Continue with analysis - don't return here
            } else if (!skipRecent && ageInDays < 30) {
              console.log(
                `⏭️  ${municipality}: Analysis is recent (${ageInDays.toFixed(1)} days old) and statute unchanged, skipping`,
              );
              
              // Handle reindexing even when analysis is skipped
              if (options.reindex) {
                await handleReindexOnly(municipality, domain, index, options);
              }
              
              return false; // No OpenAI calls made
            }
          } else if (!skipRecent && ageInDays < 30) {
            console.log(
              `⏭️  ${municipality}: Analysis is recent (${ageInDays.toFixed(1)} days old), skipping`,
            );
            
            // Handle reindexing even when analysis is skipped
            if (options.reindex) {
              await handleReindexOnly(municipality, domain, index, options);
            }
            
            return false; // No OpenAI calls made
          }
        }
      }
    } catch (error) {
      console.log(
        `🔄 ${municipality}: Analysis file is corrupted or unreadable, re-analyzing`,
      );
      log(`Error reading analysis file: ${errMsg(error)}`);
      // Continue with analysis - don't return here
    }
  }

  console.log(`🔍 Processing ${municipality}...`);

  try {
    // Check if required files exist
    const hasMetadata = await st.metadataExists(domain, municipality, options.realm);
    const hasDocument = await st.documentExists(domain, municipality, options.realm);
    if (!hasMetadata || !hasDocument) {
      console.log(
        `⚠️  ${municipality}: Missing metadata or statute file, skipping`,
      );
      log(
        `Metadata exists: ${hasMetadata}, Document exists: ${hasDocument}`,
      );
      return false; // No OpenAI calls made
    }

    const metadata = await st.getRegulationMetadata(domain, municipality, options.realm) as any;
    log(
      `Loaded metadata for ${municipality}:`,
      JSON.stringify(metadata, null, 2),
    );

    const questionsArray = await st.getQuestionsByDomain(domain, options.realm);
    log(`Loaded ${questionsArray.length} questions for domain ${domain}`);

    // Check if this uses state code or local ordinance
    const isStateCode = metadata?.sourceUrl?.includes(
      "up.codes/viewer/new_york/ny-property-maintenance-code-2020",
    );
    log(`Entity ${municipality} uses state code: ${isStateCode}`);

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
          existingAnalysis = await st.getAnalysisRaw(domain, municipality, options.realm);
        } catch (error) {
          log(`Could not load existing analysis: ${errMsg(error)}`);
        }
      }

      const { questionsToAnalyze, questionsToKeep, questionsToRemove } =
        compareQuestions(
          questionsArray,
          force && !questionId ? [] : existingAnalysis?.questions || [],
          municipality,
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
          `✅ ${municipality}: No changes needed - all ${questionsToKeep.length} state code questions are up to date`,
        );
      } else {
        console.log(
          `✅ ${municipality}: State code analysis updated - ${newAnswers.length} newly processed, ${questionsToKeep.length} kept, ${questionsToRemove.length} removed`,
        );
      }

      // Extract WEN grade from metadata for state code analysis
      const grades: { [key: string]: string | null } = {};

      if (metadata.originalCellValue) {
        const gradeMatch = metadata.originalCellValue.match(/^([A-Z][+-]?)\s/);
        if (gradeMatch) {
          grades["WEN"] = gradeMatch[1];
          log(`Extracted WEN grade from originalCellValue: ${grades["WEN"]}`);
        }
      }

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
        municipality,
        domain,
        metadata,
        questionsArray,
        index,
        options,
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

    await st.writeAnalysis(domain, municipality, analysis, options.realm);
    console.log(`✅ ${municipality}: Analysis complete`);
    return true; // OpenAI calls were made
  } catch (error) {
    if (errMsg(error).includes("HTML content")) {
      console.error(`🚫 SKIPPED ${municipality}: ${errMsg(error)}`);
      console.error(
        `   Please run convertHtmlToText.ts on this statute file first.`,
      );
    } else {
      console.error(`❌ Failed to process ${municipality}:`, errMsg(error));
    }
    return false; // No successful OpenAI calls made
  }
}


async function generateVectorAnalysis(
  municipality: string,
  domain: string,
  metadata: any,
  questions: any[],
  index: any,
  options: AnalyzeOptions = {},
) {
  const st = await getStorage(options);
  const force = options.force || false;
  const questionId = options.questionId;

  const statute = await st.getDocumentText(domain, municipality, options.realm);
  if (!statute) {
    throw new Error(`No document text found for ${municipality} in domain ${domain}`);
  }
  
  // Load additional source files (guidance.txt, form.txt)
  const additionalSources = await st.getAdditionalSources(domain, municipality, options.realm);

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
  const binaryContentRegex = /[\x00-\x08\x0E-\x1F\x7F-\x9F\u2000-\u200F\uFEFF]/;
  if (binaryContentRegex.test(statute.substring(0, 1000))) {
    throw new Error(
      `Statute file appears to contain binary data instead of text. File may be corrupted.`,
    );
  }

  // Index documents in vector database if reindex is explicitly requested
  if (options.reindex) {
    await indexDocumentInPinecone(statute, municipality, domain, index, "statute");
    
    if (additionalSources.guidance) {
      await indexDocumentInPinecone(additionalSources.guidance, municipality, domain, index, "guidance");
    }
  }

  // Count words in the statute
  const wordCount = statute.trim().split(/\s+/).length;
  const useDirectAnalysis = wordCount < 1000;

  if (useDirectAnalysis) {
    console.log(
      `📝 ${municipality}: Statute is short (${wordCount} words < 1000), using direct analysis instead of vector search`,
    );
    return await generateDirectAnalysis(
      municipality,
      domain,
      metadata,
      questions,
      statute,
      options,
      additionalSources,
    );
  } else {
    console.log(
      `🔍 ${municipality}: Statute is long (${wordCount} words), using vector analysis`,
    );
  }

  // Create backup of existing analysis.json if it exists
  let existingAnalysis: any = null;
  try {
    const backupResult = await st.writeAnalysisBackup(domain, municipality, options.realm);
    if (backupResult) {
      existingAnalysis = await st.getAnalysisRaw(domain, municipality, options.realm);
      console.log(
        `📋 ${municipality}: Created backup: ${backupResult.backupPath} (analysis from ${backupResult.mtime.toISOString()})`,
      );
    }
  } catch (error) {
    log(`Could not create backup of existing analysis: ${errMsg(error)}`);
  }

  if (force && !questionId) {
    console.log(
      `🔄 ${municipality}: Force mode - clearing existing analysis and reanalyzing all questions`,
    );
    log(
      `Force mode enabled - ignoring existing analysis.json for vector analysis`,
    );
    existingAnalysis = null;
  } else if (force && questionId) {
    console.log(
      `🎯 ${municipality}: Force mode with specific question - targeting question ${questionId} only`,
    );
    log(
      `Force mode enabled for specific question ${questionId} - preserving other questions`,
    );
  }

  // Perform intelligent question comparison
  const { questionsToAnalyze, questionsToKeep, questionsToRemove } =
    compareQuestions(
      questions,
      force && !questionId ? [] : existingAnalysis?.questions || [],
      municipality,
      questionId,
    );

  // Choose analysis method based on statute size
  const statuteSize = statute.length;
  const useConversationMode = statuteSize <= 50000;

  // Track token usage for efficiency analysis
  let totalVectorTokens = 0;
  const statuteTokens = estimateTokens(statute);

  const startTokenUsage = getCurrentTokenUsage();

  const newAnswers: any[] = [];

  if (useConversationMode && questionsToAnalyze.length > 1) {
    console.log(
      `💬 ${municipality}: Using conversation mode for ${questionsToAnalyze.length} questions (statute: ${statuteSize.toLocaleString()} chars)`,
    );

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
      questionsToAnalyze,
      options.model,
      additionalSources,
      metadata,
    );

    const conversationEndTokens = getCurrentTokenUsage();
    const conversationTokensUsed =
      conversationEndTokens - conversationStartTokens;

    if (VERBOSE) {
      log(
        `Conversation mode analysis: ${conversationTokensUsed} tokens for ${questionsToAnalyze.length} questions`,
      );
    }

    for (let i = 0; i < questionsToAnalyze.length; i++) {
      const question = questionsToAnalyze[i];
      const result = conversationResults[i];

      const score = calculateAnswerScore(result.answer, result.confidence);

      const gap = await generateGapAnalysis(
        question.question,
        result.answer,
        result.confidence,
        municipality,
        domain,
        calculateAnswerScore,
        options.model,
      );

      const newAnswer: any = {
        id: question.id,
        question: question.question,
        answer: result.answer,
        confidence: result.confidence,
        sourceRefs: result.sourceRefs || [],
        score: parseFloat(score.toFixed(2)),
      };

      if (gap) {
        newAnswer.gap = gap;
      }

      newAnswers.push(newAnswer);
    }
  } else {
    console.log(
      `🔍 ${municipality}: Using vector mode for ${questionsToAnalyze.length} questions (statute: ${statuteSize.toLocaleString()} chars)`,
    );

    for (const question of questionsToAnalyze) {
      console.log(
        `🔎 ${municipality}: Analyzing question "${question.question.substring(0, 60)}..."`,
      );

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

      if (answer.vectorTokensUsed) {
        totalVectorTokens += answer.vectorTokensUsed;
      }
      const score = calculateAnswerScore(answer.answer, answer.confidence);

      const gap = await generateGapAnalysis(
        question.question,
        answer.answer,
        answer.confidence,
        municipality,
        domain,
        calculateAnswerScore,
        options.model,
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

      if (gap) {
        newAnswer.gap = gap;
      }

      newAnswers.push(newAnswer);
    }
  }

  const endTokenUsage = getCurrentTokenUsage();
  const municipalityTokensUsed = endTokenUsage - startTokenUsage;

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
      `Entity analysis: ${municipalityTokensUsed} tokens for ${questionsToAnalyze.length} questions using ${analysisMethod} mode`,
    );
  }

  if (!useConversationMode && questionsToAnalyze.length > 0) {
    const vectorEfficiency = (
      (totalVectorTokens / statuteTokens) *
      100
    ).toFixed(1);
    const worthIt = totalVectorTokens < statuteTokens * 0.8;

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

  // Add gap analysis to existing questions that don't have it
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

    if (!questionId && !existingQuestion.gap && score < 1.0) {
      console.log(
        `🔎 ${municipality}: Adding missing gap analysis for question ${existingQuestion.id} (score: ${score.toFixed(2)})`,
      );
      const gap = await generateGapAnalysis(
        existingQuestion.question,
        existingQuestion.answer,
        existingQuestion.confidence || 50,
        municipality,
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
        `🔎 ${municipality}: Removing gap from question ${existingQuestion.id} (perfect score: ${score.toFixed(2)})`,
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

  const allAnswers = orderAnswersByQuestions(
    questions,
    enhancedQuestionsToKeep,
    newAnswers,
  );

  if (questionsToAnalyze.length === 0 && questionsToRemove.length === 0) {
    console.log(
      `✅ ${municipality}: No changes needed - all ${questionsToKeep.length} questions are up to date`,
    );
  } else {
    console.log(
      `✅ ${municipality}: Analysis updated - ${newAnswers.length} newly analyzed, ${questionsToKeep.length} kept, ${questionsToRemove.length} removed`,
    );
  }

  const grades: { [key: string]: string | null } = {};

  if (metadata.originalCellValue) {
    const gradeMatch = metadata.originalCellValue.match(/^([A-Z][+-]?)\s/);
    if (gradeMatch) {
      grades["WEN"] = gradeMatch[1];
      log(`Extracted WEN grade from originalCellValue: ${grades["WEN"]}`);
    }
  }

  if (!grades["WEN"] && metadata.grade) {
    grades["WEN"] = metadata.grade;
    log(`Using metadata.grade as WEN grade: ${grades["WEN"]}`);
  }

  const scores = calculateNormalizedScores(allAnswers, questions);

  return {
    municipality: {
      id: municipality,
      displayName: `${metadata.municipality || "Unknown"} - ${metadata.municipalityType || "Entity"}`,
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
  municipality: string,
  domain: string,
  metadata: any,
  questions: any[],
  statute: string,
  options: AnalyzeOptions = {},
  additionalSources: { guidance?: string; form?: string } = {},
) {
  const st = await getStorage(options);
  const force = options.force || false;
  const questionId = options.questionId;

  // Track total tokens used for this municipality analysis
  const startTokenUsage = getCurrentTokenUsage();
  const statuteTokens = estimateTokens(statute);

  // Create backup of existing analysis.json if it exists
  let existingAnalysis: any = null;
  try {
    const backupResult = await st.writeAnalysisBackup(domain, municipality, options.realm);
    if (backupResult) {
      existingAnalysis = await st.getAnalysisRaw(domain, municipality, options.realm);
      console.log(
        `📋 ${municipality}: Created backup: ${backupResult.backupPath} (analysis from ${backupResult.mtime.toISOString()})`,
      );
    }
  } catch (error) {
    log(`Could not create backup of existing analysis: ${errMsg(error)}`);
  }

  if (force && !questionId) {
    console.log(
      `🔄 ${municipality}: Force mode - clearing existing analysis and reanalyzing all questions`,
    );
    log(
      `Force mode enabled - ignoring existing analysis.json for direct analysis`,
    );
    existingAnalysis = null;
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
      `📝 ${municipality}: Analyzing question "${questionText.substring(0, 50)}..." (direct analysis)`,
    );

    try {
      const result = await answerQuestionDirectly(
        questionText,
        statute,
        domain,
        municipality,
        question.scoreInstructions,
        options.model,
      );

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
        errMsg(error),
      );
      const answer = {
        id: question.id,
        question: question.question,
        answer: "Not specified in the statute.",
        confidence: 0,
        sourceRefs: [],
        score: 0,
        analyzedAt: new Date().toISOString(),
        error: errMsg(error),
      };
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

  console.log(`📊 ${municipality}: Token usage summary (direct mode):`);
  console.log(
    `   Total tokens used: ${municipalityTokensUsed.toLocaleString()}`,
  );
  console.log(`   Statute size: ${statuteTokens.toLocaleString()} tokens`);
  console.log(`   Questions analyzed: ${questionsToAnalyze.length}`);

  if (VERBOSE) {
    log(
      `Entity analysis: ${municipalityTokensUsed} tokens for ${questionsToAnalyze.length} questions using direct mode`,
    );
  }

  const scores = calculateNormalizedScores(orderedAnswers, questions);

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
    overallScore: scores.normalizedScore,
    averageConfidence: scores.averageConfidence,
    questionsAnswered: scores.questionsAnswered,
    totalQuestions: scores.totalQuestions,
    gapAnalysis,
    wenGrade: metadata.originalCellValue?.match(/^([A-Z][+-]?)\s/)?.[1] || null,
    usesStateCode: false,
  };

  return analysis;
}


// Generate scores only for existing analysis files
async function generateScoresOnly(options: AnalyzeOptions) {
  const st = await getStorage(options);

  const domainsToProcess = options.domain
    ? [options.domain]
    : await st.listDomainIds(options.realm);

  for (const domainId of domainsToProcess) {
    console.log(`\n📊 Processing domain: ${domainId}`);

    // Load domain questions with weights
    const domainQuestions = await st.getQuestionsByDomain(domainId, options.realm);

    const allEntityIds = await st.listEntityIds(domainId, options.realm);
    const entityIds = options.municipality
      ? allEntityIds.filter((id) => id === options.municipality)
      : allEntityIds;

    for (const municipalityId of entityIds) {
      const analysis = await st.getAnalysisRaw(domainId, municipalityId, options.realm);
      if (!analysis) {
        log(`⚠️  Analysis file not found for ${municipalityId}`);
        continue;
      }

      try {
        console.log(`🧮 ${municipalityId}: Calculating normalized scores...`);

        // Skip if already has normalized scores (unless force)
        if (analysis.scores?.normalizedScore && !options.force) {
          console.log(
            `✔ ${municipalityId}: Already has normalized scores (use --force to recalculate)`
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

        await st.writeAnalysis(domainId, municipalityId, updatedAnalysis, options.realm);

        console.log(
          `✅ ${municipalityId}: Normalized score: ${scores.normalizedScore.toFixed(2)}/5.0 (${scores.questionsAnswered}/${scores.totalQuestions} questions answered)`
        );
      } catch (error) {
        console.error(`❌ Error processing ${municipalityId}:`, errMsg(error));
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

// Check if analysis should be skipped based on --skip-recent parameter
async function shouldSkipRecentAnalysis(
  domain: string,
  municipality: string,
  skipRecentTime: string,
  options: AnalyzeOptions,
): Promise<boolean> {
  try {
    const st = await getStorage(options);
    const stat = await st.getAnalysisStat(domain, municipality, options.realm);
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
  domain: string,
  municipality: string,
  options: AnalyzeOptions,
): Promise<string> {
  try {
    const st = await getStorage(options);
    const stat = await st.getAnalysisStat(domain, municipality, options.realm);
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
  --municipality <id>       Process specific municipality only (e.g., "NY-Bedford-Town")
  --force                   Force re-analysis even if recent analysis exists
  --reindex                 Re-upload document chunks to Pinecone vector database
  --verbose, -v             Enable detailed logging of processing steps
  --fixorder                Fix question order in existing analysis.json files to match questions.json
  --setgrades               Copy grades from metadata.json to analysis.json WEN grades field
  --usemeta                 Compare analysis against meta-analysis best practices
  --questionId <id>         Analyze only the specified question ID (e.g., "9")
  --generate-meta           Generate meta-analysis after completing analysis
  --generate-questions      Generate questions.json using AI if it doesn't already exist
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
      case "--generate-questions":
        options.generateQuestions = true;
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
      const tempStorage = new JsonFileStorage("");
      const availableRealms = await tempStorage.getRealms();

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


// Run the script
(async () => {
  const options = await parseArgs();
  analyzeStatutes(options).catch(console.error);
})();


