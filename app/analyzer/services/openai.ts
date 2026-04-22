import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ 
	apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR || "default_key" 
});
export { openai };

// ─── Token Rate Limiter ────────────────────────────────────────────────────────

interface TokenUsage {
  timestamp: number;
  tokens: number;
}

let tokenUsageHistory: TokenUsage[] = [];
export let currentModel = "gpt-4o-mini";
export function setCurrentModel(model: string) { currentModel = model; }
let modelConfig: any = null;
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
    } catch {
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

export function getModelRateLimit(): number {
  return modelConfig?.models?.[currentModel]?.tokensPerMinute ?? 30000;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function recordTokenUsage(tokens: number): void {
  tokenUsageHistory.push({ timestamp: Date.now(), tokens });
}

export function getCurrentTokenUsage(): number {
  return tokenUsageHistory.reduce((total, u) => total + u.tokens, 0);
}

export async function checkRateLimit(estimatedTokens: number): Promise<void> {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  tokenUsageHistory = tokenUsageHistory.filter(u => u.timestamp > oneMinuteAgo);
  const currentUsage = tokenUsageHistory.reduce((sum, u) => sum + u.tokens, 0);
  const rateLimit = getModelRateLimit();
  if (currentUsage + estimatedTokens > rateLimit) {
    const oldest = tokenUsageHistory[0];
    const waitTime = oldest ? oldest.timestamp + 60000 - now : 60000;
    if (waitTime > 0) {
      console.log(`⏳ Rate limit approached for ${currentModel}. Used: ${currentUsage}, Estimated: ${estimatedTokens}, Limit: ${rateLimit}`);
      console.log(`⏳ Waiting ${(waitTime / 1000).toFixed(1)}s before next API call...`);
      await sleep(waitTime);
      const newNow = Date.now();
      tokenUsageHistory = tokenUsageHistory.filter(u => u.timestamp > newNow - 60000);
    }
  }
}

/** Extract statute section references like "§ 112-4A" from text */
export function extractSectionReferences(text: string): string[] {
  const sectionRegex = /(?:§|Section)\s*(\d+(?:[.-]\d+)*[A-Z]*)/gi;
  const matches = [...text.matchAll(sectionRegex)];
  return [...new Set(matches.map(m => m[0]).slice(0, 3))];
}

// ─── End Token Rate Limiter ────────────────────────────────────────────────────

// export interface StatuteQuestion {
// 	id: number;
// 	text: string;
// 	category: string;
// }

// export interface StatuteAnalysis {
// 	questionId: number;
// 	answer: string;
// 	sourceReference: string;
// 	confidence: number;
// }

// export async function analyzeStatuteForQuestion(
// 	statute: string,
// 	question: string,
// 	municipalityName: string,
// 	domainName: string
// ): Promise<StatuteAnalysis> {
// 	try {
// 		const prompt = `You are analyzing a municipal statute to answer a specific question in plain language.

// Entity: ${municipalityName}
// Domain: ${domainName}
// Question: ${question}

// Statute text:
// ${statute}

// Please analyze this statute and provide a clear, plain-language answer to the question. If the statute doesn't directly address the question, indicate that in your response.

// Your answer should:
// - Be written in plain English that residents can understand
// - Include specific details like fees, timeframes, requirements
// - Reference the relevant statute section if identifiable
// - Be honest about limitations or unclear areas

// Return your response as JSON in this format:
// {
// 	"answer": "A clear, detailed answer to the question in plain language",
// 	"sourceReference": "Specific statute section or code reference if identifiable", 
// 	"confidence": 0.85
// }`;

// 		const response = await openai.chat.completions.create({
// 			model: "gpt-4o",
// 			messages: [{ role: "user", content: prompt }],
// 			response_format: { type: "json_object" },
// 		});

// 		const result = JSON.parse(response.choices[0].message.content || "{}");
    
// 		return {
// 			questionId: 0, // Will be set by caller
// 			answer: result.answer || "Unable to analyze statute for this question",
// 			sourceReference: result.sourceReference || "",
// 			confidence: result.confidence || 0
// 		};
// 	} catch (error) {
// 		console.error("Failed to analyze statute:", error);
// 		throw new Error(`Failed to analyze statute: ${error}`);
// 	}
//}

// ─── Verbose logging (shared across services) ─────────────────────────────────

let _verbose = false;
export let VERBOSE: boolean = false;
export function setVerbose(v: boolean) { _verbose = v; VERBOSE = v; }
export function log(message: string, ...args: any[]) {
  if (_verbose) console.log(`[VERBOSE] ${message}`, ...args);
}

// ─── Source reference types ────────────────────────────────────────────────────

export interface SourceRef {
  type: 'statute' | 'guidance' | 'form';
  name: string;
  url?: string;
  sections?: string[];
}

export function generateEnhancedSourceRefs(
  answer: string,
  metadata: any,
  referencedDocuments: Set<string> = new Set(),
): SourceRef[] {
  const sourceRefs: SourceRef[] = [];
  const sections = extractSectionReferences(answer);

  if (sections.length > 0 || referencedDocuments.has('statute')) {
    const statuteSource = metadata.sources?.find((s: any) => s.type === 'statute');
    const statuteName = sections.length > 0
      ? sections.join(', ')
      : metadata.statuteNumber || 'Municipal Code';
    sourceRefs.push({
      type: 'statute',
      name: statuteName,
      url: statuteSource?.sourceUrl,
      sections: sections.length > 0 ? sections : undefined,
    });
  }

  if (referencedDocuments.has('guidance')) {
    const src = metadata.sources?.find((s: any) => s.type === 'guidance');
    if (src) sourceRefs.push({ type: 'guidance', name: src.title || 'Guidance Document', url: src.sourceUrl });
  }

  if (referencedDocuments.has('form')) {
    const src = metadata.sources?.find((s: any) => s.type === 'form');
    if (src) sourceRefs.push({ type: 'form', name: src.title || 'Application Form', url: src.sourceUrl });
  }

  return sourceRefs;
}

export function detectReferencedDocuments(answer: string, aiResponse?: string): Set<string> {
  const referenced = new Set<string>();
  const text = `${answer} ${aiResponse || ''}`.toLowerCase();

  if (text.includes('statute') || text.includes('code') || text.includes('§') || /section\s+\d+/i.test(text))
    referenced.add('statute');
  if (text.includes('guidance') || text.includes('guide') || text.includes('explanation') || text.includes('clarification'))
    referenced.add('guidance');
  if (text.includes('form') || text.includes('application') || text.includes('fee') || text.includes('$'))
    referenced.add('form');

  return referenced;
}

export function getQuestionTypeGuidance(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("permit")) return "For permit questions: Focus on application procedures, review criteria, appeal processes, timelines, and approval standards.";
  if (q.includes("penalt") || q.includes("fine")) return "For penalty questions: Focus on fine amounts, escalation for repeat offenses, enforcement mechanisms, and violation categories.";
  if (q.includes("fee")) return "For fee questions: Focus on fee schedules, payment options, exemptions, and administrative cost coverage.";
  if (q.includes("replant") || q.includes("replacement")) return "For replacement questions: Focus on species requirements, survival monitoring, replacement ratios, and native plant preferences.";
  if (q.includes("notif") || q.includes("neighbor")) return "For notification questions: Focus on neighbor distance requirements, timing, notification methods, and affected party identification.";
  if (q.includes("canopy")) return "For canopy questions: Focus on coverage targets, measurement methods, maintenance plans, and long-term preservation strategies.";
  if (q.includes("maintain") || q.includes("responsibilit")) return "For maintenance questions: Focus on property owner duties, inspection schedules, care standards, and hazard management responsibilities.";
  if (q.includes("data") || q.includes("report")) return "For reporting questions: Focus on data collection requirements, public reporting, transparency measures, and tracking mechanisms.";
  return "Focus on what specific regulatory framework, standards, or requirements the municipality should establish for this topic.";
}

// ─── Meta-analysis loader ──────────────────────────────────────────────────────

export async function loadMetaAnalysis(domainId: string, dataDir = "data"): Promise<any> {
  const metaPath = path.join(dataDir, domainId, "meta-analysis.json");
  try {
    try { await fs.access(metaPath); } catch { return null; }
    return JSON.parse(await fs.readFile(metaPath, "utf-8"));
  } catch (error) {
    log(`Could not load meta-analysis for ${domainId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ─── AI analysis functions ─────────────────────────────────────────────────────

/** Answer a question directly from full statute text (for short statutes < 1000 words) */
export async function answerQuestionDirectly(
  question: string,
  statute: string,
  domain: string,
  municipalityId: string,
  scoreInstructions?: string,
  model = "gpt-4o",
) {
  log(`Direct Q&A ${municipalityId}-${domain}: "${question.substring(0, 100)}..."`);
  try {
    const scoreText = scoreInstructions ? `\n\nSCORING GUIDANCE: ${scoreInstructions}` : "";
    const systemPrompt = `You are analyzing municipal statutes. Based ONLY on the provided statute text, answer the user's question. If the information is not in the statute, respond with "Not specified in the statute." Be precise and cite section numbers when available.\nIMPORTANT: Focus on providing unique information for this specific question.${scoreText}`;
    const userPrompt = `STATUTE TEXT:\n${statute}\n\nQUESTION: ${question}\n\nProvide a clear, concise answer based solely on the statute text above. If not explicitly stated, respond with "Not specified in the statute."`;

    const estimatedTokens = estimateTokens(systemPrompt + userPrompt) + 500;
    await checkRateLimit(estimatedTokens);

    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature: 0.1,
    });

    const actualTokens = response.usage?.total_tokens || estimatedTokens;
    recordTokenUsage(actualTokens);

    const answer = response.choices[0]?.message?.content || "Not specified in the statute.";
    let confidence = 0;
    if (answer !== "Not specified in the statute.") {
      confidence = answer.includes("§") || answer.includes("Section") ? 90 : 80;
    }

    return { answer, confidence, sourceRefs: extractSectionReferences(answer), vectorTokensUsed: actualTokens };
  } catch (error) {
    console.error("Error in direct statute analysis:", error);
    return { answer: "Not specified in the statute.", confidence: 0, sourceRefs: [], vectorTokensUsed: 0 };
  }
}

