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

async function createSimplifiedAnalysis(municipalityDir: string, questions: Question[]): Promise<void> {
  const statuteFile = path.join(municipalityDir, 'statute.txt');
  const metadataFile = path.join(municipalityDir, 'metadata.json');
  const analysisFile = path.join(municipalityDir, 'analysis.json');

  if (!await fs.pathExists(statuteFile) || !await fs.pathExists(metadataFile)) {
    console.log(`⚠️ Missing files in ${path.basename(municipalityDir)}, skipping...`);
    return;
  }

  const metadata = await fs.readJson(metadataFile);
  const municipality = `${metadata.municipalityName} - ${metadata.municipalityType}`;

  console.log(`🔍 Creating simplified analysis for ${municipality}...`);

  // Read and significantly truncate statute (first 8000 chars only)
  const fullStatute = await fs.readFile(statuteFile, 'utf-8');
  const truncatedStatute = fullStatute.substring(0, 8000);

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

  // Create a much shorter prompt for bulk question answering
  const analysisPrompt = `Analyze ${municipality} property maintenance regulations. Answer these questions concisely based on the statute excerpt below. If not clearly stated, say "not specified".

STATUTE EXCERPT (first 8000 characters):
${truncatedStatute}

QUESTIONS:
${questions.map(q => `${q.id}. ${q.text}`).join('\n')}

Respond with JSON only:
{
  "answers": [
    {
      "questionId": 1,
      "question": "question text",
      "answer": "brief answer",
      "confidence": "high|medium|low",
      "relevantSections": ["section references if found"]
    }
  ]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      messages: [{ role: "user", content: analysisPrompt }],
      response_format: { type: "json_object" },
      max_tokens: 4000,
      temperature: 0.3
    });

    const aiAnalysis = JSON.parse(response.choices[0].message.content || '{}');

    const analysis = {
      municipality,
      domain: 'Property Maintenance',
      grade: existingGrade,
      gradeColor: existingGradeColor,
      lastUpdated: new Date().toISOString(),
      answers: aiAnalysis.answers || [],
      alignmentSuggestions: {
        strengths: [`Based on ${municipality} regulations`],
        improvements: ['Analysis based on partial statute excerpt'],
        recommendations: ['Full statute review recommended'],
        bestPractices: ['Property maintenance standards implemented']
      }
    };

    await fs.writeJson(analysisFile, analysis, { spaces: 2 });
    console.log(`✅ Analysis complete for ${municipality}`);

  } catch (error) {
    console.error(`❌ Failed to analyze ${municipality}:`, error.message);
  }
}

async function main(): Promise<void> {
  console.log('\n🏠 Property Maintenance Analysis (Simplified) 🏠\n');
  
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

    console.log(`📁 Found ${validDirs.length} municipalities to analyze\n`);

    let completed = 0;

    for (const municipalityDir of validDirs) {
      try {
        await createSimplifiedAnalysis(municipalityDir, questions);
        completed++;
        
        // Rate limiting delay
        if (municipalityDir !== validDirs[validDirs.length - 1]) {
          console.log(`⏱️ Waiting 3 seconds...`);
          await delay(3000);
        }
        
      } catch (error) {
        console.error(`❌ Error processing ${path.basename(municipalityDir)}:`, error);
      }
    }

    console.log(`\n🎉 Simplified Analysis Complete! 🎉`);
    console.log(`✅ Completed: ${completed} municipalities`);

  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);