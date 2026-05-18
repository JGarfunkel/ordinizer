#!/usr/bin/env tsx

import dotenv from "dotenv";
dotenv.config();

import fs from "fs-extra";
import path from "path";
import { parseCommonCliArgs, requireDataRootAndRealm } from "./scriptArgs.js";
import {
  currentModel,
  loadModelConfig,
  checkRateLimit,
  estimateTokens,
  recordTokenUsage,
  createChatCompletion,
} from "../services/aiService.js";
import { getDefaultStorage } from "@civillyengaged/ordinizer-servercore"
import { type Domain, type Question } from "@civillyengaged/ordinizer-core";


interface QuestionsOutput {
  domain: string;
  generatedAt: string;
  description: string;
  questions: Question[];
}

interface GeneratedQuestion {
  category?: string;
  question: string;
  scoreInstructions?: string;
  weight?: number;
}

interface ScriptOptions {
  dataRoot: string;
  realm: string;
  force: boolean;
  dryRun: boolean;
  count: number;
  domainId: string;
  createPlaceholderRulesets: boolean;
}

function parseArgs(args: string[]) {
  const { common, rest } = parseCommonCliArgs(args);
  requireDataRootAndRealm(common);

  const options: Partial<ScriptOptions> = {
    dataRoot: common.dataRoot,
    realm: common.realm,
    force: common.force,
    dryRun: common.dryRun,
    count: 18,
    domainId: common.domain,
    createPlaceholderRulesets: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--count") {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 10 || value > 30) {
        throw new Error("--count must be between 10 and 30");
      }
      options.count = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === "--domain-id") {
      options.domainId = rest[i + 1] || options.domainId;
      i += 1;
      continue;
    }
    if (arg === "--create-placeholder-rulesets") {
      options.createPlaceholderRulesets = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.domainId) {
    throw new Error("Domain id is required. Pass --domain <id> or --domain-id <id>");
  }

  return options as ScriptOptions;
}

