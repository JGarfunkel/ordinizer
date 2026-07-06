import fs from "fs/promises";
import path from "path";
import { generateText, generateObject } from "ai";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

// --- Provider detection ---

// Derive the provider from the model string: claude-* → anthropic, everything else → openai.
function detectProvider(modelId: string): "openai" | "anthropic" {
  return modelId.startsWith("claude-") ? "anthropic" : "openai";
}

export function buildLanguageModel(modelId: string) {
  const provider = detectProvider(modelId);
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
    return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId);
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(modelId);
}

// --- Token usage & rate limiting ---

interface TokenUsage {
  timestamp: number;
  tokens: number;
  estimated?: number;
}

let tokenUsageHistory: TokenUsage[] = [];
export let currentModel = process.env.DEFAULT_AI_MODEL || "claude-opus-4-8";
console.log("Using default model:", currentModel);
export function setCurrentModel(model: string) { currentModel = model; }
let modelConfig: any = null;

let rateLimitStats = {
  totalWaits: 0,
  totalWaitMs: 0,
  lastWaitTime: 0,
};

export const QUESTION_PAUSE_MS = 200;
export const QUESTION_SET_PAUSE_MS = 1000;

async function findAIModelsPath(): Promise<string> {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    for (const candidate of [path.join(dir, "AI-models.json"), path.join(dir, "ordinizer", "AI-models.json")]) {
      try { await fs.access(candidate); return candidate; } catch {}
    }
    dir = path.dirname(dir);
  }
  return path.join(process.cwd(), "AI-models.json");
}

export async function loadModelConfig() {
  if (!modelConfig) {
    try {
      const configPath = await findAIModelsPath();
      modelConfig = JSON.parse(await fs.readFile(configPath, "utf-8"));
      validateModelConfig(modelConfig);
    } catch (error) {
      console.warn("Could not load AI-models.json, using defaults", error instanceof Error ? error.message : error);
      modelConfig = {
        models: {
          "gpt-5.5":      { tokensPerMinute: 30000 },
          "gpt-5.4":      { tokensPerMinute: 30000 },
          "gpt-5.4-mini": { tokensPerMinute: 200000 },
        },
        rateLimitBuffer: 0.8,
      };
    }
  }
  return modelConfig;
}

function validateModelConfig(config: any): void {
  if (!config?.models) { console.warn("Invalid config: missing models"); return; }
  const buffer = config.rateLimitBuffer ?? 0.8;
  if (buffer < 0.5 || buffer > 1.0) {
    console.warn(`Invalid rateLimitBuffer ${buffer}. Using 0.8.`);
    config.rateLimitBuffer = 0.8;
  }
  for (const [name, data] of Object.entries(config.models)) {
    const d = data as any;
    if (!d.tokensPerMinute || d.tokensPerMinute <= 0)
      console.warn(`Invalid tokensPerMinute for ${name}: ${d.tokensPerMinute}`);
  }
}

export function getModelRateLimit(): number {
  const base = modelConfig?.models?.[currentModel]?.tokensPerMinute ?? 30000;
  const buffer = modelConfig?.rateLimitBuffer ?? 0.8;
  return Math.floor(base * buffer);
}

