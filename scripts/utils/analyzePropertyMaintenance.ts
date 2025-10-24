#!/usr/bin/env tsx
import fs from 'fs-extra';
import path from 'path';
import { analyzeStatuteForQuestion } from '../server/services/openai.js';

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
const DELAY_MS = 5000; // 5 second delay to avoid rate limiting

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

async function analyzeStatute(municipalityDir: string, questions: Question[]): Promise<Analysis | null> {
  const statuteFile = path.join(municipalityDir, 'statute.txt');
  const metadataFile = path.join(municipalityDir, 'metadata.json');
  const analysisFile = path.join(municipalityDir, 'analysis.json');

  if (!await fs.pathExists(statuteFile) || !await fs.pathExists(metadataFile)) {
    console.log(`⚠️ Missing files in ${path.basename(municipalityDir)}, skipping...`);
    return null;
  }

  console.log(`🔄 Generating analysis for ${path.basename(municipalityDir)}...`);

  const statute = await fs.readFile(statuteFile, 'utf-8');
  const metadata = await fs.readJson(metadataFile);
  
  const municipality = `${metadata.municipalityName} - ${metadata.municipalityType}`;
  const municipalityId = path.basename(municipalityDir);

  console.log(`🔍 Analyzing ${municipality} property maintenance regulations...`);

  // Check statute length and truncate if needed to avoid token limits
  const maxStatuteLength = 15000; // Conservative limit to stay under token limits
  const truncatedStatute = statute.length > maxStatuteLength 
    ? statute.substring(0, maxStatuteLength) + "\n\n[Note: Statute text truncated due to length]"
    : statute;

  // Restore grade and color from existing analysis if it exists
  let existingGrade = 'Not Graded';
  let existingGradeColor = '#6b7280';
  
  if (await fs.pathExists(analysisFile)) {
    try {
      const existing = await fs.readJson(analysisFile);
      existingGrade = existing.grade || existingGrade;
      existingGradeColor = existing.gradeColor || existingGradeColor;
    } catch (error) {
      console.log(`⚠️ Could not read existing analysis for grade info`);
    }
  }

  // Create comprehensive analysis prompt
  const analysisPrompt = `You are a municipal law expert analyzing property maintenance regulations for ${municipality}. 

STATUTE TEXT:
${truncatedStatute}

INSTRUCTIONS:
1. Answer each question based ONLY on the statute for ${municipality}
2. Do NOT mention or compare to other municipalities
3. Be concise and specific - focus on practical information residents need
4. If information is not clearly stated in the statute, say "not specified in the statute"
5. Always cite relevant section numbers when available
6. Rate your confidence: high (clearly stated), medium (can be inferred), low (unclear/not found)

QUESTIONS TO ANSWER:
${questions.map(q => `${q.id}. ${q.text}`).join('\n')}

Also provide alignment suggestions focusing on:
- Strengths: What this municipality does well in property maintenance regulation
- Improvements: Areas where regulations could be clearer or more comprehensive  
- Recommendations: Specific suggestions for better property maintenance standards
- Best practices: Notable positive aspects other municipalities could learn from

Format as JSON:
{
  "answers": [
    {
      "questionId": 1,
      "question": "Original question text",
      "answer": "Clear answer for ${municipality} only",
      "confidence": "high|medium|low", 
      "relevantSections": ["§123-1", "§123-2"]
    }
  ],
  "alignmentSuggestions": {
    "strengths": ["What ${municipality} does well"],
    "improvements": ["What could be clearer"], 
    "recommendations": ["Specific suggestions"],
    "bestPractices": ["Notable positive aspects"]
  }
}`;

  try {
    const response = await analyzeStatuteForQuestion(analysisPrompt);
    const aiAnalysis = JSON.parse(response);

    const analysis: Analysis = {
      municipality,
      domain: 'Property Maintenance',
      grade: existingGrade,
      gradeColor: existingGradeColor,
      lastUpdated: new Date().toISOString(),
      answers: aiAnalysis.answers || [],
      alignmentSuggestions: aiAnalysis.alignmentSuggestions || {
        strengths: [],
        improvements: [],
        recommendations: [],
        bestPractices: []
      }
    };

    await fs.writeJson(analysisFile, analysis, { spaces: 2 });
    console.log(`✅ Analysis complete for ${municipality}`);
    
    return analysis;

  } catch (error) {
    console.error(`❌ Failed to analyze ${municipality}:`, error);
    return null;
  }
}

async function analyzeAllPropertyMaintenance(): Promise<void> {
  console.log('\n🏠 Starting Property Maintenance Analysis for All Municipalities 🏠\n');
  
  try {
    // Load questions
    const questions = await loadQuestions();
    console.log(`📋 Loaded ${questions.length} questions`);

    // Find all municipality directories
    const domainDir = path.join(DATA_DIR, DOMAIN);
    const municipalityDirs = await fs.readdir(domainDir);
    const validMunicipalityDirs = [];
    
    for (const dir of municipalityDirs) {
      const fullPath = path.join(domainDir, dir);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory() && dir.startsWith('NY-')) {
        validMunicipalityDirs.push(fullPath);
      }
    }

    console.log(`📁 Found ${validMunicipalityDirs.length} municipalities to analyze\n`);

    // Process municipalities with rate limiting
    let completed = 0;
    let skipped = 0;
    let errors = 0;

    for (const municipalityDir of validMunicipalityDirs) {
      try {
        const result = await analyzeStatute(municipalityDir, questions);
        if (result) {
          completed++;
        } else {
          skipped++;
        }
        
        // Rate limiting delay between municipalities
        if (municipalityDir !== validMunicipalityDirs[validMunicipalityDirs.length - 1]) {
          console.log(`⏱️ Waiting ${DELAY_MS/1000} seconds to avoid rate limits...`);
          await delay(DELAY_MS);
        }
        
      } catch (error) {
        console.error(`❌ Error processing ${path.basename(municipalityDir)}:`, error);
        errors++;
      }
    }

    console.log('\n🎉 Property Maintenance Analysis Complete! 🎉');
    console.log(`✅ Completed: ${completed}`);
    console.log(`⏭️ Skipped: ${skipped}`);
    console.log(`❌ Errors: ${errors}`);
    console.log(`📁 Total municipalities processed: ${validMunicipalityDirs.length}`);

  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Run the analysis
analyzeAllPropertyMaintenance().catch(console.error);