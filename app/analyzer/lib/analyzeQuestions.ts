import { z } from "zod";
import {
  checkRateLimit,
  createResponseObjectWithAi,
  estimateTokens,
  recordTokenUsage,
  sleep,
  QUESTION_PAUSE_MS,
} from "../services/aiService";

import { extractSectionReferences } from "../services/vectorService";
import { BestPractice } from "@civillyengaged/ordinizer-core";

const responseSchema = z.object({
  answer: z.string(),
  shortAnswer: z.string(),
  sourceRefs: z.array(z.string()),
  confidence: z.number().int().min(0).max(100),
  gap: z.string().optional(),
  score: z.number().min(0).max(1).optional(),
  nextPrompts: z.array(z.string()).optional(),
});

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

export const NO_SOURCES_AVAILABLE = "No relevant sources available";
export const NOT_SPECIFIED = "Not specified in the provided sources.";

export function generateAnalysisPrompt(context: AnalysisPromptContext, doScoring?: boolean): AnalysisPrompt {
  const scoreText = doScoring && context.scoreInstructions
    ? `\n\nSCORING GUIDANCE: ${context.scoreInstructions}\nReturn a normalized score 0.0–1.0 in the "score" field reflecting how well the statute addresses this question.`
    : "";
  const extraSourceText = context.additionalSourceCount && context.additionalSourceCount > 0
    ? "\n- Additional sources are provided. Check them for relevant requirements."
    : "";

  const promptGuidance = `
  Answer using as few words as the answer requires — a one-sentence fact needs one sentence, not a paragraph.
  If a question is conditional and the condition does not apply, state the relevant fact directly and stop (e.g., "It's free" rather than addressing free-tier sub-questions).
  Report only what IS present in the sources. Do not make value judgments.

  Also provide a "shortAnswer" of 10 words or less — the briefest possible answer for a datasheet cell (e.g., "Yes", "No", "Presumed No", "$20/user/month", "open source group decision software"). If not found, use "Not specified".

  If not found, respond with \"${NOT_SPECIFIED}\"
  Cite references when available.
  Focus on unique information for this specific question.${extraSourceText}${scoreText}`;

  if (context.isGeneralDomain) {
    return {
      systemPrompt: `You are analyzing municipal policy and guidance materials for ${context.domainForEntityText}. ${promptGuidance}`,
      userPromptPrefix: `Question: ${context.currentQuestion}\n\nRelevant discovered excerpts:\n`,
      sourceHeader: `Here are the relevant policy/guidance sources for ${context.domainForEntityText}):`,
    };
  }

  if (context.mode === "chunks") {
    return {
      systemPrompt: `You are analyzing municipal statutes for ${context.domainForEntityText}.  ${promptGuidance}`,
      userPromptPrefix: `Question: ${context.currentQuestion}\n\nDiscovered relevant parts of the statute and sources:\n`,
      sourceHeader: `Here are discovered relevant parts of the statute and related sources for ${context.domainForEntityText}:`,
    };
  }

  return {
    systemPrompt: `You are analyzing municipal statutes for ${context.domainForEntityText}. ${promptGuidance}`,
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
  questions: Array<{ id?: number; question: string; scoreInstructions?: string; additionalSource?: string; dependsOn?: number[] }>;
  model?: string;
  verbose?: boolean;
  dryRun?: boolean;
  isGeneralDomain?: boolean;
  fullText?: string;
  additionalSources?: { data?: string[] };
  getDiscoveredChunks?: (question: string) => Promise<ChunkDiscoveryResult>;
  existingAnswersContextBuilder?: (questionIndex: number) => string;
  /** Answers from questions that were kept from a prior analysis run (not re-analyzed), keyed by question id */
  priorAnswersByQuestionId?: Record<number, string>;
  /** When provided, each question with a matching id will have its gap/score/nextPrompts computed in the same call */
  bestPracticesByQuestionId?: Record<number, BestPractice>;
}

export interface AnalyzedQuestionResult {
  answer: string;
  shortAnswer?: string;
  confidence: number;
  sourceRefs: string[];
  vectorTokensUsed: number;
  /** Set when bestPracticesByQuestionId provided a match for this question */
  gap?: string;
  score?: number;
  nextPrompts?: string[];
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
  const answeredById = new Map<number, string>(
    Object.entries(input.priorAnswersByQuestionId || {}).map(([k, v]) => [Number(k), v])
  );

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
    }, !!q.scoreInstructions);

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
      // For statutory domains, no chunks means the statute doesn't address this topic.
      // For general domains, no sources means there are genuinely no shared sources.
      const noSourceAnswer = input.isGeneralDomain ? NO_SOURCES_AVAILABLE : NOT_SPECIFIED;
      if (q.id !== undefined) answeredById.set(q.id, noSourceAnswer);
      results.push({
        answer: noSourceAnswer,
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

    const dependencyContext = (() => {
      if (!q.dependsOn?.length) return "";
      const lines = q.dependsOn
        .map((id) => {
          const ans = answeredById.get(id);
          if (!ans) return null;
          const depQ = input.questions.find((dq) => dq.id === id);
          return `- Q${id}${depQ ? ` ("${depQ.question}")` : ""}: ${ans}`;
        })
        .filter(Boolean);
      if (!lines.length) return "";
      return `\n\nCONTEXT FROM RELATED QUESTIONS:\n${lines.join("\n")}\n\nIf these answers make this question moot or already resolved, respond in one sentence and stop.`;
    })();

    const bestPractice = (q.id !== undefined && input.bestPracticesByQuestionId)
      ? input.bestPracticesByQuestionId[q.id]
      : undefined;

    const enrichmentSection = bestPractice
      ? `\n\nBEST PRACTICE FOR THIS QUESTION: "${bestPractice.bestAnswer}"\nAfter answering, compare this entity's answer to the best practice and provide: a gap statement (or "No gap" if fully aligned), a normalized score 0.0–1.0, and up to 2 next research prompts if further investigation is needed.`
      : "";

    const userPrompt = `${prompt.userPromptPrefix}${sourceBody}${existingAnswersContext}${dependencyContext}${enrichmentSection}`;
    if (verbose) {
      console.log(`[VERBOSE] ${input.entity} Q${i + 1}/${input.questions.length} (${input.mode}) prompt`);
      console.log("[VERBOSE] System prompt:\n" + prompt.systemPrompt);
      console.log("[VERBOSE] User prompt:\n" + userPrompt);
    }

    if (dryRun) {
      if (verbose) {
        console.log(`[VERBOSE] ${input.entity} Q${i + 1}: dry-run enabled; skipping AI completion call.`);
      }
      if (q.id !== undefined) answeredById.set(q.id, NO_SOURCES_AVAILABLE);
      results.push({
        answer: NO_SOURCES_AVAILABLE,
        confidence: 0,
        sourceRefs: fallbackSourceRefs,
        vectorTokensUsed: retrievalTokens,
      });
      continue;
    }

    const maxCompletionTokens = bestPractice ? 1500 : 1000;
    const estimated = estimateTokens(prompt.systemPrompt + userPrompt) + maxCompletionTokens;
    await checkRateLimit(estimated);

    const aiResult = await createResponseObjectWithAi(
      prompt.systemPrompt,
      userPrompt,
      responseSchema,
      { model: input.model, temperature: 0.1, maxCompletionTokens },
    );

    const completionTokens = aiResult.usage.totalTokens;
    recordTokenUsage(completionTokens);
    await sleep(QUESTION_PAUSE_MS);

    const parsed = aiResult.object;
    if (verbose) {
      console.log(`[VERBOSE] ${input.entity} Q${i + 1}: AI response parsed successfully:`, parsed);
    }
    const answer = parsed.answer || NOT_SPECIFIED;
    if (q.id !== undefined) answeredById.set(q.id, answer);
    const confidence = Math.max(0, Math.min(100, parsed.confidence || 50));
    const sourceRefs = parsed.sourceRefs?.length ? parsed.sourceRefs : fallbackSourceRefs;

    const result: AnalyzedQuestionResult = {
      answer,
      shortAnswer: parsed.shortAnswer || undefined,
      confidence,
      sourceRefs,
      vectorTokensUsed: completionTokens + retrievalTokens,
    };

    // Capture score whenever the AI returned one (happens when scoreInstructions or bestPractice prompted it)
    if (typeof parsed.score === "number") {
      result.score = parsed.score;
    }

    if (bestPractice) {
      if (!input.isGeneralDomain) result.gap = parsed.gap ?? "";
      if (typeof parsed.score !== "number") result.score = 0; // default to 0 when bestPractice expected a score but AI omitted it
      result.nextPrompts = Array.isArray(parsed.nextPrompts) ? parsed.nextPrompts : [];
    }

    // No statute or sources found → score must be 0, regardless of AI output
    if (answer === NOT_SPECIFIED || answer === NO_SOURCES_AVAILABLE) {
      result.score = 0;
    }

    results.push(result);
  }

  return results;
}