function resolveDataRoot(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function normalizeUrl(url: string): string {
  return url.trim();
}

function buildPromptScope(domain: Domain): string {
  const parts: string[] = [];

  const identity = domain.displayName || domain.name || domain.id;
  parts.push(`Domain: ${identity}`);

  if (domain.description) {
    parts.push(`Description: ${domain.description}`);
  }

  if (domain.questionPromptScope) {
    parts.push(`Scope: ${domain.questionPromptScope}`);
  }

  if (Array.isArray(domain.keywords) && domain.keywords.length > 0) {
    parts.push(`Keywords: ${domain.keywords.join(", ")}`);
  }

  if (Array.isArray(domain.questionPromptRequirements) && domain.questionPromptRequirements.length > 0) {
    parts.push(`Additional requirements: ${domain.questionPromptRequirements.join("; ")}`);
  }

  return parts.join("\n");
}

async function generateQuestionsForDomain(count: number, domain: Domain): Promise<GeneratedQuestion[]> {
  const promptScope = buildPromptScope(domain);

  const prompt = `Generate 6 to 10 practical evaluation questions for this domain. 
  The weight indicates the relative importance of the question for assessing overall quality in this domain,
   from 0.0 to 1.0. The more relatively important the question, the higher the weight. 
   scoreInstructions is for providing guidance for how the AI will score the answers.

${promptScope}

Return JSON ONLY using this shape:
{
  "questions": [
    {
      "category": "Category label, 2-3 words",
      "question": "Question text",
      "scoreInstructions": "Concise scoring guidance",
      "weight": 1
    }
  ]
}

Requirements:
- Questions must be organization-agnostic.
- Questions should be specific enough to evaluate quality.
- Use short category labels.
- Avoid duplicate or near-duplicate questions.
- Keep each question under 220 characters.`;

  const estimatedTokens = estimateTokens(prompt) + 600;
  await checkRateLimit(estimatedTokens);

  const response = await createChatCompletion(prompt, {
    model: currentModel,
    temperature: 0.4,
  });

  recordTokenUsage(response.usage?.totalTokens || estimatedTokens);

  const content = response.text;
  if (!content) {
    throw new Error("AI response was empty");
  }

  const parsed = JSON.parse(content) as { questions?: GeneratedQuestion[] };
  if (!parsed.questions || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error("OpenAI response does not contain a questions array");
  }

  return parsed.questions.filter((q) => typeof q?.question === "string" && q.question.trim().length > 0);
}

async function createPlaceholderRulesetsForDomain(
  storage: ReturnType<typeof getDefaultStorage>,
  domain: Domain,
  options: ScriptOptions,
) {
  const domainId = domain.id;
  const entities = await storage.getEntities();
  let created = 0;
  let skipped = 0;

  for (const entity of entities) {
    if (!entity?.id) {
      continue;
    }

    const alreadyExists = await storage.rulesetExists(domainId, entity.id);
    if (alreadyExists && !options.force) {
      skipped += 1;
      continue;
    }

    const ruleset = await storage.getRulesetOrCreate(domainId, entity.id);
    ruleset.municipality = ruleset.municipality || entity.name || entity.displayName || entity.id;
    ruleset.municipalityType = ruleset.municipalityType || entity.type;
    ruleset.domain = ruleset.domain || domain.displayName || domain.name || domainId;
    ruleset.homePage = ruleset.homePage || entity.website || "";
    ruleset.sources = [];

    if (options.dryRun) {
      created += 1;
      continue;
    }

    await fs.ensureDir(path.join(storage.getRealmDir(), domainId, entity.id));
    await storage.saveRuleset(ruleset);
    created += 1;
  }

  const prefix = options.dryRun ? "[DRY-RUN]" : "[PLACEHOLDER]";
  console.log(`${prefix} ${domainId}: created ${created} placeholder metadata files, skipped ${skipped} existing.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataRoot = resolveDataRoot(options.dataRoot);
  process.env.DATA_ROOT = dataRoot;

  const storage = getDefaultStorage(options.realm);

  const domainId = options.domainId;
  const existingDomains = (await storage.getDomains()) as Domain[];
  const domainFromConfig = existingDomains.find((d) => d.id === domainId || d.name === domainId);
  if (!domainFromConfig) {
    const available = existingDomains.map((d) => d.id || d.name).filter(Boolean).join(", ");
    throw new Error(`Domain ${domainId} not found in domains config. Available: ${available}`);
  }

  const resolvedDomainId = domainFromConfig.id;
  const realmDir = storage.getRealmDir();
  const domainQuestionsDir = path.join(realmDir, resolvedDomainId);
  const domainQuestionsPath = path.join(domainQuestionsDir, "questions.json");
  const questionsExist = await fs.pathExists(domainQuestionsPath);

  if (questionsExist && !options.force && !options.createPlaceholderRulesets) {
    throw new Error(
      `Domain questions already exist at ${normalizeUrl(domainQuestionsPath)}. Use --force to regenerate.`,
    );
  }

  const shouldGenerateQuestions = !questionsExist || options.force;
  let questions: QuestionsOutput | null = null;

  if (shouldGenerateQuestions) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required");
    }

    await loadModelConfig();
    const generated = await generateQuestionsForDomain(options.count, domainFromConfig);
    questions = {
      domain: resolvedDomainId,
      generatedAt: new Date().toISOString(),
      description: domainFromConfig.description || "",
      questions: generated.slice(0, options.count).map((q, index) => ({
        id: index + 1,
        domainId: resolvedDomainId,
        title: q.question.trim(),
        category: (q.category || domainFromConfig.displayName || resolvedDomainId).trim(),
        question: q.question.trim(),
        scoreInstructions: q.scoreInstructions?.trim(),
        order: String(index + 1),
        weight: Number.isFinite(q.weight) ? Number(q.weight) : 1,
      })),
    };
  }

  if (options.dryRun) {
    console.log("DRY RUN: no files written");
    if (shouldGenerateQuestions && questions) {
      console.log(`Would write: ${normalizeUrl(domainQuestionsPath)}`);
      console.log(`Question count: ${questions.questions.length}`);
    } else {
      console.log(`Questions already exist, leaving as-is: ${normalizeUrl(domainQuestionsPath)}`);
    }
    if (options.createPlaceholderRulesets) {
      await createPlaceholderRulesetsForDomain(storage, domainFromConfig, options);
    }
    return;
  }

  if (shouldGenerateQuestions && questions) {
    await fs.ensureDir(domainQuestionsDir);
    await fs.writeJson(domainQuestionsPath, questions, { spaces: 2 });
    console.log(`Saved domain questions: ${normalizeUrl(domainQuestionsPath)}`);
    console.log(`Generated ${questions.questions.length} questions for ${resolvedDomainId}.`);
  } else {
    console.log(`Questions already exist, leaving as-is: ${normalizeUrl(domainQuestionsPath)}`);
  }

  if (options.createPlaceholderRulesets) {
    await createPlaceholderRulesetsForDomain(storage, domainFromConfig, options);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Script failed: ${message}`);
  process.exit(1);
});
