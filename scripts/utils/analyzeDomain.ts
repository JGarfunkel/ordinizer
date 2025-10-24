#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";
import { generateQuestionsForDomain, analyzeStatuteForQuestion } from "../server/services/openai.js";

interface QuestionData {
  id: number;
  text: string;
  category: string;
}

interface AnalysisData {
  questionId: number;
  answer: string;
  sourceReference: string;
  confidence: number;
}

async function getStatuteFiles(domainPath: string): Promise<Array<{path: string, municipality: string, content: string}>> {
  const files: Array<{path: string, municipality: string, content: string}> = [];
  
  if (!await fs.pathExists(domainPath)) {
    throw new Error(`Domain path does not exist: ${domainPath}`);
  }

  const entries = await fs.readdir(domainPath, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('NY-')) {
      const statutePath = path.join(domainPath, entry.name, 'statute.txt');
      
      if (await fs.pathExists(statutePath)) {
        const content = await fs.readFile(statutePath, 'utf-8');
        if (content.trim()) {
          files.push({
            path: statutePath,
            municipality: entry.name,
            content: content
          });
        }
      }
    }
  }
  
  return files;
}

async function generateQuestions(domain: string): Promise<void> {
  console.log(`Generating questions for domain: ${domain}`);
  
  const domainPath = path.join(process.cwd(), 'data', domain);
  const questionsPath = path.join(domainPath, 'questions.json');
  
  // Check if questions already exist
  if (await fs.pathExists(questionsPath)) {
    console.log("Questions file already exists. Delete it to regenerate.");
    return;
  }

  // Get all statute files for this domain
  const statuteFiles = await getStatuteFiles(domainPath);
  
  if (statuteFiles.length === 0) {
    throw new Error(`No statute files found in ${domainPath}`);
  }

  console.log(`Found ${statuteFiles.length} statute files`);

  // Get sample statutes for question generation (max 3 for token limits)
  const sampleStatutes = statuteFiles
    .slice(0, 3)
    .map(f => f.content);

  // Generate questions using AI
  const domainDisplayNames: Record<string, string> = {
    'Trees': 'Trees & Urban Forestry - Tree removal, planting, and maintenance regulations',
    'Zoning': 'Zoning & Land Use - Land use regulations and zoning ordinances', 
    'Parking': 'Parking Regulations - Parking rules and enforcement',
    'Noise': 'Noise Control - Noise ordinances and quiet hours',
    'Building': 'Building Codes - Construction and building regulations',
    'Environmental': 'Environmental Protection - Environmental protection and conservation',
    'Business': 'Business Licensing - Business permits and licensing requirements'
  };

  const description = domainDisplayNames[domain] || `${domain} municipal regulations`;
  const questions = await generateQuestionsForDomain(domain, description, sampleStatutes);

  // Save questions to JSON file
  await fs.writeFile(questionsPath, JSON.stringify(questions, null, 2));
  console.log(`Generated ${questions.length} questions and saved to ${questionsPath}`);
}

async function analyzeStatutes(domain: string): Promise<void> {
  console.log(`Analyzing statutes for domain: ${domain}`);
  
  const domainPath = path.join(process.cwd(), 'data', domain);
  const questionsPath = path.join(domainPath, 'questions.json');
  
  // Load questions
  if (!await fs.pathExists(questionsPath)) {
    throw new Error(`Questions file not found: ${questionsPath}. Run with --generate-questions first.`);
  }

  const questions: QuestionData[] = JSON.parse(await fs.readFile(questionsPath, 'utf-8'));
  console.log(`Loaded ${questions.length} questions`);

  // Get all statute files
  const statuteFiles = await getStatuteFiles(domainPath);
  console.log(`Found ${statuteFiles.length} statute files to analyze`);

  let analyzed = 0;
  
  for (const statuteFile of statuteFiles) {
    const analysisPath = path.join(path.dirname(statuteFile.path), 'analysis.json');
    
    // Check if analysis already exists and is recent
    if (await fs.pathExists(analysisPath)) {
      const [analysisStats, statuteStats] = await Promise.all([
        fs.stat(analysisPath),
        fs.stat(statuteFile.path)
      ]);
      
      // Skip if analysis is newer than statute file
      if (analysisStats.mtime > statuteStats.mtime) {
        console.log(`  ${statuteFile.municipality}: Analysis exists and is current, skipping`);
        continue;
      }
    }

    console.log(`  Analyzing: ${statuteFile.municipality}`);
    const analyses: AnalysisData[] = [];

    for (const question of questions) {
      console.log(`    Question ${question.id}: ${question.text.substring(0, 50)}...`);
      
      try {
        const analysis = await analyzeStatuteForQuestion(
          statuteFile.content,
          question.text,
          statuteFile.municipality,
          domain
        );
        
        analysis.questionId = question.id;
        analyses.push(analysis);
        
        // Small delay between API calls
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`    Failed to analyze question ${question.id}:`, error);
        analyses.push({
          questionId: question.id,
          answer: "Analysis failed - please try again later",
          sourceReference: "",
          confidence: 0
        });
      }
    }

    // Save analysis results
    await fs.writeFile(analysisPath, JSON.stringify(analyses, null, 2));
    analyzed++;
    console.log(`    Saved analysis with ${analyses.length} answers`);
  }
  
  console.log(`Analysis complete! Processed ${analyzed} municipalities`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.error("Usage:");
    console.error("  tsx scripts/analyzeDomain.ts <domain> --generate-questions");
    console.error("  tsx scripts/analyzeDomain.ts <domain> --analyze");
    console.error("  tsx scripts/analyzeDomain.ts <domain> --all");
    console.error("");
    console.error("Available domains: Trees, Zoning, Parking, Noise, Building, Environmental, Business");
    process.exit(1);
  }

  const domain = args[0];
  const mode = args[1];

  if (!mode || (!mode.includes('generate') && !mode.includes('analyze') && !mode.includes('all'))) {
    console.error("Please specify --generate-questions, --analyze, or --all");
    process.exit(1);
  }

  try {
    if (mode.includes('generate') || mode.includes('all')) {
      await generateQuestions(domain);
    }
    
    if (mode.includes('analyze') || mode.includes('all')) {
      await analyzeStatutes(domain);
    }
    
    console.log("All tasks completed successfully!");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
