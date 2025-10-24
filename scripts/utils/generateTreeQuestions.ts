#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface TreeStatute {
  municipality: string;
  content: string;
  filePath: string;
}

async function loadTreeStatutes(): Promise<TreeStatute[]> {
  const treesDir = path.join(process.cwd(), 'data', 'trees');
  if (!(await fs.pathExists(treesDir))) {
    throw new Error('Trees directory not found');
  }
  
  const statutes: TreeStatute[] = [];
  const municipalities = await fs.readdir(treesDir);
  
  for (const municipality of municipalities) {
    const municipalityPath = path.join(treesDir, municipality);
    const stat = await fs.stat(municipalityPath);
    
    if (!stat.isDirectory()) continue;
    
    const statutePath = path.join(municipalityPath, 'statute.txt');
    if (await fs.pathExists(statutePath)) {
      const content = await fs.readFile(statutePath, 'utf-8');
      statutes.push({
        municipality: municipality.replace('NY-', '').replace('-Town', ' Town').replace('-Village', ' Village').replace('-City', ' City'),
        content: content.slice(0, 8000), // Limit content length for API
        filePath: statutePath
      });
    }
  }
  
  console.log(`📊 Loaded ${statutes.length} tree statutes for analysis`);
  return statutes;
}

async function generateQuestionsFromStatutes(statutes: TreeStatute[]): Promise<string[]> {
  const municipalityList = statutes.map(s => s.municipality).join(', ');
  
  console.log('🤖 Analyzing statutes with OpenAI to generate questions...');
  
  const analysisPrompt = `You are analyzing tree preservation laws from ${statutes.length} different municipalities in Westchester County, NY: ${municipalityList}.

Please analyze these municipal tree codes and generate 10-15 practical questions that would help residents understand the key differences between jurisdictions. Focus on real-world scenarios that homeowners and property owners would encounter.

The questions should be:
- Written in plain, everyday language (not legal jargon)
- Focused on practical differences that matter to residents
- Specific enough to distinguish between municipalities
- Covering various aspects like permits, fees, tree sizes, penalties, etc.

FORMAT: Return a JSON object with a "questions" array containing the questions as strings.

Here are the statute excerpts:

${statutes.map((statute, i) => `
=== ${statute.municipality} ===
${statute.content.slice(0, 2000)}
`).join('\n')}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      messages: [
        {
          role: "system", 
          content: "You are an expert in municipal law analysis, specializing in creating practical questions that help residents understand local regulations."
        },
        {
          role: "user", 
          content: analysisPrompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
      max_tokens: 2000
    });

    const result = JSON.parse(response.choices[0].message.content || '{"questions": []}');
    return result.questions || [];
  } catch (error) {
    console.error('❌ OpenAI API error:', error);
    throw new Error(`Failed to generate questions: ${error.message}`);
  }
}

async function saveQuestionsToFile(questions: string[]): Promise<void> {
  const questionsData = {
    domain: "trees",
    generatedAt: new Date().toISOString(),
    questionsCount: questions.length,
    questions: questions.map((q, i) => ({
      id: i + 1,
      question: q
    }))
  };
  
  const questionsPath = path.join(process.cwd(), 'data', 'trees', 'questions.json');
  await fs.writeJson(questionsPath, questionsData, { spaces: 2 });
  
  console.log(`✅ Generated questions saved to: ${questionsPath}`);
}

async function main(): Promise<void> {
  try {
    console.log('🌳 Starting tree statute question generation...\n');
    
    // Load all tree statutes
    const statutes = await loadTreeStatutes();
    
    if (statutes.length === 0) {
      throw new Error('No tree statutes found to analyze');
    }
    
    // Generate questions using OpenAI
    const questions = await generateQuestionsFromStatutes(statutes);
    
    if (questions.length === 0) {
      throw new Error('No questions were generated');
    }
    
    console.log(`\n📝 Generated ${questions.length} questions:`);
    questions.forEach((q, i) => {
      console.log(`${i + 1}. ${q}`);
    });
    
    // Save questions to file
    await saveQuestionsToFile(questions);
    
    console.log('\n🎉 Tree questions generation complete!');
    console.log(`- Analyzed ${statutes.length} municipalities`);
    console.log(`- Generated ${questions.length} practical questions`);
    console.log(`- Questions saved to data/trees/questions.json`);
    
  } catch (error) {
    console.error('❌ Question generation failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { generateQuestionsFromStatutes, loadTreeStatutes };