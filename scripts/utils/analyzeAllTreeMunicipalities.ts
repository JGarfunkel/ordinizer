#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Question {
  id: number;
  question: string;
  order: number;
}

interface Answer {
  questionId: number;
  question: string;
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  relevantSections: string[];
}

interface Analysis {
  municipality: string;
  municipalityId: string;
  domain: string;
  analyzedAt: string;
  answers: Answer[];
  alignmentSuggestions: {
    strengths: string[];
    improvements: string[];
    recommendations: string[];
    bestPractices: string[];
  };
}

const DATA_DIR = './data';
const DOMAIN = 'trees';
const DELAY_MS = 3000; // 3 second delay to avoid rate limiting

async function loadQuestions(): Promise<Question[]> {
  const questionsFile = path.join(DATA_DIR, DOMAIN, 'questions.json');
  if (!await fs.pathExists(questionsFile)) {
    throw new Error(`Questions file not found: ${questionsFile}`);
  }
  const data = await fs.readJson(questionsFile);
  return data.questions;
}

async function analyzeStatute(municipalityDir: string, questions: Question[]): Promise<Analysis | null> {
  const statuteFile = path.join(municipalityDir, 'statute.txt');
  const metadataFile = path.join(municipalityDir, 'metadata.json');
  const analysisFile = path.join(municipalityDir, 'analysis.json');

  if (!await fs.pathExists(statuteFile) || !await fs.pathExists(metadataFile)) {
    console.log(`⚠️ Missing files in ${path.basename(municipalityDir)}, skipping...`);
    return null;
  }

  // Force regeneration - remove this check to regenerate all analyses
  console.log(`🔄 Regenerating analysis for ${path.basename(municipalityDir)}...`);

  const statute = await fs.readFile(statuteFile, 'utf-8');
  const metadata = await fs.readJson(metadataFile);
  
  const municipality = `${metadata.municipality} ${metadata.municipalityType}`;
  const municipalityId = path.basename(municipalityDir);

  console.log(`\n🔍 Analyzing ${municipality}...`);

  // Create analysis prompt focused only on this municipality
  const analysisPrompt = `You are a municipal law expert analyzing tree regulations for ${municipality}. 

STATUTE TEXT:
${statute}

INSTRUCTIONS:
1. Answer each question based ONLY on the statute for ${municipality}
2. Do NOT mention or compare to other municipalities
3. Be concise and specific - focus on practical information residents need
4. If information is not clearly stated in the statute, say "not specified in the statute"
5. Always cite relevant section numbers when available
6. Rate your confidence: high (clearly stated), medium (can be inferred), low (unclear/not found)

QUESTIONS TO ANSWER:
${questions.map(q => `${q.id}. ${q.question}`).join('\n')}

Also provide alignment suggestions focusing on:
- Strengths: What this municipality does well in tree regulation
- Improvements: Areas where regulations could be clearer or more comprehensive  
- Recommendations: Specific suggestions for better tree management
- Best practices: Notable positive aspects other municipalities could learn from

Format as JSON:
{
  "answers": [
    {
      "questionId": 1,
      "question": "Original question text",
      "answer": "Clear, concise answer focusing only on this municipality",
      "confidence": "high|medium|low", 
      "relevantSections": ["§185-1", "§185-2"]
    }
  ],
  "alignmentSuggestions": {
    "strengths": ["Strength 1", "Strength 2"],
    "improvements": ["Improvement 1", "Improvement 2"], 
    "recommendations": ["Recommendation 1", "Recommendation 2"],
    "bestPractices": ["Best practice 1", "Best practice 2"]
  }
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a municipal law expert. Analyze tree regulations for ${municipality} only. Provide concise, practical answers without comparing to other municipalities. Respond with valid JSON only.`
        },
        {
          role: "user",
          content: analysisPrompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const result = JSON.parse(response.choices[0].message.content!);

    const analysis: Analysis = {
      municipality,
      municipalityId,
      domain: DOMAIN,
      analyzedAt: new Date().toISOString(),
      answers: result.answers.map((answer: any) => ({
        ...answer,
        question: questions.find(q => q.id === answer.questionId)?.question || answer.question
      })),
      alignmentSuggestions: result.alignmentSuggestions
    };

    // Save analysis
    await fs.writeJson(analysisFile, analysis, { spaces: 2 });

    console.log(`✅ Analysis completed for ${municipality}`);
    return analysis;

  } catch (error) {
    console.error(`❌ Error analyzing ${municipality}:`, error);
    return null;
  }
}

async function main() {
  try {
    console.log('🚀 Starting comprehensive tree analysis for all municipalities...');

    // Load questions
    const questions = await loadQuestions();
    console.log(`📋 Loaded ${questions.length} municipality-specific questions`);

    // Find all municipality directories
    const treesDir = path.join(DATA_DIR, DOMAIN);
    const entries = await fs.readdir(treesDir, { withFileTypes: true });
    const municipalityDirs = entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith('NY-'))
      .map(entry => path.join(treesDir, entry.name));

    console.log(`🏘️ Found ${municipalityDirs.length} municipalities to analyze`);

    let completed = 0;
    let skipped = 0;
    let failed = 0;

    for (const municipalityDir of municipalityDirs) {
      try {
        const analysis = await analyzeStatute(municipalityDir, questions);
        if (analysis) {
          completed++;
        } else {
          skipped++;
        }
      } catch (error) {
        failed++;
        console.error(`❌ Failed to analyze ${path.basename(municipalityDir)}:`, error);
      }

      // Add delay to avoid rate limiting
      if (completed + failed < municipalityDirs.length) {
        console.log(`⏳ Waiting ${DELAY_MS/1000} seconds before next analysis...`);
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }

    console.log(`\n🎉 Analysis batch completed!`);
    console.log(`📊 Results: ${completed} completed, ${skipped} skipped, ${failed} failed`);
    console.log(`📁 Total municipalities processed: ${municipalityDirs.length}`);

  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Run main function
main();