/** Analyze multiple questions in a multi-turn conversation with the full statute */
export async function analyzeQuestionsWithFullStatute(
  questions: string[],
  statuteText: string,
  municipalityName: string,
  domainName: string,
  questionsWithInstructions: any[] = [],
  model = "gpt-4o",
  additionalSources: { guidance?: string; form?: string } = {},
  metadata?: any,
): Promise<Array<{ answer: string; confidence: number; sourceRefs: string[] | SourceRef[] }>> {
  log(`🔄 Conversation analysis for ${municipalityName} ${domainName} (${questions.length} questions)`);
  try {
    const scoringLines = questionsWithInstructions
      .map((q, i) => q.scoreInstructions ? `\nQuestion ${i + 1} specific scoring: ${q.scoreInstructions}` : "")
      .filter(Boolean).join("");

    const messages: any[] = [
      {
        role: "system",
        content: `You are analyzing municipal statutes. You will answer a series of questions about the statute in conversation format.\n\nCRITICAL INSTRUCTIONS:\n- Answer based ONLY on what is explicitly stated in the statute text provided\n- If information is not found in the statute, respond with EXACTLY "Not specified in the statute." and use low confidence (0-20)\n- Do not infer, assume, or elaborate beyond what is written\n- ALWAYS include specific statute section references (like § 112-4A, § 112-5B) in your answers when citing information\n- Use plain language residents can understand\n- Include specific details like fees, timeframes, requirements ONLY if they are explicitly stated\n\nSCORING GUIDANCE:\n- "Not specified in the statute" answers should have very low confidence (0-20) and low scores (0.1-0.2)\n- Higher scores reflect more restrictive/qualified environmental protection requirements${scoringLines}`,
      },
      {
        role: "user",
        content: `Here is the complete statute for ${municipalityName} ${domainName}:\n\n${statuteText}${additionalSources.guidance ? `\n\n=== ADDITIONAL GUIDANCE DOCUMENT ===\n${additionalSources.guidance}` : ""}${additionalSources.form ? `\n\n=== OFFICIAL FORM DOCUMENT ===\n${additionalSources.form}` : ""}\n\nI will now ask you ${questions.length} questions about this statute${additionalSources.guidance || additionalSources.form ? " and the additional documents provided" : ""}. Please analyze it carefully.`,
      },
    ];

    const results: Array<{ answer: string; confidence: number; sourceRefs: string[] }> = [];

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      log(`  🤖 Question ${i + 1}/${questions.length}: ${question.substring(0, 80)}...`);

      const questionObj = questionsWithInstructions[i];
      const formNote = questionObj?.additionalSource === "form" && additionalSources.form
        ? "\n\nNOTE: This question specifically asks about information that may be found in the official form document provided above."
        : "";

      messages.push({
        role: "user",
        content: `Question ${i + 1}: ${question}${formNote}\n\nPlease provide your answer in this JSON format:\n{\n  "answer": "Your detailed answer in plain language, including specific section references when citing statute information",\n  "sourceReference": "Specific statute section or form document section if identifiable",\n  "confidence": 85\n}`,
      });

      const estimatedTokens = estimateTokens(messages.map(m => m.content).join(" ")) + 300;
      await checkRateLimit(estimatedTokens);

      const response = await openai.chat.completions.create({
        model,
        messages,
        response_format: { type: "json_object" },
      });

      const actualTokens = response.usage?.total_tokens || estimatedTokens;
      recordTokenUsage(actualTokens);
      await sleep(QUESTION_PAUSE_MS);

      const result = JSON.parse(response.choices[0].message.content || "{}");
      const answer = result.answer || "Not specified in the statute.";
      const confidence = Math.max(0, Math.min(100, result.confidence || 50));

      const referencedDocuments = detectReferencedDocuments(answer, response.choices[0].message.content || undefined);
      const enhancedSourceRefs = metadata ? generateEnhancedSourceRefs(answer, metadata, referencedDocuments) : [];
      const legacySourceRefs = result.sourceReference
        ? extractSectionReferences(result.sourceReference)
        : extractSectionReferences(answer);

      if (metadata && legacySourceRefs.length > 0) {
        referencedDocuments.add('statute');
        const updated = generateEnhancedSourceRefs(answer, metadata, referencedDocuments);
        enhancedSourceRefs.length = 0;
        enhancedSourceRefs.push(...updated);
      }

      messages.push({ role: "assistant", content: response.choices[0].message.content || "{}" });
      results.push({ answer, confidence, sourceRefs: enhancedSourceRefs.length > 0 ? enhancedSourceRefs as any : legacySourceRefs });
      log(`    ✓ ${answer.substring(0, 100)}... (confidence: ${confidence}%)`);
    }

    log(`🎉 Completed conversation analysis: ${results.length} questions answered`);
    await sleep(QUESTION_SET_PAUSE_MS);
    return results;
  } catch (error) {
    console.error("Error in conversation analysis:", error);
    return questions.map(() => ({ answer: "Not specified in the statute.", confidence: 0, sourceRefs: [] }));
  }
}

