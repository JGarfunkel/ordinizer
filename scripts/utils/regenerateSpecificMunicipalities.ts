import path from "path";
import fs from "fs-extra";
import OpenAI from "openai";

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

async function loadQuestions(): Promise<Question[]> {
  const questionsFile = path.join(DATA_DIR, DOMAIN, 'questions.json');
  if (!await fs.pathExists(questionsFile)) {
    throw new Error(`Questions file not found: ${questionsFile}`);
  }
  const data = await fs.readJson(questionsFile);
  return data.questions;
}

async function analyzeStatute(municipalityId: string, questions: Question[]): Promise<Analysis | null> {
  const municipalityDir = path.join(DATA_DIR, DOMAIN, municipalityId);
  const statuteFile = path.join(municipalityDir, 'statute.txt');
  const metadataFile = path.join(municipalityDir, 'metadata.json');
  const analysisFile = path.join(municipalityDir, 'analysis.json');

  if (!await fs.pathExists(statuteFile) || !await fs.pathExists(metadataFile)) {
    console.log(`⚠️ Missing files in ${municipalityId}, skipping...`);
    return null;
  }

  const statute = await fs.readFile(statuteFile, 'utf-8');
  const metadata = await fs.readJson(metadataFile);
  
  const municipality = `${metadata.municipality} ${metadata.municipalityType}`;

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
- What this municipality does well (strengths)
- Where regulations could be clearer (improvements)
- Specific recommendations for better resident experience
- Best practices this municipality demonstrates

Return ONLY valid JSON in this exact format:
{
  "answers": [
    {
      "questionId": 1,
      "question": "exact question text",
      "answer": "detailed answer based only on this municipality's statute",
      "confidence": "high",
      "relevantSections": ["Section 121-1", "Section 121-3(a)"]
    }
  ],
  "alignmentSuggestions": {
    "strengths": ["specific strength 1", "specific strength 2"],
    "improvements": ["specific improvement 1", "specific improvement 2"],
    "recommendations": ["specific recommendation 1", "specific recommendation 2"],
    "bestPractices": ["specific best practice 1", "specific best practice 2"]
  }
}`;

  try {
    console.log(`🤖 Sending analysis request for ${municipality}...`);
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a municipal law expert. Always respond with valid JSON only, no additional text."
        },
        {
          role: "user",
          content: analysisPrompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 4000
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
    console.log('🚀 Starting targeted tree analysis regeneration...');

    // Load questions
    const questions = await loadQuestions();
    console.log(`📋 Loaded ${questions.length} questions`);

    // Target municipalities that need regeneration
    const targetMunicipalities = ['NY-Yorktown-Town', 'NY-Somers-Town'];

    console.log(`🎯 Target municipalities: ${targetMunicipalities.join(', ')}`);

    let completed = 0;
    let failed = 0;

    for (const municipalityId of targetMunicipalities) {
      try {
        const analysis = await analyzeStatute(municipalityId, questions);
        if (analysis) {
          completed++;
        }
      } catch (error) {
        failed++;
        console.error(`❌ Failed to analyze ${municipalityId}:`, error);
      }

      // Add delay to avoid rate limiting
      if (completed + failed < targetMunicipalities.length) {
        console.log(`⏳ Waiting 2 seconds before next analysis...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    console.log(`\n🎉 Targeted regeneration completed!`);
    console.log(`📊 Results: ${completed} completed, ${failed} failed`);

  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Run main function
main();