export function estimateTokens(text: string): number {
  const base = Math.ceil(text.length / 3);
  const punct = (text.match(/[§\(\)\[\]\.,:;]/g) || []).length * 0.1;
  const nums = (text.match(/\d+/g) || []).length * 0.2;
  return Math.ceil(base + punct + nums);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function recordTokenUsage(tokens: number, estimated?: number): void {
  tokenUsageHistory.push({ timestamp: Date.now(), tokens, estimated });
}

export function getCurrentTokenUsage(): number {
  return tokenUsageHistory.reduce((total, u) => total + u.tokens, 0);
}

export async function checkRateLimit(estimatedTokens: number): Promise<void> {
  if (estimatedTokens <= 0) return;
  const now = Date.now();
  const recentUsage = tokenUsageHistory.filter(u => u.timestamp > now - 60000);
  const currentUsage = recentUsage.reduce((sum, u) => sum + u.tokens, 0);
  const rateLimit = getModelRateLimit();
  if (currentUsage + estimatedTokens > rateLimit) {
    const oldest = recentUsage[0];
    let waitTime = oldest ? oldest.timestamp + 60000 - now : 60000;
    const MAX_WAIT_MS = 5 * 60 * 1000;
    if (waitTime > MAX_WAIT_MS) {
      console.warn(`⚠️ Rate limit wait capped at 5min (calculated: ${(waitTime / 1000).toFixed(1)}s)`);
      waitTime = MAX_WAIT_MS;
    }
    if (waitTime > 0) {
      const pct = Math.round((currentUsage / rateLimit) * 100);
      console.log(`⏳ [${new Date().toLocaleTimeString()}] Rate limit: ${currentUsage}/${rateLimit} tokens (${pct}%), next: ${estimatedTokens}`);
      console.log(`⏳ Waiting ${(waitTime / 1000).toFixed(1)}s...`);
      rateLimitStats.totalWaits++;
      rateLimitStats.totalWaitMs += waitTime;
      rateLimitStats.lastWaitTime = waitTime;
      await sleep(waitTime);
      const newNow = Date.now();
      tokenUsageHistory = tokenUsageHistory.filter(u => u.timestamp > newNow - 60000);
    }
  }
}

let _verbose = false;
export let VERBOSE = false;
export function setVerbose(v: boolean) { _verbose = v; VERBOSE = v; }
export function log(message: string, ...args: any[]) {
  if (_verbose) console.log(`[VERBOSE] ${message}`, ...args);
}

export function getRateLimitStats(): {
  tokensUsed: number;
  tokensLimit: number;
  utilizationPercent: number;
  totalWaits: number;
  totalWaitSeconds: number;
  averageWaitMs: number;
} {
  const now = Date.now();
  const recentUsage = tokenUsageHistory.filter(u => u.timestamp > now - 60000);
  const tokensUsed = recentUsage.reduce((sum, u) => sum + u.tokens, 0);
  const tokensLimit = getModelRateLimit();
  return {
    tokensUsed,
    tokensLimit,
    utilizationPercent: Math.round((tokensUsed / tokensLimit) * 100),
    totalWaits: rateLimitStats.totalWaits,
    totalWaitSeconds: Math.round(rateLimitStats.totalWaitMs / 1000),
    averageWaitMs: rateLimitStats.totalWaits > 0 ? Math.round(rateLimitStats.totalWaitMs / rateLimitStats.totalWaits) : 0,
  };
}

export function getTokenEstimationAccuracy(): {
  estimatedTotal: number;
  actualTotal: number;
  differencePct: number;
  samplesWithEstimates: number;
} {
  const samples = tokenUsageHistory.filter(u => u.estimated !== undefined);
  const estimatedTotal = samples.reduce((sum, u) => sum + (u.estimated || 0), 0);
  const actualTotal = samples.reduce((sum, u) => sum + u.tokens, 0);
  return {
    estimatedTotal,
    actualTotal,
    differencePct: actualTotal > 0 ? Math.round(((estimatedTotal - actualTotal) / actualTotal) * 100) : 0,
    samplesWithEstimates: samples.length,
  };
}

export function logRateLimitStats(): void {
  if (!_verbose) return;
  const stats = getRateLimitStats();
  const accuracy = getTokenEstimationAccuracy();
  console.log(`[VERBOSE] Rate Limit Stats for ${currentModel} (${detectProvider(currentModel)}):`);
  console.log(`  60s window: ${stats.tokensUsed}/${stats.tokensLimit} (${stats.utilizationPercent}%)`);
  console.log(`  Waits: ${stats.totalWaits} (${stats.totalWaitSeconds}s total, avg ${stats.averageWaitMs}ms)`);
  if (accuracy.samplesWithEstimates > 0) {
    const dir = accuracy.differencePct > 0 ? "over" : "under";
    console.log(`  Estimation: ${accuracy.samplesWithEstimates} samples, ${Math.abs(accuracy.differencePct)}% ${dir}-estimated`);
  }
}

// --- Chat completions ---

export interface ChatResult {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ChatOptions {
  format?: "text" | "json";
  system?: string;
  temperature?: number;
  model?: string;
  maxCompletionTokens?: number;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export async function createChatCompletion(
  userPrompt: string,
  options: ChatOptions = {}
): Promise<ChatResult> {
  const {
    format = "json",
    system,
    model = currentModel,
    maxCompletionTokens,
    messages,
  } = options;
  const temperature = options.temperature ?? (model === "gpt-5.5" ? 1 : 0.3);

  const systemPrompt = format === "json"
    ? (system ? `${system} Output strict JSON only.` : "Output strict JSON only.")
    : (system ?? "");

  const resolvedMessages = messages || [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userPrompt },
  ];

  try {
    const result = await generateText({
      model: buildLanguageModel(model),
      messages: resolvedMessages,
      temperature,
      maxOutputTokens: maxCompletionTokens,
    });
    if (VERBOSE) {
      console.log(`[VERBOSE] Raw response:`, result.text);
    }
    // Strip markdown fences that some models wrap JSON in
    const text = format === "json"
      ? result.text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim()
      : result.text;
    const promptTokens = result.usage.inputTokens ?? 0;
    const completionTokens = result.usage.outputTokens ?? 0;
    return {
      text,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`AI completion failed (model: ${model}): ${message}`);
  }
}

export async function fetchChatResponseInJSON(
  prompt: string,
  model?: string,
  temperature = 0.3,
  maxTokens = 500
): Promise<ChatResult> {
  return createChatCompletion(prompt, { model, temperature, maxCompletionTokens: maxTokens });
}

export interface ObjectResult<T> {
  object: T;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export async function createResponseObjectWithAi<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T>,
  options: { model?: string; temperature?: number; maxCompletionTokens?: number } = {}
): Promise<ObjectResult<T>> {
  const model = options.model ?? currentModel;
  const temperature = options.temperature ?? 0.1;
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const result = await generateObject({
      model: buildLanguageModel(model),
      schema,
      messages: [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userPrompt },
      ],
      temperature,
      maxOutputTokens: options.maxCompletionTokens,
    });
    const promptTokens = result.usage.inputTokens ?? 0;
    const completionTokens = result.usage.outputTokens ?? 0;
    return { object: result.object, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`AI object generation failed (model: ${model}): ${message}`);
  }
}
