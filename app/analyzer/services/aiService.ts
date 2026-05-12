/**
 * AI Service
 * 
 * This module provides a wrapper around the OpenAI API for use in the Ordinizer Analyzer.
 * It includes functions for creating chat completions, estimating token usage, and managing rate limits.
 * It also handles loading model configurations and provides utilities for verbose logging and token usage tracking.
 * 
 * The service is designed to be flexible and easily replaceable if we want to switch to a different AI provider in the future.
 */
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

let openai: OpenAI | null = null;

export { openai };

function getOpenAI(): OpenAI {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required");
    }
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

interface TokenUsage {
  timestamp: number;
  tokens: number;
  estimated?: number; // Track estimated vs actual
}

let tokenUsageHistory: TokenUsage[] = [];
export let currentModel = "gpt-5.4-mini";
export function setCurrentModel(model: string) { currentModel = model; }
let modelConfig: any = null;

// Rate limit statistics tracking
let rateLimitStats = {
  totalWaits: 0,
  totalWaitMs: 0,
  lastWaitTime: 0,
  lastWaitLog: 0, // Throttle wait logs
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
      console.warn("Could not load AI-models.json, using default rate limits", error instanceof Error ? error.message : error);
      modelConfig = {
        models: {
          "gpt-5.5": { tokensPerMinute: 30000 },
          "gpt-5.4": { tokensPerMinute: 30000 },
          "gpt-5.4-mini": { tokensPerMinute: 200000 },
        },
        rateLimitBuffer: 0.8,
      };
    }
  }
  return modelConfig;
}

function validateModelConfig(config: any): void {
  if (!config || !config.models) {
    console.warn("Invalid config: missing models object");
    return;
  }
  
  const buffer = config.rateLimitBuffer ?? 0.8;
  if (buffer < 0.5 || buffer > 1.0) {
    console.warn(`Invalid rateLimitBuffer: ${buffer}. Expected 0.5-1.0. Using 0.8 as fallback.`);
    config.rateLimitBuffer = 0.8;
  }
  
  for (const [modelName, modelData] of Object.entries(config.models)) {
    const md = modelData as any;
    if (!md.tokensPerMinute || md.tokensPerMinute <= 0) {
      console.warn(`Invalid tokensPerMinute for ${modelName}: ${md.tokensPerMinute}. Must be > 0.`);
    }
  }
}

