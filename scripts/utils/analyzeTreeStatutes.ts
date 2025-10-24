#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Question {
  id: number;
  question: string;
}

interface StatuteAnalysis {
  municipality: string;
  municipalityId: string;
  domain: string;
  analyzedAt: string;
  answers: {
    questionId: number;
    question: string;
    answer: string;
    confidence: "high" | "medium" | "low";
    relevantSections: string[];
  }[];
  suggestions: {
    alignmentGaps: string[];
    bestPracticesFromOthers: string[];
    potentialImprovements: string[];
    modernizationOpportunities: string[];
  };
  overallAssessment: {
    comprehensiveness: "comprehensive" | "moderate" | "limited";
    clarity: "clear" | "moderate" | "unclear";
    modernization: "modern" | "dated" | "outdated";
  };
}

async function loadQuestions(): Promise<Question[]> {
  const questionsPath = path.join(process.cwd(), 'data', 'trees', 'questions.json');
  if (!(await fs.pathExists(questionsPath))) {
    throw new Error('Tree questions file not found. Run generateTreeQuestions.ts first.');
  }
  
  const questionsData = await fs.readJson(questionsPath);
  return questionsData.questions;
}

async function analyzeStatuteAgainstQuestions(
  municipalityId: string, 
  municipalityName: string, 
  statuteContent: string, 
  questions: Question[]
): Promise<StatuteAnalysis> {
  
  console.log(`🔍 Analyzing ${municipalityName} statute...`);
  
  const analysisPrompt = `You are analyzing a municipal tree preservation statute for ${municipalityName} against a set of practical questions that residents ask. 

Please provide:
1. Clear answers to each question based on this statute
2. Confidence level (high/medium/low) for each answer
3. Relevant statute sections that support each answer
4. Suggestions for alignment with best practices from other municipalities

STATUTE CONTENT:
${statuteContent}

QUESTIONS TO ANALYZE:
${questions.map(q => `${q.id}. ${q.question}`).join('\n')}

Respond in JSON format with this structure:
{
  "answers": [
    {
      "questionId": number,
      "question": "string",
      "answer": "clear, practical answer based on the statute",
      "confidence": "high|medium|low",
      "relevantSections": ["section references from statute"]
    }
  ],
  "suggestions": {
    "alignmentGaps": ["gaps where this statute differs from common practices"],
    "bestPracticesFromOthers": ["specific practices this municipality could adopt"],
    "potentialImprovements": ["areas where the statute could be clearer or more comprehensive"],
    "modernizationOpportunities": ["ways to update the statute for current needs"]
  },
  "overallAssessment": {
    "comprehensiveness": "comprehensive|moderate|limited",
    "clarity": "clear|moderate|unclear", 
    "modernization": "modern|dated|outdated"
  }
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      messages: [
        {
          role: "system",
          content: "You are an expert municipal law analyst specializing in tree preservation ordinances. Provide practical, actionable analysis that helps municipalities improve their regulations."
        },
        {
          role: "user",
          content: analysisPrompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 3000
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    
    return {
      municipality: municipalityName,
      municipalityId: municipalityId,
      domain: "trees",
      analyzedAt: new Date().toISOString(),
      answers: result.answers || [],
      suggestions: result.suggestions || {
        alignmentGaps: [],
        bestPracticesFromOthers: [],
        potentialImprovements: [],
        modernizationOpportunities: []
      },
      overallAssessment: result.overallAssessment || {
        comprehensiveness: "moderate",
        clarity: "moderate", 
        modernization: "dated"
      }
    };
    
  } catch (error) {
    console.error(`❌ Analysis failed for ${municipalityName}:`, error);
    throw new Error(`Failed to analyze ${municipalityName}: ${error.message}`);
  }
}

async function analyzeAllTreeStatutes(): Promise<void> {
  const questions = await loadQuestions();
  const treesDir = path.join(process.cwd(), 'data', 'trees');
  const municipalities = await fs.readdir(treesDir);
  
  let processedCount = 0;
  const analyses: StatuteAnalysis[] = [];
  
  for (const municipalityId of municipalities) {
    const municipalityPath = path.join(treesDir, municipalityId);
    const stat = await fs.stat(municipalityPath);
    
    if (!stat.isDirectory() || municipalityId.endsWith('.json')) continue;
    
    const statutePath = path.join(municipalityPath, 'statute.txt');
    if (!(await fs.pathExists(statutePath))) continue;
    
    const municipalityName = municipalityId
      .replace('NY-', '')
      .replace('-Town', ' Town')
      .replace('-Village', ' Village') 
      .replace('-City', ' City')
      .replace('-TownVillage', ' Town/Village');
    
    try {
      const fullStatuteContent = await fs.readFile(statutePath, 'utf-8');
      // Limit content to prevent rate limiting - focus on key sections
      const statuteContent = fullStatuteContent.slice(0, 6000);
      
      const analysis = await analyzeStatuteAgainstQuestions(
        municipalityId,
        municipalityName, 
        statuteContent,
        questions
      );
      
      // Save individual analysis
      const analysisPath = path.join(municipalityPath, 'analysis.json');
      await fs.writeJson(analysisPath, analysis, { spaces: 2 });
      
      analyses.push(analysis);
      processedCount++;
      
      console.log(`✅ ${municipalityName} analysis saved`);
      
      // Add delay to respect API rate limits
      await new Promise(resolve => setTimeout(resolve, 3000));
      
    } catch (error) {
      console.error(`❌ Failed to analyze ${municipalityName}:`, error.message);
      continue;
    }
  }
  
  // Save summary analysis
  const summaryPath = path.join(treesDir, 'analysis-summary.json');
  await fs.writeJson(summaryPath, {
    domain: "trees",
    analyzedAt: new Date().toISOString(),
    totalMunicipalities: processedCount,
    questionsAnalyzed: questions.length,
    analyses: analyses.map(a => ({
      municipalityId: a.municipalityId,
      municipality: a.municipality,
      comprehensiveness: a.overallAssessment.comprehensiveness,
      clarity: a.overallAssessment.clarity,
      modernization: a.overallAssessment.modernization,
      suggestionCount: Object.values(a.suggestions).flat().length
    }))
  }, { spaces: 2 });
  
  console.log(`\n🎉 Tree statute analysis complete!`);
  console.log(`- Analyzed ${processedCount} municipalities`);
  console.log(`- Generated answers to ${questions.length} questions per municipality`);
  console.log(`- Created individual analysis.json files for each municipality`);
  console.log(`- Summary saved to data/trees/analysis-summary.json`);
}

async function main(): Promise<void> {
  try {
    console.log('🌳 Starting comprehensive tree statute analysis...\n');
    await analyzeAllTreeStatutes();
  } catch (error) {
    console.error('❌ Analysis failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { analyzeStatuteAgainstQuestions, loadQuestions };