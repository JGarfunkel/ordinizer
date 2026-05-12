import {
  checkRateLimit,
  createChatCompletion,
  estimateTokens,
  recordTokenUsage,
  sleep,
  QUESTION_PAUSE_MS,
} from "../services/aiService";

import { extractSectionReferences } from "../services/vectorService";

export interface AnalysisPromptContext {
  domain: string;
  entity: string;
  domainForEntityText: string;
  questions: Array<{ question: string }>;
  mode: "full" | "chunks";
  currentQuestion: string;
  scoreInstructions?: string;
  additionalSourceCount?: number;
  isGeneralDomain?: boolean;
}

export interface AnalysisPrompt {
  systemPrompt: string;
  userPromptPrefix: string;
  sourceHeader: string;
}

export function generateAnalysisPrompt(context: AnalysisPromptContext): AnalysisPrompt {
  const scoreText = context.scoreInstructions ? `\n\nSCORING GUIDANCE: ${context.scoreInstructions}` : "";
  const extraSourceText = context.additionalSourceCount && context.additionalSourceCount > 0
    ? "\n- Additional sources are provided. Check them for relevant requirements."
    : "";

  if (context.isGeneralDomain) {
    return {
      systemPrompt: `You are analyzing municipal policy and guidance materials for ${context.domainForEntityText}.
      Based ONLY on the provided excerpts, answer the user's question. If not found, respond with \"Not specified in the provided sources.\" Cite references when available.\n\nFocus on unique information for this specific question.${extraSourceText}${scoreText}`,
      userPromptPrefix: `Question: ${context.currentQuestion}\n\nRelevant discovered excerpts:\n`,
      sourceHeader: `Here are the relevant policy/guidance sources for ${context.domainForEntityText}):`,
    };
  }

  if (context.mode === "chunks") {
    return {
      systemPrompt: `You are analyzing municipal statutes for ${context.domainForEntityText}. Based ONLY on discovered relevant parts of the statute and related sources, answer the user's question. If not found, respond with \"Not specified in the statute.\" Cite section numbers when available.\n\nFocus on unique information for this specific question.${extraSourceText}${scoreText}`,
      userPromptPrefix: `Question: ${context.currentQuestion}\n\nDiscovered relevant parts of the statute and sources:\n`,
      sourceHeader: `Here are discovered relevant parts of the statute and related sources for ${context.domainForEntityText}:`,
    };
  }

  return {
    systemPrompt: `You are analyzing municipal statutes for ${context.domainForEntityText}. Based ONLY on the provided full statute text and related sources, answer the user's question. If information is not present, respond with \"Not specified in the statute.\" Cite section numbers when available.${extraSourceText}${scoreText}`,
    userPromptPrefix: `Question: ${context.currentQuestion}\n\nFull statute and related sources:\n`,
    sourceHeader: `Here is the full statute and related sources for ${context.domainForEntityText}:`,
  };
}

export interface ChunkDiscoveryResult {
  chunks: string[];
  sourceRefs: string[];
  tokenUsage: number;
}

export interface AnalyzeQuestionsInput {
  mode: "full" | "chunks";
  domain: string;
  entity: string;
  domainForEntityText: string;
  questions: Array<{ question: string; scoreInstructions?: string; additionalSource?: string }>;
  model?: string;
  verbose?: boolean;
  dryRun?: boolean;
  isGeneralDomain?: boolean;
  fullText?: string;
  additionalSources?: { data?: string[] };
  getDiscoveredChunks?: (question: string) => Promise<ChunkDiscoveryResult>;
  existingAnswersContextBuilder?: (questionIndex: number) => string;
}

export interface AnalyzedQuestionResult {
  answer: string;
  confidence: number;
  sourceRefs: string[];
  vectorTokensUsed: number;
  researchSuggestions?: string[];
}

function normalizeChunkText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// No longer needed: chunks are now returned as an array from vectorService
// function splitRetrievedChunks(relevantText: string): string[] { ... }

