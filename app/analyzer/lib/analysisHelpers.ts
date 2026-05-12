import fs from "fs/promises";
import path from "path";
import { checkRateLimit, estimateTokens, fetchChatResponse, log, recordTokenUsage } from "../services/aiService.js";

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

function getQuestionTypeGuidance(question: string): string {
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

    const isNotSpecified = answer === "Not specified in the statute." || answer === "Not specified in the provided sources.";
    const isLowConfidence = confidence < 40;
    const guidance = getQuestionTypeGuidance(question);

    const gapPrompt = isNotSpecified || isLowConfidence
      ? `Analyze what appears to be missing from a municipal statute based on this question and result:\n\nQuestion: ${question}\nEntity Result: ${answer}\nDomain: ${domain}${metaContext}\n\nThe statute appears to not address this topic. Provide specific regulatory recommendations for what the municipality should establish:\n\n${guidance}\n\nIMPORTANT: Start your response with "Consider adding..." and provide one concrete, actionable recommendation (1 sentence max).`
      : `Analyze this municipal statute answer for specific improvement opportunities:\n\nQuestion: ${question}\nEntity Answer: ${answer}\nConfidence: ${confidence}% | Score: ${score.toFixed(2)}/1.0${metaContext}\n\nIdentify SPECIFIC gaps and improvements (not generic advice):\n\n${guidance}\n\nIMPORTANT: Start your response with "Consider adding..." to provide constructive recommendations.\n\nIf the statute is already comprehensive, respond with "Consider this statute comprehensive - no significant regulatory gaps identified"\n\nProvide one concrete, actionable gap (1 sentence max):`;

    const estimatedTokens = estimateTokens(gapPrompt) + 150;
    await checkRateLimit(estimatedTokens);

    const gapResponse = await fetchChatResponse(model, gapPrompt);
    recordTokenUsage(gapResponse.usage?.total_tokens || estimatedTokens);

    const gap = gapResponse.choices[0].message.content || null;
    if (gap && (gap.includes("establish comprehensive regulations") || gap.includes("Gap analysis not available") || gap.length < 20 || gap.toLowerCase().startsWith("the answer"))) {
      return null;
    }

    log(`Generated gap analysis for ${municipality}: ${gap?.substring(0, 100)}...`);
    return gap;
  } catch (error) {
    log(`Error generating gap analysis: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
