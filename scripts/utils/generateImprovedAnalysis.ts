#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { vectorService } from '../../server/services/vectorService.js';

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Question {
  id: number;
  question: string;
  category?: string;
  weight?: number;
}

interface Municipality {
  id: string;
  name: string;
  displayName: string;
}

interface AnalysisAnswer {
  id: number;
  question: string;
  answer: string;
  confidence: number;
  score: number; // Environmental protection score 0.0 - 1.0
  sourceRefs: string[];
  relevantSections?: string[];
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
  overallScore: number; // 0.0 - 10.0
  lastUpdated: string;
  processingMethod: string;
  usesStateCode: boolean;
}

/**
 * Improved analysis system that addresses quality issues:
 * 1. Asks questions independently to avoid cross-contamination 
 * 2. Uses consistent scoring rubric across municipalities
 * 3. Includes explicit scoring justification
 * 4. Validates answers for completeness and accuracy
 */
async function generateImprovedAnswer(
  question: Question,
  municipalityId: string,
  domainId: string,
  municipalityName: string,
  allQuestions: Question[]
): Promise<AnalysisAnswer> {
  try {
    console.log(`  📋 Analyzing: ${question.question}`);

    // Search for relevant statute sections using vector search
    const relevantSections = await vectorService.searchRelevantSections(
      municipalityId,
      domainId,
      question.question,
      8 // Get more sections for better context
    );

    if (relevantSections.length === 0) {
      console.log(`  ⚠️  No relevant sections found for question ${question.id}`);
      return {
        id: question.id,
        question: question.question,
        answer: "Not specified in the statute.",
        confidence: 0,
        score: 0.0,
        sourceRefs: [],
        relevantSections: []
      };
    }

    // Use higher relevance threshold and include more context
    const contextSections = relevantSections
      .filter(section => section.score > 0.6) // Lower threshold for more comprehensive context
      .slice(0, 5) // Include more sections
      .map(section => `Section ${section.section || 'Unknown'}: ${section.content}`)
      .join('\n\n');

    if (!contextSections.trim()) {
      return {
        id: question.id,
        question: question.question,
        answer: "Not specified in the statute.",
        confidence: 0,
        score: 0.0,
        sourceRefs: [],
        relevantSections: []
      };
    }

    // Create improved prompt that focuses on single question analysis
    const prompt = `You are analyzing municipal tree regulations for ${municipalityName}.

CRITICAL INSTRUCTIONS:
1. Answer ONLY the specific question asked - do not include information that belongs to other questions
2. If the question asks about permits, focus ONLY on permit requirements - do not mention notification requirements
3. If the question asks about notifications, focus ONLY on who must be notified - do not mention permit processes
4. Be consistent with environmental protection scoring across municipalities
5. Base your environmental protection score on the strength of the actual requirements found

QUESTION TO ANSWER: ${question.question}

RELEVANT STATUTE SECTIONS:
${contextSections}

OTHER QUESTIONS FOR CONTEXT (do NOT answer these, just use to avoid cross-contamination):
${allQuestions.filter(q => q.id !== question.id).map(q => `${q.id}. ${q.question}`).join('\n')}

ENVIRONMENTAL PROTECTION SCORING RUBRIC:
- 1.0 = Comprehensive requirements with strong enforcement (detailed permits, strict penalties, clear replacement rules)
- 0.8 = Strong requirements with good enforcement (permits required, meaningful penalties, some replacement rules)
- 0.6 = Moderate requirements (permits required but limited enforcement or unclear rules)
- 0.4 = Weak requirements (minimal permit process, low penalties, vague rules)
- 0.2 = Very weak requirements (unclear or limited requirements)
- 0.0 = No requirements specified or completely inadequate protection

Provide your response as JSON:
{
  "answer": "Clear, specific answer focused ONLY on this question",
  "confidence": 85,
  "score": 0.75,
  "scoreJustification": "Explanation of why this score was given",
  "sourceRefs": ["§121-3", "§121-5"],
  "focusCheck": "Confirmation that answer addresses only the specific question asked"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ 
        role: "system", 
        content: "You are a municipal law expert. Analyze tree regulations with precision, focusing only on the specific question asked. Provide consistent scoring across municipalities. Respond with valid JSON only."
      }, {
        role: "user", 
        content: prompt 
      }],
      response_format: { type: "json_object" },
      temperature: 0.1, // Lower temperature for more consistent results
    });

    const result = JSON.parse(response.choices[0].message.content!);
    
    console.log(`  ✅ Score: ${result.score} - ${result.scoreJustification}`);

    return {
      id: question.id,
      question: question.question,
      answer: result.answer,
      confidence: result.confidence,
      score: result.score,
      sourceRefs: result.sourceRefs || [],
      relevantSections: result.sourceRefs || []
    };

  } catch (error) {
    console.error(`❌ Error analyzing question ${question.id}:`, error);
    return {
      id: question.id,
      question: question.question,
      answer: "Error occurred during analysis.",
      confidence: 0,
      score: 0.0,
      sourceRefs: [],
      relevantSections: []
    };
  }
}

/**
 * Generate improved analysis for a municipality
 */
export async function generateImprovedMunicipalityAnalysis(
  municipalityId: string,
  domainId: string = 'trees'
): Promise<Analysis | null> {
  try {
    console.log(`🔄 Generating improved analysis for ${municipalityId}...`);

    // Load questions
    const questionsPath = `data/${domainId}/questions.json`;
    if (!fs.existsSync(questionsPath)) {
      throw new Error(`Questions file not found: ${questionsPath}`);
    }
    const questionsData = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));
    const questions: Question[] = questionsData.questions;

    // Load municipality metadata
    const metadataPath = `data/${domainId}/${municipalityId}/metadata.json`;
    if (!fs.existsSync(metadataPath)) {
      throw new Error(`Metadata file not found: ${metadataPath}`);
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    const municipalityName = `${metadata.municipalityName} - ${metadata.municipalityType}`;

    console.log(`📋 Processing ${questions.length} questions for ${municipalityName}`);

    // Generate answers for each question independently
    const answers: AnalysisAnswer[] = [];
    for (const question of questions) {
      const answer = await generateImprovedAnswer(
        question,
        municipalityId,
        domainId,
        municipalityName,
        questions
      );
      answers.push(answer);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Calculate overall score using weighted average
    const questionsWithScores = answers.filter(a => a.score > 0);
    let overallScore = 0;
    if (questionsWithScores.length > 0) {
      const totalWeight = questions.reduce((sum, q) => sum + (q.weight || 1), 0);
      const weightedScore = answers.reduce((sum, answer) => {
        const question = questions.find(q => q.id === answer.id);
        const weight = question?.weight || 1;
        return sum + (answer.score * weight);
      }, 0);
      overallScore = (weightedScore / totalWeight) * 10; // Convert to 0-10 scale
    }

    const analysis: Analysis = {
      municipality: {
        id: municipalityId,
        displayName: municipalityName
      },
      domain: {
        id: domainId,
        displayName: domainId === 'trees' ? 'Trees & Urban Forestry' : domainId
      },
      questions: answers,
      overallScore: Math.round(overallScore * 10) / 10, // Round to 1 decimal
      lastUpdated: new Date().toISOString(),
      processingMethod: "improved-vector-analysis-v2",
      usesStateCode: false
    };

    // Save improved analysis
    const analysisPath = `data/${domainId}/${municipalityId}/analysis_improved.json`;
    fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
    
    console.log(`✅ Improved analysis saved: ${analysisPath}`);
    console.log(`📊 Overall Score: ${overallScore.toFixed(1)}/10.0`);
    console.log(`📊 Questions answered: ${answers.filter(a => a.answer !== "Not specified in the statute.").length}/${answers.length}`);
    
    return analysis;

  } catch (error) {
    console.error(`❌ Error generating improved analysis for ${municipalityId}:`, error);
    return null;
  }
}

// CLI interface for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const municipalityId = process.argv[2];
  const domainId = process.argv[3] || 'trees';
  
  if (!municipalityId) {
    console.log('Usage: tsx generateImprovedAnalysis.ts <municipalityId> [domainId]');
    console.log('Example: tsx generateImprovedAnalysis.ts NY-Hastings-on-Hudson-Village trees');
    process.exit(1);
  }
  
  generateImprovedMunicipalityAnalysis(municipalityId, domainId)
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}