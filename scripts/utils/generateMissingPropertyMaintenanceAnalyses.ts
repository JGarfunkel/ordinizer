#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';

const missingMunicipalities = [
  'NY-Ardsley-Village',
  'NY-Bedford-Town', 
  'NY-Bronxville-Village',
  'NY-Croton-on-Hudson-Village',
  'NY-Irvington-Village',
  'NY-NewCastle-Town'
];

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateAnalysisForMunicipality(municipalityId: string, domain: string) {
  const questionsPath = path.join(process.cwd(), '..', 'data', domain, 'questions.json');
  const statutePath = path.join(process.cwd(), '..', 'data', domain, municipalityId, 'statute.txt');
  const analysisPath = path.join(process.cwd(), '..', 'data', domain, municipalityId, 'analysis.json');
  
  const questionsData = await fs.readJson(questionsPath);
  const questions = questionsData.questions || questionsData; // Handle different formats
  const statuteContent = await fs.readFile(statutePath, 'utf-8');
  
  const answeredQuestions = [];
  
  for (const question of questions) {
    try {
      const prompt = `Based on the following municipal statute text, please answer this question about property maintenance regulations:

Question: ${question.question}

Statute text:
${statuteContent}

Instructions:
- Provide a clear, concise answer based ONLY on the information in the statute
- If the statute doesn't contain relevant information, respond with "Not specified in the statute."
- Include specific section references if available
- Write in plain language for residents

Answer:`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 500
      });

      const answer = response.choices[0].message.content?.trim() || "Analysis not available";
      
      // Extract section references from the answer
      const sectionRefs = [];
      const sectionMatches = answer.match(/§\s*\d+(?:-\d+)*/g);
      if (sectionMatches) {
        sectionRefs.push(...sectionMatches.map(s => s.replace(/§\s*/, '')));
      }
      
      // Calculate confidence based on answer specificity
      const confidence = answer.toLowerCase().includes('not specified') ? 20 : 90;
      
      answeredQuestions.push({
        id: question.id,
        question: question.question,
        answer,
        confidence,
        sourceRefs: sectionRefs
      });
      
      console.log(`  ✓ Question ${question.id}: ${confidence}% confidence`);
    } catch (error) {
      console.error(`  ✗ Question ${question.id}: ${error.message}`);
      answeredQuestions.push({
        id: question.id,
        question: question.question,
        answer: "Not specified in the statute.",
        confidence: 0,
        sourceRefs: []
      });
    }
  }
  
  const analysisData = {
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
  
  await fs.writeJson(analysisPath, analysisData, { spaces: 2 });
  return analysisData;
}

async function generateMissingAnalyses() {
  console.log('🔄 Generating missing Property Maintenance analyses...');
  
  const domain = 'property-maintenance';
  const questionsPath = path.join(process.cwd(), '..', 'data', domain, 'questions.json');
  
  if (!await fs.pathExists(questionsPath)) {
    console.error('❌ Questions file not found for Property Maintenance');
    return;
  }

  const questionsData = await fs.readJson(questionsPath);
  const questions = questionsData.questions || questionsData; // Handle different formats
  console.log(`📝 Found ${questions.length} questions for Property Maintenance`);
  
  for (const municipalityId of missingMunicipalities) {
    console.log(`\n🔍 Processing ${municipalityId}...`);
    
    const statutePath = path.join(process.cwd(), '..', 'data', domain, municipalityId, 'statute.txt');
    const analysisPath = path.join(process.cwd(), '..', 'data', domain, municipalityId, 'analysis.json');
    
    if (!await fs.pathExists(statutePath)) {
      console.log(`⚠️  ${municipalityId}: No statute file found, skipping`);
      continue;
    }
    
    if (await fs.pathExists(analysisPath)) {
      console.log(`✅ ${municipalityId}: Analysis already exists, skipping`);
      continue;
    }

    try {
      console.log(`🤖 Generating analysis for ${municipalityId}...`);
      await generateAnalysisForMunicipality(municipalityId, domain);
      console.log(`✅ ${municipalityId}: Analysis generated successfully`);
    } catch (error) {
      console.error(`❌ ${municipalityId}: Failed to generate analysis:`, error.message);
    }
  }
  
  console.log('\n🎉 Missing analysis generation complete!');
}

generateMissingAnalyses().catch(console.error);