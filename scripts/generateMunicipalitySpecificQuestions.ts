#!/usr/bin/env tsx

/**
 * Generate municipality-specific questions for a given domain using OpenAI
 * 
 * Usage: tsx scripts/generateMunicipalitySpecificQuestions.ts <domain> [description]
 * 
 * @param domain - Directory name for the domain (e.g., 'trees', 'parking', 'noise')
 * @param description - Optional verbose description for better AI context
 */

import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
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

async function generateMunicipalitySpecificQuestions(domain: string, domainDescription?: string): Promise<void> {
  console.log(`\n🔄 Generating municipality-specific questions for ${domain} domain...`);
  
  const domainContext = domainDescription || domain;
  const prompt = `You are an expert in municipal law and regulations. Generate 15 practical, actionable questions that residents would commonly ask about ${domainContext} regulations in their municipality.

The questions should be:
1. Municipality-agnostic (don't mention specific municipality names)
2. Practical and actionable for residents
3. Focused on common scenarios people encounter
4. Clear and easy to understand
5. Diverse covering different aspects of ${domain} regulations

Examples of GOOD questions for trees:
- "Do I need a permit to remove a tree on my private property?"
- "What are the penalties for removing trees without a permit?"
- "Are there distance requirements when planting trees near sidewalks or streets?"
- "How do I apply for a tree removal permit?"
- "Are there fees associated with tree removal permits?"
- "What is the procedure for emergency tree removal?"
- "Which government department handles tree permits?"
- "Are certain tree species protected or prohibited?"
- "What are my responsibilities for maintaining trees on my property?"
- "Can I appeal a tree removal decision?"

Examples of BAD questions (avoid these):
- "How does tree removal in Bedford compare to Ardsley?" (mentions specific municipalities)
- "What is the Tree Preservation Board?" (too specific to one municipality's structure)

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

Generate exactly 15 questions for the ${domainContext} domain.`;

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
Usage: tsx scripts/generateMunicipalitySpecificQuestions.ts <domain> [description]

Parameters:
  domain      - Directory name for the domain (e.g., 'trees', 'parking', 'noise')
  description - Optional verbose description to send to OpenAI for better context
                (e.g., 'tree removal, planting, and maintenance regulations')

Examples:
  tsx scripts/generateMunicipalitySpecificQuestions.ts trees
  tsx scripts/generateMunicipalitySpecificQuestions.ts parking "parking rules, enforcement, and permit requirements"
  tsx scripts/generateMunicipalitySpecificQuestions.ts noise "noise ordinances, quiet hours, and sound level regulations"
    `);
    process.exit(1);
  }

  const domain = args[0];
  const description = args[1]; // Optional second parameter

  try {
    await generateMunicipalitySpecificQuestions(domain, description);
    console.log('\n🎉 Municipality-specific questions generation completed!');
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Run main function
main();