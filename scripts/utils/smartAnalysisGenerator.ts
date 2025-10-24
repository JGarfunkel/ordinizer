#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Question {
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
  questions: Question[];
}

function calculateAnalysisQuality(analysis: Analysis): number {
  if (!analysis.questions || analysis.questions.length === 0) return 0;
  
  let qualityScore = 0;
  const totalQuestions = analysis.questions.length;
  
  for (const question of analysis.questions) {
    if (question.answer === "Not specified in the statute.") {
      qualityScore += 1;
    } else if (question.answer.length > 50) {
      qualityScore += 10;
    } else if (question.answer.length > 10) {
      qualityScore += 5;
    }
    
    if (question.sourceRefs && question.sourceRefs.length > 0) {
      qualityScore += 3;
    }
    
    if (question.confidence > 80) {
      qualityScore += 2;
    }
  }
  
  return qualityScore / totalQuestions;
}

async function generateSmartAnalysis(municipalityId: string, domain: string) {
  console.log(`🧠 Smart analysis generation for ${municipalityId}...`);
  
  const analysisPath = path.join(process.cwd(), '..', 'data', domain, municipalityId, 'analysis.json');
  
  // Check if current analysis exists and evaluate its quality
  let currentAnalysis: Analysis | null = null;
  let currentQuality = 0;
  
  if (await fs.pathExists(analysisPath)) {
    try {
      currentAnalysis = await fs.readJson(analysisPath);
      currentQuality = calculateAnalysisQuality(currentAnalysis);
      console.log(`  📊 Current analysis quality: ${currentQuality.toFixed(1)}`);
    } catch (error) {
      console.log(`  ⚠️ Could not read current analysis: ${error.message}`);
    }
  }
  
  // Generate new analysis
  const questionsPath = path.join(process.cwd(), '..', 'data', domain, 'questions.json');
  const statutePath = path.join(process.cwd(), '..', 'data', domain, municipalityId, 'statute.txt');
  
  if (!await fs.pathExists(questionsPath) || !await fs.pathExists(statutePath)) {
    console.log(`  ❌ Missing questions or statute file`);
    return;
  }
  
  const questionsData = await fs.readJson(questionsPath);
  const questions = questionsData.questions || questionsData;
  const statuteContent = await fs.readFile(statutePath, 'utf-8');
  
  console.log(`  🤖 Generating new analysis...`);
  const answeredQuestions = [];
  
  for (const question of questions) {
    try {
      const prompt = `Based on the following municipal statute text, please answer this question about property maintenance regulations:

Question: ${question.text}

Statute text:
${statuteContent}

Instructions:
- Provide a clear, concise answer based ONLY on the information in the statute
- If the statute doesn't contain relevant information, respond with "Not specified in the statute."
- Include specific section references if available (like § 93-2 or Section 120-15)
- Write in plain language for residents
- Include specific details like fees, timelines, and procedures when available

Answer:`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 500
      });

      const answer = response.choices[0].message.content?.trim() || "Analysis not available";
      
      // Extract section references
      const sectionRefs = [];
      const sectionMatches = answer.match(/§\s*\d+(?:-\d+)*|Section\s+\d+(?:-\d+)*/gi);
      if (sectionMatches) {
        sectionRefs.push(...sectionMatches.map(s => s.replace(/§\s*/gi, '').replace(/Section\s*/gi, '')));
      }
      
      const confidence = answer.toLowerCase().includes('not specified') ? 20 : 
                        (answer.length > 100 ? 95 : 85);
      
      answeredQuestions.push({
        id: question.id,
        question: question.text,
        answer,
        confidence,
        sourceRefs: sectionRefs
      });
      
      console.log(`    ✓ Question ${question.id}: ${confidence}% confidence`);
    } catch (error) {
      console.error(`    ✗ Question ${question.id}: ${error.message}`);
      answeredQuestions.push({
        id: question.id,
        question: question.text,
        answer: "Not specified in the statute.",
        confidence: 0,
        sourceRefs: []
      });
    }
  }
  
  const newAnalysis: Analysis = {
    municipality: {
      id: municipalityId,
      displayName: municipalityId.replace('NY-', '').replace('-', ' ')
    },
    domain: {
      id: domain,
      displayName: "Property Maintenance"
    },
    questions: answeredQuestions
  };
  
  const newQuality = calculateAnalysisQuality(newAnalysis);
  console.log(`  📊 New analysis quality: ${newQuality.toFixed(1)}`);
  
  // Only save if new analysis is significantly better OR if no current analysis exists
  if (!currentAnalysis || newQuality > currentQuality + 1 || currentQuality < 3) {
    await fs.writeJson(analysisPath, newAnalysis, { spaces: 2 });
    console.log(`  ✅ Saved improved analysis (quality: ${newQuality.toFixed(1)} vs ${currentQuality.toFixed(1)})`);
  } else {
    console.log(`  🔒 Keeping current analysis (better quality: ${currentQuality.toFixed(1)} vs ${newQuality.toFixed(1)})`);
  }
}

// Process specific municipalities that need better analyses
const municipalitiesToProcess = [
  'NY-Bedford-Town',
  'NY-Cortlandt-Town', 
  'NY-Lewisboro-Town',
  'NY-Mamaroneck-Town',
  'NY-Tuckahoe-Village',
  'NY-WhitePlains-City',
  'NY-Yorktown-Town'
];

async function processAll() {
  console.log('🚀 Starting smart analysis generation...');
  
  for (const municipalityId of municipalitiesToProcess) {
    await generateSmartAnalysis(municipalityId, 'property-maintenance');
  }
  
  console.log('🎉 Smart analysis generation complete!');
}

processAll().catch(console.error);