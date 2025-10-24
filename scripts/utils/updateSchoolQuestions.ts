#!/usr/bin/env tsx

import fs from "fs/promises";
import path from "path";

// Centralized path resolver to work from any directory
class PathResolver {
  private static _projectRoot: string | null = null;

  static async getProjectRoot(): Promise<string> {
    if (this._projectRoot) {
      return this._projectRoot;
    }

    // Start from current working directory and walk up to find project root
    let currentDir = process.cwd();
    
    while (currentDir !== path.dirname(currentDir)) {
      // Check for package.json as project root marker
      const packageJsonPath = path.join(currentDir, 'package.json');
      try {
        await fs.access(packageJsonPath);
        this._projectRoot = currentDir;
        return currentDir;
      } catch {
        // Continue searching
      }
      
      currentDir = path.dirname(currentDir);
    }
    
    // Fallback: assume current directory is project root
    this._projectRoot = process.cwd();
    return this._projectRoot;
  }

  static async getSchoolDataDir(): Promise<string> {
    const projectRoot = await this.getProjectRoot();
    return path.join(projectRoot, 'data', 'environmental-schools');
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findAllQuestionsFiles(): Promise<string[]> {
  const schoolDataDir = await PathResolver.getSchoolDataDir();
  const questionsFiles: string[] = [];

  async function scanDirectory(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        await scanDirectory(fullPath);
      } else if (entry.name === 'questions.json') {
        questionsFiles.push(fullPath);
      }
    }
  }

  await scanDirectory(schoolDataDir);
  return questionsFiles.sort();
}

async function updateQuestionsFile(filePath: string): Promise<boolean> {
  try {
    console.log(`📝 Processing: ${path.relative(process.cwd(), filePath)}`);
    
    // Read existing file
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    
    let updatedCount = 0;
    
    // Update questions array if it exists
    if (data.questions && Array.isArray(data.questions)) {
      for (const question of data.questions) {
        if (question.text && !question.question) {
          question.question = question.text;
          delete question.text;
          updatedCount++;
        }
      }
    }
    
    if (updatedCount > 0) {
      // Write back to file with proper formatting
      await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      console.log(`   ✅ Updated ${updatedCount} questions (text → question)`);
      return true;
    } else {
      console.log(`   ⚪ No changes needed (already using "question" property)`);
      return false;
    }
    
  } catch (error) {
    console.error(`   ❌ Error processing file: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('🔄 School Questions Update Script');
  console.log('📁 Scanning for questions.json files in environmental-schools...\n');
  
  try {
    const questionsFiles = await findAllQuestionsFiles();
    
    if (questionsFiles.length === 0) {
      console.log('⚠️  No questions.json files found in environmental-schools directory');
      return;
    }
    
    console.log(`📋 Found ${questionsFiles.length} questions.json files:\n`);
    
    let totalUpdated = 0;
    
    for (const filePath of questionsFiles) {
      const wasUpdated = await updateQuestionsFile(filePath);
      if (wasUpdated) {
        totalUpdated++;
      }
    }
    
    console.log(`\n🎉 Script completed!`);
    console.log(`📊 Updated ${totalUpdated} out of ${questionsFiles.length} files`);
    
    if (totalUpdated > 0) {
      console.log('\n✨ All "text" properties have been changed to "question" properties');
    }
    
  } catch (error) {
    console.error('❌ Script failed:', error.message);
    process.exit(1);
  }
}

// Run the script
main();