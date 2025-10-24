#!/usr/bin/env tsx

/**
 * Fix questions.json files by moving "text" field to "question" field
 * 
 * Usage: tsx scripts/utils/fixQuestionFields.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';

interface Question {
  id: number;
  category: string;
  text?: string;      // Old field name
  question?: string;  // Correct field name
  weight?: number;
  order?: number;
  [key: string]: any; // Allow other fields
}

interface QuestionsFile {
  domain?: string;
  generatedAt?: string;
  questions?: Question[];
}

// GLB domain uses array format directly
type QuestionsData = QuestionsFile | Question[];

async function fixQuestionFields() {
  const dataDir = path.join(process.cwd(), 'data');
  
  try {
    const domains = await fs.readdir(dataDir, { withFileTypes: true });
    let totalFixed = 0;
    let filesProcessed = 0;
    
    for (const domain of domains) {
      if (!domain.isDirectory()) continue;
      
      const questionsPath = path.join(dataDir, domain.name, 'questions.json');
      
      try {
        await fs.access(questionsPath);
      } catch {
        // questions.json doesn't exist, skip
        continue;
      }
      
      console.log(`Processing ${domain.name}/questions.json...`);
      filesProcessed++;
      
      try {
        const questionsData: QuestionsData = JSON.parse(
          await fs.readFile(questionsPath, 'utf-8')
        );
        
        let domainFixed = 0;
        let hasChanges = false;
        
        // Handle both array format (GLB) and object format (others)
        let questions: Question[];
        if (Array.isArray(questionsData)) {
          questions = questionsData;
        } else if (questionsData.questions && Array.isArray(questionsData.questions)) {
          questions = questionsData.questions;
        } else {
          console.log(`  No questions array found in ${domain.name}`);
          continue;
        }
        
        questions.forEach((question) => {
          if (question.text && !question.question) {
            // Move "text" field to "question"
            question.question = question.text;
            delete question.text;
            domainFixed++;
            hasChanges = true;
            console.log(`  Fixed question ${question.id}: "${question.question.substring(0, 50)}..."`);
          }
        });
        
        if (hasChanges) {
          // Write back the fixed file
          await fs.writeFile(
            questionsPath, 
            JSON.stringify(questionsData, null, 2)
          );
          console.log(`  ✓ Fixed ${domainFixed} questions in ${domain.name}`);
          totalFixed += domainFixed;
        } else {
          console.log(`  No issues found in ${domain.name}`);
        }
        
      } catch (error) {
        console.error(`  Error processing ${domain.name}:`, error);
      }
    }
    
    console.log(`\nSummary:`);
    console.log(`- Processed ${filesProcessed} questions.json files`);
    console.log(`- Fixed ${totalFixed} questions with "text" → "question" field migration`);
    
    if (totalFixed > 0) {
      console.log(`\n✓ Successfully fixed all "text" field issues`);
    } else {
      console.log(`\n✓ All questions.json files already have correct "question" fields`);
    }
    
  } catch (error) {
    console.error('Error accessing data directory:', error);
    process.exit(1);
  }
}

fixQuestionFields()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error fixing question fields:', error);
    process.exit(1);
  });