#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function processRemainingMunicipalities(): Promise<void> {
  const treesDir = path.join(process.cwd(), 'data', 'trees');
  const questionsPath = path.join(treesDir, 'questions.json');
  const questionsData = await fs.readJson(questionsPath);
  const questions = questionsData.questions;
  
  const municipalities = await fs.readdir(treesDir);
  let processedCount = 0;
  
  // Process only municipalities that don't have analysis yet
  for (const municipalityId of municipalities) {
    const municipalityPath = path.join(treesDir, municipalityId);
    const stat = await fs.stat(municipalityPath);
    
    if (!stat.isDirectory() || municipalityId.endsWith('.json')) continue;
    
    const analysisPath = path.join(municipalityPath, 'analysis.json');
    if (await fs.pathExists(analysisPath)) {
      console.log(`⏭️  ${municipalityId} already analyzed, skipping`);
      continue;
    }
    
    const statutePath = path.join(municipalityPath, 'statute.txt');
    if (!(await fs.pathExists(statutePath))) continue;
    
    const municipalityName = municipalityId
      .replace('NY-', '')
      .replace('-Town', ' Town')
      .replace('-Village', ' Village') 
      .replace('-City', ' City')
      .replace('-TownVillage', ' Town/Village');
    
    try {
      console.log(`🔍 Analyzing ${municipalityName}...`);
      
      const fullContent = await fs.readFile(statutePath, 'utf-8');
      const statuteContent = fullContent.slice(0, 4000); // Smaller chunk
      
      const analysisPrompt = `Analyze this ${municipalityName} tree statute and provide answers to these questions with suggestions for alignment.

STATUTE: ${statuteContent}

QUESTIONS: ${questions.slice(0, 8).map(q => `${q.id}. ${q.question}`).join('\n')}

Respond in JSON format:
{
  "answers": [{"questionId": number, "question": "string", "answer": "practical answer", "confidence": "high|medium|low", "relevantSections": ["sections"]}],
  "suggestions": {
    "alignmentGaps": ["gaps compared to other municipalities"],
    "bestPracticesFromOthers": ["practices to adopt"],
    "potentialImprovements": ["areas for improvement"],
    "modernizationOpportunities": ["modernization suggestions"]
  },
  "overallAssessment": {
    "comprehensiveness": "comprehensive|moderate|limited",
    "clarity": "clear|moderate|unclear",
    "modernization": "modern|dated|outdated"
  }
}`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are a municipal law analyst providing practical statute analysis and improvement suggestions."
          },
          {
            role: "user",
            content: analysisPrompt
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 2000
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      
      const analysis = {
        municipality: municipalityName,
        municipalityId: municipalityId,
        domain: "trees",
        analyzedAt: new Date().toISOString(),
        answers: result.answers || [],
        suggestions: result.suggestions || {},
        overallAssessment: result.overallAssessment || {}
      };
      
      await fs.writeJson(analysisPath, analysis, { spaces: 2 });
      processedCount++;
      
      console.log(`✅ ${municipalityName} analysis saved`);
      
      // Longer delay for rate limits
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Stop after 5 to avoid hitting limits
      if (processedCount >= 5) {
        console.log(`\n⏸️  Processed ${processedCount} municipalities. Run again to continue.`);
        break;
      }
      
    } catch (error) {
      console.error(`❌ Failed to analyze ${municipalityName}:`, error.message);
      if (error.message.includes('rate_limit')) {
        console.log('Hit rate limit, stopping for now');
        break;
      }
      continue;
    }
  }
  
  console.log(`\n📊 Batch complete: ${processedCount} new analyses created`);
}

async function main(): Promise<void> {
  try {
    await processRemainingMunicipalities();
  } catch (error) {
    console.error('❌ Analysis failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}