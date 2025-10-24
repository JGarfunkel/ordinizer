#!/usr/bin/env tsx

import fs from 'fs-extra';
import OpenAI from 'openai';

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function analyzeDobbsFerry() {
  console.log('🌳 Analyzing Dobbs Ferry with truncated statute...');
  
  const questions = await fs.readJson('./data/trees/questions.json');
  const fullStatute = await fs.readFile('./data/trees/NY-DobbsFerry-Village/statute.txt', 'utf-8');
  
  // Truncate statute to fit token limits (keep first 15000 characters)
  const statute = fullStatute.substring(0, 15000) + '\n\n[Note: Statute truncated due to length]';
  
  console.log(`📄 Using ${statute.length} characters of statute (truncated from ${fullStatute.length})`);
  
  const analysisPrompt = `You are analyzing tree regulations for Dobbs Ferry Village only.

STATUTE TEXT (TRUNCATED):
${statute}

Answer these questions based ONLY on Dobbs Ferry Village's statute. Be concise and practical for residents.

QUESTIONS:
${questions.questions.map((q: any) => `${q.id}. ${q.question}`).join('\n')}

INSTRUCTIONS:
- Focus ONLY on Dobbs Ferry Village regulations
- Do NOT mention other municipalities
- Be concise and practical for residents
- Say "not specified in available statute text" if unclear due to truncation
- Include relevant section numbers when available
- Rate confidence: high (clearly stated), medium (can be inferred), low (unclear/not found)

Format as JSON:
{
  "answers": [
    {
      "questionId": 1,
      "question": "Original question text",
      "answer": "Clear answer for Dobbs Ferry Village only",
      "confidence": "high|medium|low", 
      "relevantSections": ["§185-1"]
    }
  ],
  "alignmentSuggestions": {
    "strengths": ["What Dobbs Ferry does well"],
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
          content: "You are a municipal law expert. Analyze only Dobbs Ferry Village's tree regulations. Be concise and practical. Respond with valid JSON only."
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
      municipality: "Dobbs Ferry Village",
      municipalityId: "NY-DobbsFerry-Village",
      domain: "trees",
      analyzedAt: new Date().toISOString(),
      note: "Analysis based on truncated statute due to length constraints",
      answers: result.answers.map((answer: any) => ({
        ...answer,
        question: questions.questions.find((q: any) => q.id === answer.questionId)?.question || answer.question
      })),
      alignmentSuggestions: result.alignmentSuggestions
    };

    await fs.writeJson('./data/trees/NY-DobbsFerry-Village/analysis.json', analysis, { spaces: 2 });
    
    console.log('✅ Completed Dobbs Ferry Village analysis!');

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// Run the analysis
analyzeDobbsFerry();