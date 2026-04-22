#!/usr/bin/env tsx

/**
 * Generate municipality-specific questions for a given domain using OpenAI
 * 
 * Usage: tsx scripts/generateEntitySpecificQuestions.ts <domain> [description]
 * 
 * @param domain - Directory name for the domain (e.g., 'trees', 'parking', 'noise')
 * @param description - Optional verbose description for better AI context
 */

import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Question {
  id: number;
  question: string;
  order: number;
}

interface QuestionsData {
  domain: string;
  generatedAt: string;
  questionsCount: number;
  questions: Question[];
}

const DATA_DIR = './data';

async function generateEntitySpecificQuestions(domain: string, domainDescription?: string, questionSampleFile?: string): Promise<void> {
  console.log(`\n🔄 Generating municipality-specific questions for ${domain} domain...`);
  
  const domainContext = domainDescription || domain;
  let prompt = `You are an expert in municipal law and regulations. 
  Generate 15 practical, actionable questions that residents would commonly ask about ${domainContext} regulations in their municipality.

The questions should be:
1. Entity-agnostic (don't mention specific municipality names)
2. Practical and actionable for residents
3. Focused on common scenarios people encounter
4. Clear and easy to understand
5. Diverse covering different aspects of ${domain} regulations

Format your response as a JSON object with this structure:
{
  "questions": [
    {
      "id": 1,
      "question": "Question text here",
      "order": 1
    }
  ]
}

Generate exactly 15 questions for the ${domainContext} domain.
`;

  if (questionSampleFile) {
    try {
      const sampleContent = await fs.readFile(questionSampleFile, 'utf-8'); 
      prompt += `\n\nHere are some sample statutes for context:\n${sampleContent}`;
    } catch (error) {
      console.warn(`⚠️ Could not read sample statutes from file: ${questionSampleFile}. Proceeding without sample context.`);
    }
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a municipal law expert. Respond with valid JSON only."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });

    const result = JSON.parse(response.choices[0].message.content!);
    
    if (!result.questions || !Array.isArray(result.questions)) {
      throw new Error('Invalid response format from OpenAI');
    }

    const questionsData: QuestionsData = {
      domain,
      generatedAt: new Date().toISOString(),
      questionsCount: result.questions.length,
      questions: result.questions.map((q: any, index: number) => ({
        id: index + 1,
        question: q.question,
        order: index + 1
      }))
    };

    // Save to domain directory
    const questionsFile = path.join(DATA_DIR, domain, 'questions.json');
    await fs.ensureDir(path.dirname(questionsFile));
    await fs.writeJson(questionsFile, questionsData, { spaces: 2 });

    console.log(`✅ Generated ${questionsData.questionsCount} municipality-specific questions for ${domain}`);
    console.log(`📁 Saved to: ${questionsFile}`);
    
    // Display the questions
    console.log('\n📋 Generated Questions:');
    questionsData.questions.forEach((q, index) => {
      console.log(`${index + 1}. ${q.question}`);
    });

  } catch (error) {
    console.error(`❌ Error generating questions for ${domain}:`, error);
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error(`
Usage: tsx scripts/generateEntitySpecificQuestions.ts <domain> [description]

Parameters:
  domain      - Directory name for the domain (e.g., 'trees', 'parking', 'noise')
  description - Optional verbose description to send to OpenAI for better context
                (e.g., 'tree removal, planting, and maintenance regulations')
  questionSampleFile - Optional path to a text file containing sample statutes to provide as context for question generation (default: './prompt_questionExample.txt')

Examples:
  tsx scripts/generateEntitySpecificQuestions.ts trees
  tsx scripts/generateEntitySpecificQuestions.ts parking "parking rules, enforcement, and permit requirements"
  tsx scripts/generateEntitySpecificQuestions.ts noise "noise ordinances, quiet hours, and sound level regulations"
    `);
    process.exit(1);
  }

  const domain = args[0];
  const description = args[1]; // Optional second parameter
  const questionSampleFile = args[2] || "./prompt_questionExample.txt"; // Optional third parameter for sample statutes


  try {
    await generateEntitySpecificQuestions(domain, description, questionSampleFile);
    console.log('\n🎉 Entity-specific questions generation completed!');
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Run main function
main();