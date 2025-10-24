#!/usr/bin/env tsx

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface QuestionAnswer {
  id: number;
  question: string;
  answer: string;
  score: number;
  confidence: number;
  gap?: string;
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
  questions: QuestionAnswer[];
}

/**
 * Generates gap analysis explaining what municipality needs to do to reach 1.0 score
 */
async function generateGapForQuestion(question: string, answer: string, score: number): Promise<string> {
  if (score >= 1.0) {
    return "No gap - municipality already meets best practice standards";
  }

  const prompt = `You are analyzing municipal statute effectiveness. Based on the question and current answer, explain what specific improvements the municipality needs to make to achieve a perfect 1.0 score.

Question: "${question}"
Current Answer: "${answer}"
Current Score: ${score}/1.0

Provide a concise gap analysis (1-2 sentences) explaining exactly what the municipality needs to add or improve in their statute to reach 1.0. Focus on specific requirements, thresholds, procedures, or enforcement mechanisms that are missing or inadequate.

IMPORTANT: Start your response with "Consider adding..." to provide constructive recommendations for statute improvements.

Examples of good gap analysis:
- "Consider adding specific tree size thresholds (e.g., 6+ inches DBH) and written permit requirements for all removals above that threshold"
- "Consider adding specific fine amounts ($500-$2000) and mandatory replacement requirements (2:1 ratio) for violations"
- "Consider adding tree canopy coverage goals (minimum 25%) with measurement methods and implementation timelines"

Gap analysis:`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
      temperature: 0.1,
    });

    return response.choices[0]?.message?.content?.trim() || "Unable to identify specific improvements needed";
  } catch (error) {
    console.error('Error generating gap analysis:', error);
    return "Gap analysis generation failed - review scoring logic";
  }
}

/**
 * Process all analysis files in a domain to add gap analysis
 */
async function processAnalysisFiles(domainId: string, verbose: boolean = false) {
  const domainDir = `data/${domainId}`;
  
  if (!fs.existsSync(domainDir)) {
    console.error(`❌ Domain directory not found: ${domainDir}`);
    return;
  }

  const municipalityDirs = fs.readdirSync(domainDir)
    .filter(item => {
      const fullPath = path.join(domainDir, item);
      return fs.statSync(fullPath).isDirectory() && item.startsWith('NY-');
    });

  console.log(`🔍 Processing ${municipalityDirs.length} municipalities in ${domainId} domain...`);

  for (const municipalityDir of municipalityDirs) {
    const analysisPath = path.join(domainDir, municipalityDir, 'analysis.json');
    
    if (!fs.existsSync(analysisPath)) {
      if (verbose) console.log(`⏭️  Skipping ${municipalityDir} - no analysis.json`);
      continue;
    }

    try {
      const analysisData: Analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
      let hasChanges = false;

      console.log(`📊 Processing ${analysisData.municipality.displayName}...`);

      for (const question of analysisData.questions) {
        // Only generate gap analysis if score < 1.0 and gap doesn't exist
        if (question.score < 1.0 && !question.gap) {
          if (verbose) {
            console.log(`  🔧 Generating gap for Q${question.id} (score: ${question.score})`);
          }
          
          question.gap = await generateGapForQuestion(
            question.question,
            question.answer,
            question.score
          );
          hasChanges = true;
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        } else if (question.score >= 1.0 && !question.gap) {
          question.gap = "No gap - municipality already meets best practice standards";
          hasChanges = true;
        }
      }

      if (hasChanges) {
        fs.writeFileSync(analysisPath, JSON.stringify(analysisData, null, 2));
        console.log(`✅ Updated gap analysis for ${analysisData.municipality.displayName}`);
      } else {
        console.log(`⏭️  No gap updates needed for ${analysisData.municipality.displayName}`);
      }

    } catch (error) {
      console.error(`❌ Failed to process ${municipalityDir}:`, error);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const domainId = args[0];
  const verbose = args.includes('--verbose') || args.includes('-v');

  if (!domainId) {
    console.error('Usage: tsx generateGapAnalysis.ts <domainId> [--verbose]');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY environment variable not set');
    process.exit(1);
  }

  console.log(`🚀 Generating gap analysis for ${domainId} domain...`);
  await processAnalysisFiles(domainId, verbose);
  console.log(`🎉 Gap analysis generation complete!`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { generateGapForQuestion, processAnalysisFiles };