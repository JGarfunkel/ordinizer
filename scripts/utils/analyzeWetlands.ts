#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface WetlandsAnalysis {
  municipality: {
    id: string;
    name: string;
    displayName: string;
  };
  domain: {
    id: string;
    name: string;
    displayName: string;
  };
  questions: Array<{
    id: string;
    question: string;
    answer: string;
    relevantSections: string[];
    sourceReference: string;
  }>;
  alignmentSuggestions: {
    strengths: string[];
    improvements: string[];
    recommendations: string[];
    bestPractices: string[];
  };
}

async function analyzeWetlandsMunicipality(municipalityId: string): Promise<WetlandsAnalysis | null> {
  const municipalityDir = path.join(process.cwd(), 'data', 'wetlands', municipalityId);
  const statutePath = path.join(municipalityDir, 'statute.txt');
  const metadataPath = path.join(municipalityDir, 'metadata.json');
  const questionsPath = path.join(process.cwd(), 'data', 'wetlands', 'questions.json');

  if (!await fs.pathExists(statutePath) || !await fs.pathExists(metadataPath) || !await fs.pathExists(questionsPath)) {
    console.log(`Missing files for ${municipalityId}`);
    return null;
  }

  try {
    const statuteContent = await fs.readFile(statutePath, 'utf-8');
    const metadata = await fs.readJson(metadataPath);
    const questionsData = await fs.readJson(questionsPath);

    console.log(`Analyzing wetlands regulations for ${municipalityId}...`);

    // Prepare municipality information
    const municipalityName = metadata.municipality;
    const municipalityType = metadata.municipalityType || 'Municipality';
    const displayName = `${municipalityName} ${municipalityType === 'Municipality' ? '' : municipalityType}`.trim();

    const prompt = `
You are a municipal wetlands policy analyst. Analyze the following wetlands regulations for ${displayName}, NY and provide comprehensive answers to each question.

STATUTE TEXT:
${statuteContent}

QUESTIONS:
${questionsData.questions.map((q: any, i: number) => `${i + 1}. ${q.question}`).join('\n')}

For each question, provide:
1. A clear, specific answer based on the statute
2. Relevant section references (if any)
3. Source reference information

After answering all questions, provide alignment suggestions with:
- Strengths of the current wetlands regulations
- Areas for improvement
- Specific recommendations for enhanced wetlands protection
- Best practices the municipality should consider

Respond in this exact JSON format:
{
  "questions": [
    {
      "id": "question_id",
      "question": "question text",
      "answer": "detailed answer based on statute",
      "relevantSections": ["relevant section numbers"],
      "sourceReference": "source reference"
    }
  ],
  "alignmentSuggestions": {
    "strengths": ["strength 1", "strength 2"],
    "improvements": ["improvement 1", "improvement 2"], 
    "recommendations": ["recommendation 1", "recommendation 2"],
    "bestPractices": ["best practice 1", "best practice 2"]
  }
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1
    });

    const analysisResult = JSON.parse(response.choices[0].message.content!);

    // Construct the final analysis object
    const analysis: WetlandsAnalysis = {
      municipality: {
        id: municipalityId,
        name: municipalityName,
        displayName: displayName
      },
      domain: {
        id: "wetlands",
        name: "wetlands", 
        displayName: "Wetlands"
      },
      questions: analysisResult.questions,
      alignmentSuggestions: analysisResult.alignmentSuggestions
    };

    // Save the analysis
    const analysisPath = path.join(municipalityDir, 'analysis.json');
    await fs.writeJson(analysisPath, analysis, { spaces: 2 });
    
    console.log(`✓ Analysis completed for ${municipalityId}`);
    return analysis;

  } catch (error) {
    console.error(`Error analyzing ${municipalityId}:`, error);
    return null;
  }
}

async function analyzeAllWetlandsMunicipalities() {
  const wetlandsDir = path.join(process.cwd(), 'data', 'wetlands');
  const municipalities = await fs.readdir(wetlandsDir);
  
  // Filter to only directories (exclude files like questions.json)
  const municipalityDirs = [];
  for (const item of municipalities) {
    const itemPath = path.join(wetlandsDir, item);
    const stat = await fs.stat(itemPath);
    if (stat.isDirectory()) {
      municipalityDirs.push(item);
    }
  }

  console.log(`Starting wetlands analysis for ${municipalityDirs.length} municipalities...`);

  const analyses: WetlandsAnalysis[] = [];
  
  for (const municipalityId of municipalityDirs) {
    const analysis = await analyzeWetlandsMunicipality(municipalityId);
    if (analysis) {
      analyses.push(analysis);
    }
    
    // Add delay to respect API rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Create summary
  const summary = {
    domain: "wetlands",
    totalMunicipalities: analyses.length,
    analyzedAt: new Date().toISOString(),
    municipalities: analyses.map(a => ({
      id: a.municipality.id,
      name: a.municipality.displayName,
      questionsAnswered: a.questions.length
    }))
  };

  await fs.writeJson(path.join(wetlandsDir, 'analysis-summary.json'), summary, { spaces: 2 });
  
  console.log(`\n✅ Wetlands analysis completed!`);
  console.log(`📊 Total municipalities analyzed: ${analyses.length}`);
  console.log(`📄 Analysis files created in data/wetlands/*/analysis.json`);

  return analyses;
}

async function main() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    
    await analyzeAllWetlandsMunicipalities();
  } catch (error) {
    console.error('Error in wetlands analysis:', error);
    process.exit(1);
  }
}

main();