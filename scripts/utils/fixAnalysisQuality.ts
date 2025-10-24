#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Question {
  id: number;
  question: string;
  weight?: number;
}

interface AnalysisAnswer {
  id: number;
  question: string;
  answer: string;
  confidence: number;
  score: number;
  gap?: string; // What would be needed to achieve a 1.0 score
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
  overallScore: number;
  lastUpdated: string;
  processingMethod: string;
  usesStateCode: boolean;
}

/**
 * Improved analysis method that reads statute text directly and generates
 * focused, consistent answers to address quality issues:
 * 1. Cross-contamination between questions
 * 2. Inconsistent scoring across municipalities  
 * 3. Missing information that exists in statutes
 */
async function generateHighQualityAnswer(
  question: Question,
  statuteText: string,
  municipalityName: string,
  allQuestions: Question[]
): Promise<AnalysisAnswer> {
  try {
    console.log(`  📋 Analyzing: ${question.question}`);

    // Create focused prompt that addresses specific quality issues
    const prompt = `You are analyzing tree regulations for ${municipalityName}. 

CRITICAL QUALITY REQUIREMENTS:
1. Answer ONLY the specific question asked - do not include information that belongs to other questions
2. Search the ENTIRE statute text thoroughly - information may appear in multiple sections
3. Use consistent environmental protection scoring across all municipalities
4. If you find relevant information, provide a complete answer - don't say "not specified" when information exists

SPECIFIC QUESTION TO ANSWER: ${question.question}

OTHER QUESTIONS (for context - do NOT answer these):
${allQuestions.filter(q => q.id !== question.id).map(q => `${q.id}. ${q.question}`).join('\n')}

FULL STATUTE TEXT TO SEARCH:
${statuteText}

ENVIRONMENTAL PROTECTION SCORING RUBRIC (be consistent across municipalities):
- 1.0 = Comprehensive protection: Detailed requirements, strong enforcement, clear penalties >$1000, mandatory replacement, professional oversight
- 0.8 = Strong protection: Good requirements with enforcement, penalties $500-1000, replacement rules  
- 0.6 = Moderate protection: Basic permit requirements, penalties $250-500, some replacement rules
- 0.4 = Weak protection: Minimal requirements, low penalties <$250, unclear enforcement
- 0.2 = Very weak protection: Vague requirements, minimal penalties, poor enforcement
- 0.0 = No protection: No requirements found or completely inadequate

GAP ANALYSIS REQUIREMENT:
If your score is less than 1.0, you MUST provide a "gap" field explaining specifically what would be needed to achieve a perfect 1.0 environmental protection score. Focus on concrete improvements like:
- Higher penalty amounts
- Mandatory professional consultation (arborist, environmental review)  
- Stricter replacement ratios
- Clearer enforcement mechanisms
- More comprehensive permit requirements
- Better notification processes
- Data collection requirements

FOCUS EXAMPLES:
- If asked about permits: Focus ONLY on permit process, requirements, who reviews - do NOT mention neighbor notification
- If asked about notifications: Focus ONLY on who to notify and when - do NOT mention permit processes  
- If asked about penalties: Focus ONLY on fines and consequences - do NOT mention replacement requirements
- If asked about replacement: Focus ONLY on replanting rules and species - do NOT mention permit processes

Provide response as JSON:
{
  "answer": "Complete answer addressing only this specific question",
  "confidence": 85,
  "score": 0.8,
  "gap": "To achieve 1.0: Needs stronger penalties (>$1000), mandatory arborist consultation, or clearer enforcement mechanisms",
  "scoreJustification": "Detailed explanation of environmental protection score",
  "sourceRefs": ["§273-7", "§273-8"],
  "qualityCheck": "Confirmation this answer addresses only the question asked"
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ 
        role: "system", 
        content: "You are a municipal law expert. Provide focused, accurate answers with consistent scoring. Search thoroughly and avoid cross-contamination between questions. Respond with valid JSON only."
      }, {
        role: "user", 
        content: prompt 
      }],
      response_format: { type: "json_object" },
      temperature: 0.1, // Very low temperature for consistency
    });

    const result = JSON.parse(response.choices[0].message.content!);
    
    console.log(`  ✅ Q${question.id}: Score ${result.score} | Confidence ${result.confidence}% | ${result.answer.substring(0, 80)}...`);

    return {
      id: question.id,
      question: question.question,
      answer: result.answer,
      confidence: result.confidence,
      score: result.score,
      gap: result.gap || undefined,
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
 * Fix analysis quality issues for a specific municipality
 */
export async function fixMunicipalityAnalysisQuality(
  municipalityId: string,
  domainId: string = 'trees'
): Promise<Analysis | null> {
  try {
    console.log(`🔧 Fixing analysis quality for ${municipalityId}...`);

    // Load required files
    const questionsPath = `data/${domainId}/questions.json`;
    const statutePath = `data/${domainId}/${municipalityId}/statute.txt`;
    const metadataPath = `data/${domainId}/${municipalityId}/metadata.json`;

    if (!fs.existsSync(questionsPath) || !fs.existsSync(statutePath) || !fs.existsSync(metadataPath)) {
      throw new Error(`Required files not found for ${municipalityId}`);
    }

    const questionsData = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));
    const questions: Question[] = questionsData.questions;
    const statuteText = fs.readFileSync(statutePath, 'utf-8');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    
    const municipalityName = `${metadata.municipality} - ${metadata.municipalityType}`;

    console.log(`📋 Processing ${questions.length} questions for ${municipalityName}`);
    console.log(`📄 Statute length: ${statuteText.length} characters`);

    // Generate improved answers for each question
    const answers: AnalysisAnswer[] = [];
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      console.log(`\n📝 Question ${i + 1}/${questions.length}:`);
      
      const answer = await generateHighQualityAnswer(
        question,
        statuteText,
        municipalityName,
        questions
      );
      answers.push(answer);
      
      // Rate limiting
      if (i < questions.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    // Calculate weighted overall score
    const questionsWithScores = answers.filter(a => a.score > 0);
    let overallScore = 0;
    if (questionsWithScores.length > 0) {
      const totalWeight = questions.reduce((sum, q) => sum + (q.weight || 1), 0);
      const weightedScore = answers.reduce((sum, answer) => {
        const question = questions.find(q => q.id === answer.id);
        const weight = question?.weight || 1;
        return sum + (answer.score * weight);
      }, 0);
      overallScore = (weightedScore / totalWeight) * 10;
    }

    const improvedAnalysis: Analysis = {
      municipality: {
        id: municipalityId,
        displayName: municipalityName
      },
      domain: {
        id: domainId,
        displayName: domainId === 'trees' ? 'Trees & Urban Forestry' : domainId
      },
      questions: answers,
      overallScore: Math.round(overallScore * 10) / 10,
      lastUpdated: new Date().toISOString(),
      processingMethod: "quality-improved-analysis-v1",
      usesStateCode: false
    };

    // Save improved analysis
    const outputPath = `data/${domainId}/${municipalityId}/analysis_quality_fixed.json`;
    fs.writeFileSync(outputPath, JSON.stringify(improvedAnalysis, null, 2));
    
    console.log(`\n✅ Quality-improved analysis saved: ${outputPath}`);
    console.log(`📊 Overall Score: ${overallScore.toFixed(1)}/10.0`);
    console.log(`📊 Questions with answers: ${answers.filter(a => a.answer !== "Not specified in the statute.").length}/${answers.length}`);
    console.log(`📊 Average score: ${(answers.reduce((sum, a) => sum + a.score, 0) / answers.length).toFixed(2)}`);
    
    return improvedAnalysis;

  } catch (error) {
    console.error(`❌ Error fixing analysis quality for ${municipalityId}:`, error);
    return null;
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const municipalityId = process.argv[2];
  const domainId = process.argv[3] || 'trees';
  
  if (!municipalityId) {
    console.log('Usage: tsx fixAnalysisQuality.ts <municipalityId> [domainId]');
    console.log('Example: tsx fixAnalysisQuality.ts NY-Hastings-on-Hudson-Village trees');
    process.exit(1);
  }
  
  fixMunicipalityAnalysisQuality(municipalityId, domainId)
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}