#!/usr/bin/env tsx

import fs from 'fs/promises';
import path from 'path';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';

// Initialize clients
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

async function generateLocalPropertyMaintenanceAnalysis() {
  console.log('🔍 Generating vector-based analysis for LOCAL property maintenance ordinances...');
  
  const propertyMaintenanceDir = path.join(process.cwd(), '..', 'data', 'property-maintenance');
  const questionsPath = path.join(propertyMaintenanceDir, 'questions.json');
  
  // Read questions
  const questionsData = JSON.parse(await fs.readFile(questionsPath, 'utf-8'));
  const questions = questionsData.questions;
  
  // Get all municipality directories
  const municipalities = await fs.readdir(propertyMaintenanceDir);
  const municDirs = municipalities.filter(name => name.startsWith('NY-') && name !== 'NY-State');
  
  // Filter to only those with local ordinances (not using state code)
  const localMunicipalities = [];
  for (const municDir of municDirs) {
    const metadataPath = path.join(propertyMaintenanceDir, municDir, 'metadata.json');
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
      const isStateCode = metadata.sourceUrl === 'https://up.codes/viewer/new_york/ny-property-maintenance-code-2020';
      
      if (!isStateCode) {
        localMunicipalities.push(municDir);
      }
    } catch (error) {
      console.log(`⚠️  Skipping ${municDir}: No metadata file`);
    }
  }
  
  console.log(`Found ${localMunicipalities.length} municipalities with local ordinances to process...`);
  
  // Initialize Pinecone
  const indexName = 'ordinizer-statutes';
  const index = pinecone.index(indexName);
  
  for (const municDir of localMunicipalities) {
    console.log(`\n🔍 Processing ${municDir}...`);
    
    const municPath = path.join(propertyMaintenanceDir, municDir);
    const statutePath = path.join(municPath, 'statute.txt');
    const analysisPath = path.join(municPath, 'analysis.json');
    const metadataPath = path.join(municPath, 'metadata.json');
    
    try {
      // Read statute and metadata
      const statute = await fs.readFile(statutePath, 'utf-8');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
      
      // Index statute in vector database
      await indexStatuteInPinecone(statute, municDir, 'property-maintenance', index);
      
      // Process questions using vector search
      const answers = [];
      for (const question of questions) {
        const answer = await answerQuestionWithVector(question.text, municDir, 'property-maintenance', index);
        answers.push({
          id: question.id,
          question: question.text,
          answer: answer.answer,
          confidence: answer.confidence,
          sourceRefs: answer.sourceRefs || []
        });
      }
      
      // Create analysis
      const analysis = {
        municipality: {
          id: municDir,
          displayName: `${metadata.municipalityName} - ${metadata.municipalityType}`
        },
        domain: {
          id: "property-maintenance",
          displayName: "Property Maintenance"
        },
        questions: answers,
        lastUpdated: new Date().toISOString(),
        processingMethod: "vector-search-rag",
        usesStateCode: false
      };
      
      await fs.writeFile(analysisPath, JSON.stringify(analysis, null, 2));
      
      const avgConfidence = answers.reduce((sum, a) => sum + a.confidence, 0) / answers.length;
      console.log(`✅ ${municDir}: Average confidence ${avgConfidence.toFixed(1)}%`);
      
    } catch (error) {
      console.error(`❌ Failed to process ${municDir}:`, error.message);
    }
  }
  
  console.log('\n🎉 Local property maintenance analysis complete!');
}

async function indexStatuteInPinecone(statute: string, municipalityId: string, domain: string, index: any) {
  // Split statute into chunks
  const chunks = chunkText(statute, 1000);
  const vectors = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    try {
      // Generate embedding
      const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunk,
      });
      
      const embedding = response.data[0].embedding;
      
      vectors.push({
        id: `${municipalityId}-${domain}-chunk-${i}`,
        values: embedding,
        metadata: {
          municipalityId,
          domain,
          chunkIndex: i,
          text: chunk.substring(0, 1000) // Store first 1000 chars
        }
      });
    } catch (error) {
      console.error(`Error generating embedding for chunk ${i}:`, error);
    }
  }
  
  // Upsert to Pinecone
  if (vectors.length > 0) {
    await index.upsert(vectors);
  }
}

async function answerQuestionWithVector(question: string, municipalityId: string, domain: string, index: any) {
  try {
    // Generate question embedding
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: question,
    });
    
    const questionEmbedding = response.data[0].embedding;
    
    // Search for relevant chunks
    const searchResults = await index.query({
      vector: questionEmbedding,
      filter: {
        municipalityId,
        domain
      },
      topK: 3,
      includeMetadata: true
    });
    
    if (!searchResults.matches || searchResults.matches.length === 0) {
      return {
        answer: "Not specified in the statute.",
        confidence: 0,
        sourceRefs: []
      };
    }
    
    // Combine relevant chunks
    const relevantTexts = searchResults.matches.map(match => match.metadata?.text || '').join('\n\n');
    
    // Use OpenAI to answer based on relevant text
    const answerResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are analyzing municipal property maintenance statutes. Based ONLY on the provided statute text, answer the user's question. If the information is not in the statute, respond with "Not specified in the statute." Be precise and cite section numbers when available.`
        },
        {
          role: "user", 
          content: `Question: ${question}\n\nRelevant statute text:\n${relevantTexts}`
        }
      ],
      temperature: 0.1
    });
    
    const answer = answerResponse.choices[0].message.content || "Not specified in the statute.";
    
    // Calculate confidence based on search scores
    const avgScore = searchResults.matches.reduce((sum, match) => sum + (match.score || 0), 0) / searchResults.matches.length;
    const confidence = Math.round(avgScore * 100);
    
    return {
      answer,
      confidence: Math.max(0, Math.min(100, confidence)),
      sourceRefs: extractSectionReferences(relevantTexts)
    };
    
  } catch (error) {
    console.error('Error in vector search:', error);
    return {
      answer: "Not specified in the statute.",
      confidence: 0,
      sourceRefs: []
    };
  }
}

function chunkText(text: string, chunkSize: number = 1000): string[] {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.substring(i, i + chunkSize));
  }
  return chunks;
}

function extractSectionReferences(text: string): string[] {
  // Extract section references like §123, Section 45, etc.
  const sectionRegex = /(?:§|Section)\s*(\d+(?:[.-]\d+)*[A-Z]*)/gi;
  const matches = [...text.matchAll(sectionRegex)];
  const sections = matches.map(match => match[0]).slice(0, 3); // Limit to 3 sections
  return [...new Set(sections)]; // Remove duplicates
}

// Run the function
generateLocalPropertyMaintenanceAnalysis().catch(console.error);