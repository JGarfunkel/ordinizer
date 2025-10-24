#!/usr/bin/env tsx
import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';

// Initialize OpenAI - the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Question {
  id: number;
  text: string;
  category: string;
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
  domain: string;
  grade: string;
  gradeColor: string;
  lastUpdated: string;
  answers: Answer[];
  alignmentSuggestions: {
    strengths: string[];
    improvements: string[];
    recommendations: string[];
    bestPractices: string[];
  };
}

const DATA_DIR = './data';
const DOMAIN = 'property-maintenance';

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadQuestions(): Promise<Question[]> {
  const questionsFile = path.join(DATA_DIR, DOMAIN, 'questions.json');
  if (!await fs.pathExists(questionsFile)) {
    throw new Error(`Questions file not found: ${questionsFile}`);
  }
  return await fs.readJson(questionsFile);
}

async function getFileModifiedTime(filePath: string): Promise<Date | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtime;
  } catch {
    return null;
  }
}

async function analyzeIncrementally(municipalityDir: string, questions: Question[]): Promise<void> {
  const statuteFile = path.join(municipalityDir, 'statute.txt');
  const metadataFile = path.join(municipalityDir, 'metadata.json');
  const analysisFile = path.join(municipalityDir, 'analysis.json');
  const questionsFile = path.join(DATA_DIR, DOMAIN, 'questions.json');

  if (!await fs.pathExists(statuteFile) || !await fs.pathExists(metadataFile)) {
    console.log(`⚠️ Missing files in ${path.basename(municipalityDir)}, skipping...`);
    return;
  }

  const metadata = await fs.readJson(metadataFile);
  const municipality = `${metadata.municipalityName} - ${metadata.municipalityType}`;

  console.log(`🔄 Checking ${municipality}...`);

  // Check if analysis exists and is current
  let existingAnalysis: Analysis | null = null;
  let needsUpdate = true;
  
  if (await fs.pathExists(analysisFile)) {
    try {
      existingAnalysis = await fs.readJson(analysisFile);
      
      // Check if analysis is newer than both statute and questions files
      const analysisTime = new Date(existingAnalysis.lastUpdated);
      const statuteTime = await getFileModifiedTime(statuteFile);
      const questionsTime = await getFileModifiedTime(questionsFile);
      
      if (statuteTime && questionsTime && 
          analysisTime > statuteTime && 
          analysisTime > questionsTime) {
        
        // Check if all questions are answered
        const answeredQuestionIds = new Set(existingAnalysis.answers.map(a => a.questionId));
        const allQuestionIds = new Set(questions.map(q => q.id));
        
        const missingQuestions = questions.filter(q => !answeredQuestionIds.has(q.id));
        
        if (missingQuestions.length === 0) {
          console.log(`✅ ${municipality} analysis is current with all ${questions.length} questions answered`);
          needsUpdate = false;
        } else {
          console.log(`📝 ${municipality} missing ${missingQuestions.length} new questions`);
          // Only analyze the missing questions
          questions = missingQuestions;
        }
      }
    } catch (error) {
      console.log(`⚠️ Could not read existing analysis for ${municipality}`);
    }
  }

  if (!needsUpdate) return;

  console.log(`🔍 Analyzing ${municipality} for ${questions.length} questions...`);

  // Read and truncate statute for token limits
  const fullStatute = await fs.readFile(statuteFile, 'utf-8');
  const truncatedStatute = fullStatute.substring(0, 8000);

  // Create targeted prompt for missing questions only
  const analysisPrompt = `Analyze ${municipality} property maintenance regulations. Answer these specific questions based on the statute excerpt below. If not clearly stated, say "not specified".

STATUTE EXCERPT:
${truncatedStatute}

QUESTIONS TO ANSWER:
${questions.map(q => `${q.id}. ${q.text}`).join('\n')}

Respond with JSON only:
{
  "answers": [
    {
      "questionId": ${questions[0]?.id || 1},
      "question": "question text",
      "answer": "brief answer",
      "confidence": "high|medium|low",
      "relevantSections": ["section references if found"]
    }
  ]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: analysisPrompt }],
      response_format: { type: "json_object" },
      max_tokens: 3000,
      temperature: 0.3
    });

    const aiAnalysis = JSON.parse(response.choices[0].message.content || '{}');
    const newAnswers = aiAnalysis.answers || [];

    // Merge with existing analysis
    const finalAnalysis: Analysis = {
      municipality,
      domain: 'Property Maintenance',
      grade: existingAnalysis?.grade || 'Not Graded',
      gradeColor: existingAnalysis?.gradeColor || '#6b7280',
      lastUpdated: new Date().toISOString(),
      answers: [
        ...(existingAnalysis?.answers || []),
        ...newAnswers
      ].sort((a, b) => a.questionId - b.questionId), // Keep answers sorted by question ID
      alignmentSuggestions: existingAnalysis?.alignmentSuggestions || {
        strengths: [`Based on ${municipality} regulations`],
        improvements: ['Analysis based on partial statute excerpt'],
        recommendations: ['Full statute review recommended'],
        bestPractices: ['Property maintenance standards implemented']
      }
    };

    await fs.writeJson(analysisFile, finalAnalysis, { spaces: 2 });
    
    if (existingAnalysis && questions.length < 12) {
      console.log(`✅ Updated ${municipality} with ${questions.length} new questions`);
    } else {
      console.log(`✅ Created complete analysis for ${municipality}`);
    }

  } catch (error) {
    console.error(`❌ Failed to analyze ${municipality}:`, error.message);
  }
}

async function main(): Promise<void> {
  console.log('\n🏠 Property Maintenance Incremental Analysis 🏠\n');
  
  try {
    const questions = await loadQuestions();
    console.log(`📋 Loaded ${questions.length} questions`);

    const domainDir = path.join(DATA_DIR, DOMAIN);
    const municipalityDirs = await fs.readdir(domainDir);
    const validDirs = [];
    
    for (const dir of municipalityDirs) {
      const fullPath = path.join(domainDir, dir);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory() && dir.startsWith('NY-')) {
        validDirs.push(fullPath);
      }
    }

    console.log(`📁 Found ${validDirs.length} municipalities to check\n`);

    let analyzed = 0;
    let skipped = 0;

    for (const municipalityDir of validDirs) {
      try {
        const startTime = Date.now();
        await analyzeIncrementally(municipalityDir, questions);
        
        const processingTime = Date.now() - startTime;
        if (processingTime > 1000) { // Only count as analyzed if it took time (AI call made)
          analyzed++;
          // Rate limiting delay only after AI calls
          if (municipalityDir !== validDirs[validDirs.length - 1]) {
            console.log(`⏱️ Waiting 3 seconds...`);
            await delay(3000);
          }
        } else {
          skipped++;
        }
        
      } catch (error) {
        console.error(`❌ Error processing ${path.basename(municipalityDir)}:`, error);
      }
    }

    console.log(`\n🎉 Incremental Analysis Complete! 🎉`);
    console.log(`✅ Analyzed: ${analyzed} municipalities`);
    console.log(`⏭️ Skipped (current): ${skipped} municipalities`);

  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);