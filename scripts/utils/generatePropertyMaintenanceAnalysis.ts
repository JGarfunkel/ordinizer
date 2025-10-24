#!/usr/bin/env tsx
import fs from 'fs';
import OpenAI from 'openai';

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

async function generatePropertyMaintenanceAnalysis(municipalityId: string) {
  try {
    console.log(`\n🏠 Generating property maintenance analysis for ${municipalityId}`);

    // Load municipality info
    const municipalitiesData = JSON.parse(fs.readFileSync('data/municipalities.json', 'utf-8'));
    const municipalities = municipalitiesData.municipalities || municipalitiesData;
    const municipality = municipalities.find((m: any) => m.id === municipalityId);
    
    if (!municipality) {
      throw new Error(`Municipality not found: ${municipalityId}`);
    }

    // Load questions for property maintenance domain
    const questionsPath = 'data/property-maintenance/questions.json';
    const questionsData = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));
    const questions: Question[] = questionsData.questions || questionsData;

    // Load statute
    const statutePath = `data/property-maintenance/${municipalityId}/statute.txt`;
    if (!fs.existsSync(statutePath)) {
      throw new Error(`Statute file not found: ${statutePath}`);
    }
    
    const statuteContent = fs.readFileSync(statutePath, 'utf-8');
    console.log(`📋 Processing ${questions.length} questions for statute (${statuteContent.length} chars)`);

    // Generate answers using chunked approach
    const answers: AnalysisAnswer[] = [];
    for (const question of questions) {
      const answer = await generateChunkedAnswer(question, statuteContent, municipality.displayName);
      answers.push(answer);
      console.log(`  ✅ ${question.text.substring(0, 60)}...`);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1500));
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
      processingMethod: "chunked-openai"
    };

    // Save analysis
    const analysisDir = `data/property-maintenance/${municipalityId}`;
    fs.mkdirSync(analysisDir, { recursive: true });
    
    const analysisPath = `${analysisDir}/analysis.json`;
    fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
    
    const avgConfidence = answers.reduce((sum, a) => sum + a.confidence, 0) / answers.length;
    console.log(`✅ Analysis saved to: ${analysisPath}`);
    console.log(`📊 Questions processed: ${answers.length}`);
    console.log(`📊 Average confidence: ${avgConfidence.toFixed(1)}%`);
    
    return analysis;
    
  } catch (error) {
    console.error(`❌ Error generating analysis for ${municipalityId}:`, error);
    throw error;
  }
}

async function generateChunkedAnswer(
  question: Question, 
  statuteContent: string, 
  municipalityName: string
): Promise<AnalysisAnswer> {
  try {
    // Split statute into manageable chunks
    const maxChunkSize = 6000; // Conservative limit
    const chunks = chunkText(statuteContent, maxChunkSize);
    
    let bestAnswer = '';
    let bestConfidence = 0;
    let sourceRefs: string[] = [];
    
    // Search through chunks for relevant information
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
        messages: [
          {
            role: 'system',
            content: `You are analyzing property maintenance regulations for ${municipalityName}. 
            
Analyze the provided text section and determine if it contains information relevant to the question.
If relevant information is found, provide:
1. A clear, concise answer in plain language
2. A confidence score (0-100) based on how directly the text addresses the question
3. Specific references to sections or subsections mentioned

If no relevant information is found, respond with confidence 0.

Respond in JSON format: {"answer": "...", "confidence": number, "hasRelevantInfo": boolean, "sectionRefs": ["..."]}
`
          },
          {
            role: 'user',
            content: `Question: ${question.text}

Text section ${i + 1}/${chunks.length}:
${chunk}

Does this section contain information relevant to the question? If so, what does it say?`
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      
      if (result.hasRelevantInfo && result.confidence > bestConfidence) {
        bestAnswer = result.answer;
        bestConfidence = result.confidence;
        sourceRefs = result.sectionRefs || [];
      }
    }

    // If no relevant info found, provide a default response
    if (bestConfidence === 0) {
      bestAnswer = "No specific information found in the available property maintenance regulations for this question.";
      bestConfidence = 0;
    }

    return {
      id: question.id,
      question: question.text,
      answer: bestAnswer,
      confidence: bestConfidence,
      sourceRefs
    };
    
  } catch (error) {
    console.error(`Error analyzing question: ${question.text}`, error);
    return {
      id: question.id,
      question: question.text,
      answer: "Error occurred during analysis.",
      confidence: 0,
      sourceRefs: []
    };
  }
}

function chunkText(text: string, maxChunkSize: number): string[] {
  const chunks: string[] = [];
  
  // Preferred chunking: split by sentence endings with newlines for better context preservation
  let sections: string[] = [];
  
  // Primary: period followed by double newlines (paragraph boundaries)  
  const doubleNewlineSections = text.split(/\.\n\s*\n/).filter(s => s.trim());
  if (doubleNewlineSections.length > 1) {
    sections = doubleNewlineSections.map((section, index) => {
      return index < doubleNewlineSections.length - 1 && !section.endsWith('.') ? section + '.' : section;
    });
  } else {
    // Secondary: period followed by single newlines
    const singleNewlineSections = text.split(/\.\n/).filter(s => s.trim());
    if (singleNewlineSections.length > 1) {
      sections = singleNewlineSections.map((section, index) => {
        return index < singleNewlineSections.length - 1 && !section.endsWith('.') ? section + '.' : section;
      });
    } else {
      // Fallback: paragraph breaks, then section markers as last resort
      sections = text.split(/\n\s*\n/);
      if (sections.length === 1) {
        sections = text.split(/(?=§\s*\d+|Section\s+\d+|SECTION\s+\d+|Article\s+[IVXLCDM]+)/i);
      }
    }
  }
  
  for (const section of sections) {
    if (section.length <= maxChunkSize) {
      chunks.push(section.trim());
    } else {
      // Split large sections by paragraphs
      const paragraphs = section.split(/\n\s*\n/);
      let currentChunk = '';
      
      for (const paragraph of paragraphs) {
        if (currentChunk.length + paragraph.length > maxChunkSize && currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = paragraph;
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        }
      }
      
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
    }
  }
  
  return chunks.filter(chunk => chunk.length > 400); // Filter out very short chunks
}

// Main execution
async function main() {
  const municipalities = [
    'NY-Ardsley-Village',
    'NY-Bedford-Town',
    'NY-Bronxville-Village', 
    'NY-Elmsford-Village',
    'NY-Larchmont-Village',
    'NY-MountVernon-City',
    'NY-NewCastle-Town',
    'NY-NewRochelle-City',
    'NY-Ossining-Town',
    'NY-SleepyHollow-Village'
  ];

  console.log('🏠 Starting Property Maintenance Analysis Generation...');
  console.log(`Processing ${municipalities.length} municipalities`);

  for (const municipality of municipalities) {
    try {
      await generatePropertyMaintenanceAnalysis(municipality);
    } catch (error) {
      console.error(`Failed to generate analysis for ${municipality}:`, error);
    }
    
    // Brief pause between municipalities
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\n🎉 Property maintenance analysis generation complete!');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { generatePropertyMaintenanceAnalysis };