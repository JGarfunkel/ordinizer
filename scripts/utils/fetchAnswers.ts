#!/usr/bin/env tsx

import fs from "fs";
import path from "path";
import { program } from "commander";
import OpenAI from "openai";
import { VectorService } from "../server/services/vectorService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Question {
  id: string;
  text: string;
  category: string;
}

interface AnalysisAnswer {
  id: string;
  question: string;
  answer: string;
  confidence: number;
  sourceRefs: string[];
}

interface Analysis {
  municipality: {
    id: string;
    displayName: string;
  };
  domain: {
    id: string;
    displayName: string;
  };
  questions: AnalysisAnswer[];
  lastUpdated: string;
  processingMethod?: string;
}

// Configure command-line options
program
  .name("fetchAnswers")
  .description("Fetch answers for municipal statute questions")
  .requiredOption(
    "-m, --municipality <string>",
    "Municipality unique name (e.g., NY-NewCastle-Town)",
  )
  .requiredOption(
    "-d, --domain <string>",
    "Domain name (e.g., property-maintenance)",
  )
  .requiredOption(
    "-t, --topic <string>",
    "Topic/category to search for (e.g., violations, maintenance)",
  )
  .option(
    "-v, --verbose",
    "Show detailed information including prompts and Pinecone index details",
  )
  .parse();

const options = program.opts();

async function main() {
  try {
    const municipalityId = options.municipality;
    const domainId = options.domain.toLowerCase();
    const topic = options.topic.toLowerCase();

    console.log(`🔍 Fetching answers for:`);
    console.log(`   Municipality: ${municipalityId}`);
    console.log(`   Domain: ${domainId}`);
    console.log(`   Topic: ${topic}`);
    console.log("");

    // Load questions for the domain
    const questionsPath = `data/${domainId}/questions.json`;
    if (!fs.existsSync(questionsPath)) {
      throw new Error(`Questions file not found: ${questionsPath}`);
    }
    console.log(`📋 Loading questions from: ${questionsPath}`);
    const questionsData = JSON.parse(fs.readFileSync(questionsPath, "utf-8"));
    const questions: Question[] = questionsData.questions;

    // Find questions matching the topic/category
    const matchingQuestions = questions.filter(
      (q) => q.category && q.category.toLowerCase().includes(topic),
    );

    if (matchingQuestions.length === 0) {
      console.log(`❌ No questions found matching topic: ${topic}`);
      console.log(`Available topics in ${domainId}:`);
      const categories = [...new Set(questions.map((q) => q.category))];
      categories.forEach((cat) => console.log(`   - ${cat}`));

      questions.forEach((q) => console.log(`   - ${q.category}: ${q.text}`));

      return;
    }

    console.log(
      `📋 Found ${matchingQuestions.length} question(s) matching topic "${topic}"`,
    );
    console.log("");

    // Check for existing analysis
    const analysisPath = `data/${domainId}/${municipalityId}/analysis.json`;
    let existingAnalysis: Analysis | null = null;

    if (fs.existsSync(analysisPath)) {
      existingAnalysis = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));
      console.log(`📄 Found existing analysis file: ${analysisPath}`);
    } else {
      console.log(`📄 No existing analysis found at: ${analysisPath}`);
    }

    // Process each matching question
    for (const question of matchingQuestions) {
      console.log(`\n${"=".repeat(80)}`);
      console.log(`Question: ${question.text}`);
      console.log(`Category: ${question.category}`);
      console.log(`${"=".repeat(80)}`);

      // Show existing answer if available
      if (existingAnalysis) {
        const existingAnswer = existingAnalysis.questions.find(
          (a) => a.id === question.id,
        );
        if (existingAnswer) {
          console.log(`\n📋 EXISTING ANALYSIS:`);
          console.log(`Answer: ${existingAnswer.answer}`);
          console.log(`Confidence: ${existingAnswer.confidence}%`);
          console.log(
            `Source References: ${existingAnswer.sourceRefs.join(", ")}`,
          );
        }
      }

      // Generate fresh AI answer
      console.log(`\n🤖 FRESH AI ANALYSIS:`);

      try {
        const vectorService = new VectorService();
        await vectorService.initializeIndex();

        if (options.verbose) {
          console.log(`\n🔧 PINECONE INDEX DETAILS:`);
          console.log(`Index Name: ordinizer-statutes`);
          console.log(`Search Namespace: ${municipalityId}/${domainId}`);
        }

        // Get municipality display name
        const municipalitiesPath = "data/municipalities.json";
        const municipalitiesData = JSON.parse(
          fs.readFileSync(municipalitiesPath, "utf-8"),
        );
        const municipality = municipalitiesData.municipalities.find(
          (m: any) => m.id === municipalityId,
        );
        const municipalityName = municipality
          ? municipality.displayName
          : municipalityId;

        const answer = await generateVectorBasedAnswer(
          question,
          municipalityId,
          municipalityName,
          vectorService,
          options.verbose,
        );

        console.log(`Answer: ${answer.answer}`);
        console.log(`Confidence: ${answer.confidence}%`);
        console.log(`Source References: ${answer.sourceRefs.join(", ")}`);
      } catch (error) {
        console.error(`❌ Error generating AI answer: ${error}`);
      }
    }
  } catch (error) {
    console.error(`❌ Error:`, error);
    process.exit(1);
  }
}

