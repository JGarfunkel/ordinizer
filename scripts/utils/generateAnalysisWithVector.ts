#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { vectorService } from '../../server/services/vectorService.js';

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Question {
  id: string;
  question: string;
  category: string;
  weight?: number;
}

interface Municipality {
  id: string;
  name: string;
  displayName: string;
}

interface AnalysisAnswer {
  questionId: string;
  question: string;
  answer: string;
  confidence: number;
  score: number; // Environmental protection score 0.0 - 1.0
  sourceRefs: Array<{
    section: string;
    content: string;
    relevance: number;
  }>;
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
  totalSections: number;
}

async function generateAnswer(
  question: Question,
  municipalityId: string,
  domainId: string,
  municipalityName: string
): Promise<AnalysisAnswer> {
  try {
    console.log(`  📋 Analyzing: ${question.question}`);

    // Search for relevant statute sections using vector search
    const relevantSections = await vectorService.searchRelevantSections(
      municipalityId,
      domainId,
      question.question,
      5 // Get top 5 most relevant sections
    );

    if (relevantSections.length === 0) {
      console.log(`  ⚠️  No relevant sections found for question ${question.id}`);
      return {
        questionId: question.id,
        question: question.question,
        answer: "No relevant statute sections found for this question.",
        confidence: 0,
        score: 0.0,
        sourceRefs: []
      };
    }

    // Combine the most relevant sections for context
    const contextSections = relevantSections
      .filter(section => section.score > 0.7) // Only include high-relevance sections
      .slice(0, 3) // Limit to top 3 sections to stay within token limits
      .map(section => `Section ${section.section || 'Unknown'}: ${section.content}`)
      .join('\n\n');

    const prompt = `You are analyzing municipal statutes for ${municipalityName}. Based on the following relevant statute sections, answer this question clearly and accurately:

QUESTION: ${question.question}

RELEVANT STATUTE SECTIONS:
${contextSections}

Please provide:
1. A clear, direct answer to the question
2. A confidence level (0-100) based on how well the statutes address this question
3. An environmental protection score (0.0-1.0) based on how strong the statute is at protecting the environment for this specific question:
   - 1.0 = Very strong environmental protection (strict requirements, comprehensive coverage, strong penalties)
   - 0.8 = Strong protection (good requirements with some enforcement)
   - 0.6 = Moderate protection (basic requirements, limited enforcement)
   - 0.4 = Weak protection (minimal requirements, poor enforcement)
   - 0.2 = Very weak protection (vague requirements, no real enforcement)
   - 0.0 = No environmental protection (no relevant statutes or completely inadequate)
4. Reference any specific sections that support your answer

If the answer is "Not specified in the statute" or equivalent, the environmental score should be 0.0.

Format your response as JSON:
{
  "answer": "Your clear answer here",
  "confidence": 85,
  "score": 0.75,
  "sourceRefs": [
    {
      "section": "121-3",
      "content": "Brief excerpt supporting the answer",
      "relevance": 95
    }
  ]
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');

    return {
      questionId: question.id,
      question: question.question,
      answer: result.answer || "Unable to determine from available statute sections.",
      confidence: Math.min(100, Math.max(0, result.confidence || 0)),
      score: Math.min(1.0, Math.max(0.0, parseFloat(result.score?.toFixed(2) || '0.0'))),
      sourceRefs: (result.sourceRefs || []).map((ref: any) => ({
        section: ref.section || 'Unknown',
        content: (ref.content || '').substring(0, 500), // Limit content length
        relevance: Math.min(100, Math.max(0, ref.relevance || 0))
      }))
    };

  } catch (error) {
    console.error(`  ❌ Error analyzing question ${question.id}:`, error);
    return {
      questionId: question.id,
      question: question.question,
      answer: "Error occurred during analysis.",
      confidence: 0,
      score: 0.0,
      sourceRefs: []
    };
  }
}

async function generateVectorAnalysis(municipalityId: string, domainId: string) {
  try {
    console.log(`\n🔍 Generating vector-based analysis for ${municipalityId}/${domainId}`);

    // Load municipality and domain info
    const municipalitiesData = JSON.parse(fs.readFileSync('data/municipalities.json', 'utf-8'));
    const domainsData = JSON.parse(fs.readFileSync('data/domains.json', 'utf-8'));
    
    const municipalities = municipalitiesData.municipalities || municipalitiesData;
    const domains = domainsData.domains || domainsData;
    
    const municipality = municipalities.find((m: Municipality) => m.id === municipalityId);
    const domain = domains.find((d: any) => d.id === domainId);
    
    if (!municipality || !domain) {
      throw new Error(`Municipality or domain not found: ${municipalityId}/${domainId}`);
    }

    // Load questions for this domain
    const questionsPath = `data/${domainId}/questions.json`;
    if (!fs.existsSync(questionsPath)) {
      throw new Error(`Questions file not found: ${questionsPath}`);
    }

    const questionsData = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));
    const questions: Question[] = questionsData.questions || questionsData;
    console.log(`📋 Processing ${questions.length} questions`);

    // Generate answers using vector search
    const answers: AnalysisAnswer[] = [];
    for (const question of questions) {
      const answer = await generateAnswer(question, municipalityId, domainId, municipality.displayName);
      answers.push(answer);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Calculate overall score
    let totalWeightedScore = 0;
    let totalPossibleWeight = 0;
    
    for (const answer of answers) {
      const question = questions.find(q => q.id === answer.questionId);
      const weight = question?.weight || 1;
      totalWeightedScore += answer.score * weight;
      totalPossibleWeight += weight;
    }
    
    const overallScore = totalPossibleWeight > 0 
      ? Math.round((totalWeightedScore / totalPossibleWeight) * 10 * 10) / 10 // Round to 1 decimal place
      : 0.0;

    // Get index statistics to determine total sections
    const stats = await vectorService.getIndexStats();
    const totalSections = stats?.totalRecordCount || 0;

    // Create analysis object
    const analysis: Analysis = {
      municipality: {
        id: municipality.id,
        displayName: municipality.displayName
      },
      domain: {
        id: domain.id,
        displayName: domain.displayName
      },
      questions: answers,
      overallScore: overallScore,
      lastUpdated: new Date().toISOString(),
      processingMethod: "vector-search",
      totalSections
    };

    // Save analysis
    const analysisDir = `data/${domainId}/${municipalityId}`;
    fs.mkdirSync(analysisDir, { recursive: true });
    
    const analysisPath = `${analysisDir}/analysis.json`;
    fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));

    console.log(`✅ Vector analysis saved to: ${analysisPath}`);
    console.log(`📊 Questions processed: ${answers.length}`);
    console.log(`📊 Average confidence: ${(answers.reduce((sum, a) => sum + a.confidence, 0) / answers.length).toFixed(1)}%`);

    return analysis;

  } catch (error) {
    console.error(`❌ Error generating vector analysis for ${municipalityId}/${domainId}:`, error);
    throw error;
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const municipalityId = process.argv[2];
  const domainId = process.argv[3];

  if (!municipalityId || !domainId) {
    console.log('Usage: tsx scripts/generateAnalysisWithVector.ts <municipalityId> <domainId>');
    console.log('Example: tsx scripts/generateAnalysisWithVector.ts NY-Bedford-Town trees');
    process.exit(1);
  }

  generateVectorAnalysis(municipalityId, domainId).catch(console.error);
}

export { generateVectorAnalysis };