function dedupeRetrievedChunks(
  chunks: string[],
  seenChunks: Set<string>,
): { dedupedChunks: string[]; duplicatesRemoved: number; dedupedOut: boolean } {
  if (chunks.length === 0) {
    return { dedupedChunks: [], duplicatesRemoved: 0, dedupedOut: false };
  }
  const uniqueChunks: string[] = [];
  let duplicatesRemoved = 0;
  for (const chunk of chunks) {
    const fingerprint = normalizeChunkText(
      chunk.replace(/^--- CHUNK \d+ \([^\n]*\) ---\n?/, ""),
    );
    if (!fingerprint) continue;
    if (seenChunks.has(fingerprint)) {
      duplicatesRemoved++;
      continue;
    }
    seenChunks.add(fingerprint);
    uniqueChunks.push(chunk);
  }
  return {
    dedupedChunks: uniqueChunks,
    duplicatesRemoved,
    dedupedOut: uniqueChunks.length === 0,
  };
}

export async function analyzeQuestions(input: AnalyzeQuestionsInput): Promise<AnalyzedQuestionResult[]> {
  const results: AnalyzedQuestionResult[] = [];
  const verbose = input.verbose === true;
  const dryRun = input.dryRun === true;
  const seenChunkFingerprints = new Set<string>();

  const additionalSourceText = (input.additionalSources?.data || [])
    .map((content, idx) => `=== ADDITIONAL SOURCE ${idx + 1} ===\n${content}`)
    .join("\n\n");

    for (let i = 0; i < input.questions.length; i++) {
    const q = input.questions[i];
    const prompt = generateAnalysisPrompt({
      domain: input.domain,
      entity: input.entity,
      domainForEntityText: input.domainForEntityText,
      questions: input.questions,
      mode: input.mode,
      currentQuestion: q.question,
      scoreInstructions: q.scoreInstructions,
      additionalSourceCount: input.additionalSources?.data?.length || 0,
      isGeneralDomain: input.isGeneralDomain,
    });

    let sourceBody = "";
    let retrievalTokens = 0;
    let fallbackSourceRefs: string[] = [];

    const sourceSections: string[] = [];
    if (input.fullText) {
      sourceSections.push(`=== FULL STATUTE TEXT ===\n${input.fullText}`);
    }

    if (input.getDiscoveredChunks) {
      const discovered = await input.getDiscoveredChunks(q.question);
      if (verbose) {
        console.log(
          `[VERBOSE] ${input.entity} Q${i + 1}: vectorService returned ${discovered.chunks.length} chunk(s)`
        );
      }
      if (discovered.chunks && discovered.chunks.length > 0) {
        if (verbose) {
          console.log(
            `[VERBOSE] ${input.entity} Q${i + 1}: chunk preview: ${discovered.chunks.map((c) => c.substring(0, 40) + "...").join(" | ")}`
          );
        }
        const dedupe = dedupeRetrievedChunks(
          discovered.chunks,
          seenChunkFingerprints,
        );
        if (verbose) {
          console.log(
            `[VERBOSE] ${input.entity} Q${i + 1}: after dedup: ${dedupe.duplicatesRemoved} removed, ${dedupe.dedupedChunks.length} remain, dedupedOut=${dedupe.dedupedOut}`,
          );
        }
        if (dedupe.dedupedChunks.length > 0) {
          sourceSections.push(`=== VECTOR-RETRIEVED EXCERPTS ===\n${dedupe.dedupedChunks.join("\n\n")}`);
        }
        if (verbose && dedupe.duplicatesRemoved > 0) {
          console.log(
            `[VERBOSE] ${input.entity} Q${i + 1}: deduped ${dedupe.duplicatesRemoved} previously used chunk(s).`,
          );
        }
        if (verbose && dedupe.dedupedOut) {
          console.log(
            `[VERBOSE] ${input.entity} Q${i + 1}: all retrieved chunks were already used in prior prompts.`,
          );
        }
      } else if (verbose) {
        console.log(`[VERBOSE] ${input.entity} Q${i + 1}: no chunks returned from vectorService`);
      }
      retrievalTokens = discovered.tokenUsage;
      fallbackSourceRefs = discovered.sourceRefs;
    } else if (input.mode === "chunks") {
      throw new Error("getDiscoveredChunks is required in chunks mode");
    }

    if (additionalSourceText) {
      sourceSections.push(additionalSourceText);
    }

    const hasUsableSources = sourceSections.some((section) => section.trim().length > 0);
    if (!hasUsableSources) {
      if (verbose) {
        console.log(
          `[VERBOSE] ${input.entity} Q${i + 1}: no source material available; skipping AI completion call.`,
        );
      }
      results.push({
        answer: input.isGeneralDomain
          ? "Analysis skipped: no matching documents were found for this question."
          : `Analysis skipped: there are no known statutes for ${input.domainForEntityText} and no matching documents were found for this question.`,
        confidence: 0,
        sourceRefs: fallbackSourceRefs,
        vectorTokensUsed: retrievalTokens,
      });
      continue;
    }

    sourceBody = `${prompt.sourceHeader}\n\n${sourceSections.join("\n\n")}`;

    const existingAnswersContext = input.existingAnswersContextBuilder
      ? input.existingAnswersContextBuilder(i)
      : "";

    const userPrompt = `${prompt.userPromptPrefix}${sourceBody}${existingAnswersContext}\n\nPlease respond with JSON:\n{\n  \"answer\": \"...\",\n  \"sourceReference\": \"...\",\n  \"confidence\": 85,\n  \"vectorResearchSuggestions\": [\"optional document topic or title\"]\n}`;

    if (verbose) {
      console.log(`[VERBOSE] ${input.entity} Q${i + 1}/${input.questions.length} (${input.mode}) prompt`);
      console.log("[VERBOSE] System prompt:\n" + prompt.systemPrompt);
      console.log("[VERBOSE] User prompt:\n" + userPrompt);
    }

    if (dryRun) {
      if (verbose) {
        console.log(`[VERBOSE] ${input.entity} Q${i + 1}: dry-run enabled; skipping AI completion call.`);
      }
      results.push({
        answer: input.isGeneralDomain
          ? "[DRY-RUN] Not specified in the provided sources."
          : "[DRY-RUN] Not specified in the statute.",
        confidence: 0,
        sourceRefs: fallbackSourceRefs,
        vectorTokensUsed: retrievalTokens,
      });
      continue;
    }

    const estimated = estimateTokens(prompt.systemPrompt + userPrompt) + 400;
    await checkRateLimit(estimated);

    const response = await createChatCompletion(userPrompt, {
      model: input.model,
      system: prompt.systemPrompt,
      format: "json",
      temperature: 0.1,
      maxCompletionTokens: 1000,
    });

    const completionTokens = response.usage?.total_tokens || estimated;
    recordTokenUsage(completionTokens);
    await sleep(QUESTION_PAUSE_MS);

    let parsed: any = {};
    try {
      parsed = JSON.parse(response.choices[0].message.content || "{}");
    } catch {
      parsed = { answer: response.choices[0].message.content || "Not specified in the statute.", confidence: 0 };
    }

    const answer = parsed.answer || (input.isGeneralDomain ? "Not specified in the provided sources." : "Not specified in the statute.");
    const confidence = Math.max(0, Math.min(100, parsed.confidence || 50));
    const researchSuggestions = Array.isArray(parsed.vectorResearchSuggestions)
      ? parsed.vectorResearchSuggestions
      : (Array.isArray(parsed.researchSuggestions) ? parsed.researchSuggestions : []);
    const sourceRefs = parsed.sourceReference
      ? extractSectionReferences(String(parsed.sourceReference))
      : (fallbackSourceRefs.length > 0 ? fallbackSourceRefs : extractSectionReferences(answer));

    results.push({
      answer,
      confidence,
      sourceRefs,
      vectorTokensUsed: completionTokens + retrievalTokens,
      researchSuggestions,
    });
  }

  return results;
}
