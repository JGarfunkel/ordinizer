#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function analyzeMunicipality(municipality: any, questions: any) {
  console.log(`\n🌳 Analyzing ${municipality.name}...`);
  
  const statutePath = `./data/trees/${municipality.id}/statute.txt`;
  const analysisPath = `./data/trees/${municipality.id}/analysis.json`;
  
  // Check if statute exists
  if (!await fs.pathExists(statutePath)) {
    console.log(`⚠️  No statute found for ${municipality.name}, skipping`);
    return null;
  }
  
  // Check if analysis already exists (skip if recent)
  if (await fs.pathExists(analysisPath)) {
    const existingAnalysis = await fs.readJson(analysisPath);
    const analyzedAt = new Date(existingAnalysis.analyzedAt);
    const questionsUpdatedAt = new Date(questions.generatedAt);
    
    if (analyzedAt > questionsUpdatedAt) {
      console.log(`✓ ${municipality.name} already has recent analysis, skipping`);
      return existingAnalysis;
    }
  }
  
  const statute = await fs.readFile(statutePath, 'utf-8');
  
  const analysisPrompt = `You are analyzing tree regulations for ${municipality.name} only.

STATUTE TEXT:
${statute}

Answer these questions based ONLY on ${municipality.name}'s statute. Be concise and practical for residents.

QUESTIONS:
${questions.questions.map((q: any) => `${q.id}. ${q.question}`).join('\n')}

INSTRUCTIONS:
- Focus ONLY on ${municipality.name} regulations
- Do NOT mention other municipalities
- Be concise and practical for residents
- Say "not specified in the statute" if unclear
- Include relevant section numbers when available
- Rate confidence: high (clearly stated), medium (can be inferred), low (unclear/not found)

Also provide alignment suggestions:
- Strengths: What ${municipality.name} does well in tree regulation
- Improvements: Areas where regulations could be clearer or more comprehensive  
- Recommendations: Specific suggestions for better tree management
- Best practices: Notable positive aspects other municipalities could learn from

Format as JSON:
{
  "answers": [
    {
      "questionId": 1,
      "question": "Original question text",
      "answer": "Clear answer for ${municipality.name} only",
      "confidence": "high|medium|low", 
      "relevantSections": ["§185-1"]
    }
  ],
  "alignmentSuggestions": {
    "strengths": ["What ${municipality.name} does well"],
    "improvements": ["What could be clearer"], 
    "recommendations": ["Specific suggestions"],
    "bestPractices": ["Notable positive aspects"]
  }
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a municipal law expert. Analyze only ${municipality.name}'s tree regulations. Be concise and practical. Respond with valid JSON only.`
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

    const analysis = {
      municipality: municipality.name,
      municipalityId: municipality.id,
      domain: "trees",
      analyzedAt: new Date().toISOString(),
      answers: result.answers.map((answer: any) => ({
        ...answer,
        question: questions.questions.find((q: any) => q.id === answer.questionId)?.question || answer.question
      })),
      alignmentSuggestions: result.alignmentSuggestions
    };

    await fs.writeJson(analysisPath, analysis, { spaces: 2 });
    
    console.log(`✅ Completed ${municipality.name}`);
    return analysis;
    
  } catch (error) {
    console.error(`❌ Error analyzing ${municipality.name}:`, error);
    return null;
  }
}

async function analyzeAllTrees() {
  console.log('🌳 Starting analysis of all municipalities for trees domain...');
  
  const municipalitiesData = await fs.readJson('./data/municipalities.json');
  const municipalities = municipalitiesData.municipalities || municipalitiesData;
  const questions = await fs.readJson('./data/trees/questions.json');
  
  console.log(`📊 Processing ${municipalities.length} municipalities`);
  console.log(`❓ Using ${questions.questions.length} questions`);
  
  let completed = 0;
  let skipped = 0;
  let errors = 0;
  
  // Process municipalities in batches to avoid rate limits
  const batchSize = 3;
  for (let i = 0; i < municipalities.length; i += batchSize) {
    const batch = municipalities.slice(i, i + batchSize);
    
    const batchPromises = batch.map(async (municipality: any) => {
      const result = await analyzeMunicipality(municipality, questions);
      if (result === null) {
        errors++;
      } else if (result && new Date(result.analyzedAt) > new Date(questions.generatedAt)) {
        completed++;
      } else {
        skipped++;
      }
      return result;
    });
    
    await Promise.all(batchPromises);
    
    // Rate limiting delay between batches
    if (i + batchSize < municipalities.length) {
      console.log(`⏱️  Waiting 2 seconds before next batch...`);
      await delay(2000);
    }
  }
  
  console.log('\n🎉 Analysis complete!');
  console.log(`✅ Completed: ${completed}`);
  console.log(`⏭️  Skipped: ${skipped}`);
  console.log(`❌ Errors: ${errors}`);
}

// Run the analysis
analyzeAllTrees().catch(console.error);