/** Generate a gap analysis suggestion for a single question/answer pair */
export async function generateGapAnalysis(
  question: string,
  answer: string,
  confidence: number,
  municipality: string,
  domain: string,
  calculateScore: (answer: string, confidence: number) => number,
  model = "gpt-4o",
  dataDir = "data",
): Promise<string | null> {
  try {
    const score = calculateScore(answer, confidence);
    if (score >= 1.0) return null;

    const metaAnalysis = await loadMetaAnalysis(domain, dataDir);
    let metaContext = "";
    if (metaAnalysis?.bestPractices) {
      const bp = metaAnalysis.bestPractices.find((bp: any) => {
        if (!bp.questionText) return false;
        if (bp.questionText.toLowerCase() === question.toLowerCase()) return true;
        const qWords = question.toLowerCase().split(" ").filter(w => w.length > 3);
        const pWords = bp.questionText.toLowerCase().split(" ").filter((w: string) => w.length > 3);
        return qWords.filter(w => pWords.includes(w)).length >= 2;
      });
      if (bp) {
        metaContext = `\n\nBEST PRACTICE CONTEXT: The highest-performing municipality (${bp.bestEntity?.displayName || "unknown"}) achieved a score of ${bp.bestScore}/1.0 with this approach: "${bp.bestAnswer?.substring(0, 200)}..." Consider recommending similar comprehensive standards.`;
      }
    }

    const isNotSpecified = answer === "Not specified in the statute.";
    const isLowConfidence = confidence < 40;
    const guidance = getQuestionTypeGuidance(question);

    const gapPrompt = isNotSpecified || isLowConfidence
      ? `Analyze what appears to be missing from a municipal statute based on this question and result:\n\nQuestion: ${question}\nEntity Result: ${answer}\nDomain: ${domain}${metaContext}\n\nThe statute appears to not address this topic. Provide specific regulatory recommendations for what the municipality should establish:\n\n${guidance}\n\nIMPORTANT: Start your response with "Consider adding..." and provide one concrete, actionable recommendation (1 sentence max).`
      : `Analyze this municipal statute answer for specific improvement opportunities:\n\nQuestion: ${question}\nEntity Answer: ${answer}\nConfidence: ${confidence}% | Score: ${score.toFixed(2)}/1.0${metaContext}\n\nIdentify SPECIFIC gaps and improvements (not generic advice):\n\n${guidance}\n\nIMPORTANT: Start your response with "Consider adding..." to provide constructive recommendations.\n\nIf the statute is already comprehensive, respond with "Consider this statute comprehensive - no significant regulatory gaps identified"\n\nProvide one concrete, actionable gap (1 sentence max):`;

    const estimatedTokens = estimateTokens(gapPrompt) + 150;
    await checkRateLimit(estimatedTokens);

    const gapResponse = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: gapPrompt }],
      temperature: 0.1,
      max_tokens: 150,
    });

    recordTokenUsage(gapResponse.usage?.total_tokens || estimatedTokens);

    const gap = gapResponse.choices[0].message.content || null;
    if (gap && (gap.includes("establish comprehensive regulations") || gap.includes("Gap analysis not available") || gap.length < 20 || gap.toLowerCase().startsWith("the answer")))
      return null;

    log(`Generated gap analysis for ${municipality}: ${gap?.substring(0, 100)}...`);
    return gap;
  } catch (error) {
    log(`Error generating gap analysis: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}