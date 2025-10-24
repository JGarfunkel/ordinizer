#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function regenerateArdsleyAnalysis() {
  console.log('🔄 Regenerating Ardsley Village analysis with corrected questions...');
  
  const questions = await fs.readJson('./data/trees/questions.json');
  const statute = await fs.readFile('./data/trees/NY-Ardsley-Village/statute.txt', 'utf-8');
  
  const analysisPrompt = `You are analyzing tree regulations for Ardsley Village only.

STATUTE TEXT:
${statute}

Answer these questions based ONLY on Ardsley Village's statute. Be concise and practical for residents.

QUESTIONS:
${questions.questions.map((q: any) => `${q.id}. ${q.question}`).join('\n')}

INSTRUCTIONS:
- Focus ONLY on Ardsley Village regulations
- Do NOT mention other municipalities
- Be concise and practical for residents
- Say "not specified in the statute" if unclear
- Include relevant section numbers when available
- Rate confidence: high (clearly stated), medium (can be inferred), low (unclear/not found)

Also provide alignment suggestions:
- Strengths: What Ardsley Village does well in tree regulation
- Improvements: Areas where regulations could be clearer or more comprehensive  
- Recommendations: Specific suggestions for better tree management
- Best practices: Notable positive aspects other municipalities could learn from

Format as JSON:
{
  "answers": [
    {
      "questionId": 1,
      "question": "Original question text",
      "answer": "Clear answer for Ardsley Village only",
      "confidence": "high|medium|low", 
      "relevantSections": ["§185-1"]
    }
  ],
  "alignmentSuggestions": {
    "strengths": ["What Ardsley does well"],
    "improvements": ["What could be clearer"], 
    "recommendations": ["Specific suggestions"],
    "bestPractices": ["Notable positive aspects"]
  }
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a municipal law expert. Analyze only Ardsley Village's tree regulations. Be concise and practical. Respond with valid JSON only."
        },
        {
          role: "user",
          content: analysisPrompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const result = JSON.parse(response.choices[0].message.content!);

    const analysis = {
      municipality: "Ardsley Village",
      municipalityId: "NY-Ardsley-Village",
      domain: "trees",
      analyzedAt: new Date().toISOString(),
      answers: result.answers.map((answer: any) => {
        const questionData = questions.questions.find((q: any) => q.id === answer.questionId);
        return {
          ...answer,
          question: questionData?.question || answer.question,
          title: questionData?.title || answer.title
        };
      }),
      alignmentSuggestions: result.alignmentSuggestions
    };

    await fs.writeJson('./data/trees/NY-Ardsley-Village/analysis.json', analysis, { spaces: 2 });
    
    console.log('✅ Updated Ardsley Village analysis with corrected questions!');
    console.log('\n📋 Sample Q&A:');
    analysis.answers.slice(0, 3).forEach((a: any) => {
      console.log(`Q${a.questionId}: ${a.question}`);
      console.log(`A: ${a.answer}`);
      console.log(`Confidence: ${a.confidence}\n`);
    });

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// Run the analysis
regenerateArdsleyAnalysis();