async function generateVectorBasedAnswer(
  question: Question,
  municipalityId: string,
  municipalityName: string,
  vectorService: VectorService,
  verbose: boolean = false,
): Promise<AnalysisAnswer> {
  try {
    // Search for relevant statute sections using vector similarity
    const relevantSections = await vectorService.searchRelevantSections(
      municipalityId,
      "property-maintenance",
      question.text,
      5, // Get top 5 most relevant sections
    );

    if (verbose) {
      console.log(`\n🔍 VECTOR SEARCH RESULTS:`);
      console.log(`Found ${relevantSections.length} relevant sections`);
      relevantSections.forEach((section, i) => {
        console.log(
          `  Section ${i + 1}: Score ${section.score?.toFixed(3)} - ${section.content.substring(0, 100)}...`,
        );
      });
    }

    if (relevantSections.length === 0) {
      return {
        id: question.id,
        question: question.text,
        answer: "Not specified in the statute.",
        confidence: 0,
        sourceRefs: [],
      };
    }

    // Combine relevant sections into context
    const context = relevantSections
      .map((section, index) => {
        const sectionRef = section.metadata?.section
          ? ` - §${section.metadata.section}`
          : "";
        return `[Section ${index + 1}${sectionRef}]\n${section.content}`;
      })
      .join("\n\n");

    // Generate answer using OpenAI with the relevant context
    const systemPrompt = `You are analyzing property maintenance regulations for ${municipalityName}. 
          
Based on the relevant statute sections provided, answer the user's question clearly and concisely.

Guidelines:
- Use plain, everyday language that residents can easily understand
- Be specific about requirements, procedures, penalties, and timelines when mentioned
- If the statute sections don't contain enough information to fully answer the question, respond with "Not specified in the statute."
- Provide a confidence score (0-100) based on how well the statute sections address the question
- Reference specific section numbers when available

Respond in JSON format: {
  "answer": "Clear, concise answer in plain language",
  "confidence": number (0-100),
  "sectionRefs": ["list", "of", "referenced", "sections"]
}`;

    const userPrompt = `Question: ${question.text}

Relevant statute sections:
${context}

Please provide a clear answer based on these statute sections.`;

    if (verbose) {
      console.log(`\n📤 AI PROMPT (SYSTEM):`);
      console.log(systemPrompt);
      console.log(`\n📤 AI PROMPT (USER):`);
      console.log(userPrompt);
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
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
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const result = JSON.parse(response.choices[0].message.content || "{}");

    if (verbose) {
      console.log(`\n📥 AI RESPONSE:`);
      console.log(JSON.stringify(result, null, 2));
    }

    return {
      id: question.id,
      question: question.text,
      answer: result.answer || "Not specified in the statute.",
      confidence: result.confidence || 0,
      sourceRefs: result.sectionRefs || [],
    };
  } catch (error) {
    console.error(`Error analyzing question: ${question.text}`, error);
    return {
      id: question.id,
      question: question.text,
      answer: "Not specified in the statute.",
      confidence: 0,
      sourceRefs: [],
    };
  }
}

main().catch(console.error);