export function getModelRateLimit(): number {
  const baseLimit = modelConfig?.models?.[currentModel]?.tokensPerMinute ?? 30000;
  const buffer = modelConfig?.rateLimitBuffer ?? 0.8;
  return Math.floor(baseLimit * buffer);
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
  // Guard: ignore zero or negative token estimates
  if (estimatedTokens <= 0) {
    return;
  }
  
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  
  // Filter once and reuse
  const recentUsage = tokenUsageHistory.filter(u => u.timestamp > oneMinuteAgo);
  const currentUsage = recentUsage.reduce((sum, u) => sum + u.tokens, 0);
  const rateLimit = getModelRateLimit();
  
  if (currentUsage + estimatedTokens > rateLimit) {
    const oldest = recentUsage[0];
    let waitTime = oldest ? oldest.timestamp + 60000 - now : 60000;
    
    // Cap wait time at 5 minutes to prevent infinite waits
    const MAX_WAIT_MS = 5 * 60 * 1000;
    if (waitTime > MAX_WAIT_MS) {
      console.warn(`⚠️ Rate limit wait time capped at 5 minutes (calculated: ${(waitTime / 1000).toFixed(1)}s). This may indicate config issues.`);
      waitTime = MAX_WAIT_MS;
    }
    
    if (waitTime > 0) {
      const utilizationPercent = Math.round((currentUsage / rateLimit) * 100);
      const now_timestamp = new Date().toLocaleTimeString();
      console.log(`⏳ [${now_timestamp}] Rate limit approaching for ${currentModel}. Usage: ${currentUsage}/${rateLimit} tokens (${utilizationPercent}%), Estimated next: ${estimatedTokens}`);
      console.log(`⏳ Waiting ${(waitTime / 1000).toFixed(1)}s before next API call...`);
      
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
export let VERBOSE: boolean = false;
export function setVerbose(v: boolean) { _verbose = v; VERBOSE = v; }
export function log(message: string, ...args: any[]) {
  if (_verbose) console.log(`[VERBOSE] ${message}`, ...args);
}

/**
 * Get statistics on rate limit behavior
 */
export function getRateLimitStats(): {
  tokensUsed: number;
  tokensLimit: number;
  utilizationPercent: number;
  totalWaits: number;
  totalWaitSeconds: number;
  averageWaitMs: number;
} {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  const recentUsage = tokenUsageHistory.filter(u => u.timestamp > oneMinuteAgo);
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

/**
 * Get statistics on token estimation accuracy
 */
export function getTokenEstimationAccuracy(): {
  estimatedTotal: number;
  actualTotal: number;
  differencePct: number;
  samplesWithEstimates: number;
} {
  const samplesWithEstimates = tokenUsageHistory.filter(u => u.estimated !== undefined).length;
  const estimatedTotal = tokenUsageHistory
    .filter(u => u.estimated !== undefined)
    .reduce((sum, u) => sum + (u.estimated || 0), 0);
  const actualTotal = tokenUsageHistory
    .filter(u => u.estimated !== undefined)
    .reduce((sum, u) => sum + u.tokens, 0);
  
  const differencePct = actualTotal > 0 
    ? Math.round(((estimatedTotal - actualTotal) / actualTotal) * 100)
    : 0;
  
  return {
    estimatedTotal,
    actualTotal,
    differencePct,
    samplesWithEstimates,
  };
}

/**
 * Log rate limit statistics (for debugging and monitoring)
 */
export function logRateLimitStats(): void {
  if (!_verbose) return;
  
  const stats = getRateLimitStats();
  const accuracy = getTokenEstimationAccuracy();
  
  console.log(`[VERBOSE] Rate Limit Stats for ${currentModel}:`);
  console.log(`  Current 60s window: ${stats.tokensUsed}/${stats.tokensLimit} tokens (${stats.utilizationPercent}%)`);
  console.log(`  Total waits: ${stats.totalWaits} (${stats.totalWaitSeconds}s cumulative, avg ${stats.averageWaitMs}ms)`);
  
  if (accuracy.samplesWithEstimates > 0) {
    const diffDirection = accuracy.differencePct > 0 ? 'over' : 'under';
    console.log(`  Estimation accuracy: ${accuracy.samplesWithEstimates} samples, ${Math.abs(accuracy.differencePct)}% ${diffDirection}-estimated`);
  }
}

type ChatResponseFormat = { type: "text" } | { type: "json_object" };

export interface ChatDefaultsOptions {
  format?: "text" | "json";
  system?: string;
  temperature?: number;
  model?: string;
  maxCompletionTokens?: number;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export async function createChatCompletion(
  userPrompt: string,
  options: ChatDefaultsOptions = {}
) {
  const {
    format = "json",
    system,
    temperature = 0.2,
    model = currentModel,
    maxCompletionTokens,
    messages,
  } = options;

  const responseFormat: ChatResponseFormat = format === "json"
    ? { type: "json_object" }
    : { type: "text" };

  const systemPrompt = format === "json"
    ? (system ? `${system} Output strict JSON only.` : "Output strict JSON only.")
    : system || "";

  const resolvedMessages = messages || [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userPrompt },
  ];

  return await getOpenAI().chat.completions.create({
    model,
    messages: resolvedMessages,
    response_format: responseFormat,
    temperature,
    ...(maxCompletionTokens != null
      ? { max_completion_tokens: maxCompletionTokens }
      : {}),
  });
}

export async function fetchChatResponse(model: string, prompt: string, temperature = 0.1, maxTokens = 150) {
  return createChatCompletion(prompt, {
    model,
    temperature,
    maxCompletionTokens: maxTokens,
  });
}
