#!/usr/bin/env tsx
import fs from 'fs';
import OpenAI from 'openai';
import { VectorService } from '../server/services/vectorService.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Question {
  id: string;
  text: string;
  category: string;
}

interface AnalysisAnswer {
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
  questions: AnalysisAnswer[];
  lastUpdated: string;
  processingMethod: string;
  totalSections?: number;
}

async function generateVectorBasedPropertyAnalysis(municipalityId: string) {
  try {
    console.log(`\n🔍 Generating vector-based property maintenance analysis for ${municipalityId}`);

    // Load municipality info
    const municipalitiesData = JSON.parse(fs.readFileSync('../data/municipalities.json', 'utf-8'));
    const municipalities = municipalitiesData.municipalities || municipalitiesData;
    const municipality = municipalities.find((m: any) => m.id === municipalityId);
    
    if (!municipality) {
      throw new Error(`Municipality not found: ${municipalityId}`);
    }

    // Load questions for property maintenance domain
    const questionsPath = '../data/property-maintenance/questions.json';
    const questionsData = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));
    const questions: Question[] = questionsData.questions || questionsData;

    // Initialize vector service
    const vectorService = new VectorService();
    
    // Ensure statute is indexed
    console.log('📋 Ensuring statute is indexed in vector database...');
    const statutePath = `../data/property-maintenance/${municipalityId}/statute.txt`;
    if (!fs.existsSync(statutePath)) {
      throw new Error(`Statute file not found: ${statutePath}`);
    }
    
    const statuteContent = fs.readFileSync(statutePath, 'utf-8');
    await vectorService.indexStatute(municipalityId, 'property-maintenance', statuteContent);

    console.log(`📋 Processing ${questions.length} questions using vector search`);

    // Generate answers using vector-based approach
    const answers: AnalysisAnswer[] = [];
    for (const question of questions) {
      const answer = await generateVectorBasedAnswer(question, municipalityId, municipality.displayName, vectorService);
      answers.push(answer);
      console.log(`  ✅ ${question.text.substring(0, 60)}... (${answer.confidence}% confidence)`);
      
      // Brief rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Create analysis object
    const analysis: Analysis = {
      municipality: {
        id: municipality.id,
        displayName: municipality.displayName
      },
      domain: {
        id: 'property-maintenance',
        displayName: 'Property Maintenance'
      },
      questions: answers,
      lastUpdated: new Date().toISOString(),
      processingMethod: "vector-search-rag"
    };

    // Save analysis
    const analysisDir = `../data/property-maintenance/${municipalityId}`;
    fs.mkdirSync(analysisDir, { recursive: true });
    
    const analysisPath = `${analysisDir}/analysis.json`;
    fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
    
    const avgConfidence = answers.reduce((sum, a) => sum + a.confidence, 0) / answers.length;
    console.log(`✅ Vector-based analysis saved to: ${analysisPath}`);
    console.log(`📊 Questions processed: ${answers.length}`);
    console.log(`📊 Average confidence: ${avgConfidence.toFixed(1)}%`);
    
    return analysis;
    
  } catch (error) {
    console.error(`❌ Error generating vector-based analysis for ${municipalityId}:`, error);
    throw error;
  }
}

async function generateVectorBasedAnswer(
  question: Question, 
  municipalityId: string,
  municipalityName: string,
  vectorService: VectorService
): Promise<AnalysisAnswer> {
  try {
    // Search for relevant statute sections using vector similarity
    const relevantSections = await vectorService.searchRelevantSections(
      municipalityId, 
      'property-maintenance', 
      question.text, 
      5 // Get top 5 most relevant sections
    );
    
    if (relevantSections.length === 0) {
      return {
        id: question.id,
        question: question.text,
        answer: "Not specified in the statute.",
        confidence: 0,
        sourceRefs: []
      };
    }
    
    // Combine relevant sections into context
    const context = relevantSections.map((section, index) => {
      const sectionRef = section.metadata?.section ? ` - §${section.metadata.section}` : '';
      return `[Section ${index + 1}${sectionRef}]\n${section.content}`;
    }).join('\n\n');
    
    // Generate answer using OpenAI with the relevant context
    const response = await openai.chat.completions.create({
      model: 'gpt-4o', // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      messages: [
        {
          role: 'system',
          content: `You are analyzing property maintenance regulations for ${municipalityName}. 
          
Based on the relevant statute sections provided, answer the user's question clearly and concisely.

Guidelines:
- Use plain, everyday language that residents can easily understand
- Be specific about requirements, procedures, penalties, and timelines when mentioned
- If the statute sections don't contain enough information to fully answer the question, respond with "Not specified in the statute."
- Provide a confidence score (0-100) based on how well the statute sections address the question
- Reference specific section numbers when available

Respond in JSON format: {
  "answer": "Clear, concise answer in plain language",
  "confidence": number (0-100),
  "sectionRefs": ["list", "of", "referenced", "sections"]
}
`
        },
        {
          role: 'user',
          content: `Question: ${question.text}

Relevant statute sections:
${context}

Please provide a clear answer based on these statute sections.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    
    return {
      id: question.id,
      question: question.text,
      answer: result.answer || "Not specified in the statute.",
      confidence: result.confidence || 0,
      sourceRefs: result.sectionRefs || []
    };
    
  } catch (error) {
    console.error(`Error analyzing question: ${question.text}`, error);
    return {
      id: question.id,
      question: question.text,
      answer: "Not specified in the statute.",
      confidence: 0,
      sourceRefs: []
    };
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const municipalityArg = args.find(arg => arg.startsWith('-m'));
  
  let municipalities = [
    'NY-NewCastle-Town',
    'NY-Ardsley-Village',
    'NY-Bedford-Town',
    'NY-Bronxville-Village', 
    'NY-Elmsford-Village',
    'NY-Larchmont-Village',
    'NY-MountVernon-City',
    'NY-NewRochelle-City',
    'NY-Ossining-Town',
    'NY-SleepyHollow-Village'
  ];

  // If specific municipality is specified, only process that one
  if (municipalityArg) {
    const municipalityId = args[args.indexOf(municipalityArg) + 1];
    if (municipalityId) {
      municipalities = [municipalityId];
    }
  }

  console.log('🔍 Starting Vector-Based Property Maintenance Analysis Generation...');
  console.log(`Processing ${municipalities.length} municipalities with Pinecone vector search`);

  for (const municipality of municipalities) {
    try {
      await generateVectorBasedPropertyAnalysis(municipality);
    } catch (error) {
      console.error(`Failed to generate vector-based analysis for ${municipality}:`, error);
    }
    
    // Pause between municipalities to avoid overwhelming the APIs
    if (municipalities.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  
  console.log('\n🎉 Vector-based property maintenance analysis generation complete!');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { generateVectorBasedPropertyAnalysis };