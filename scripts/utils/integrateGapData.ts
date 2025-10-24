#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';

/**
 * Script to integrate gap analysis data from quality-fixed analysis files
 * into the main analysis files so the scoring API can display gap information
 */

interface AnalysisAnswer {
  id: number;
  question: string;
  answer: string;
  confidence: number;
  score: number;
  gap?: string;
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

async function integrateGapDataForMunicipality(municipalityDir: string): Promise<boolean> {
  const mainAnalysisPath = path.join(municipalityDir, 'analysis.json');
  const qualityFixedPath = path.join(municipalityDir, 'analysis_quality_fixed.json');
  
  // Check if both files exist
  if (!fs.existsSync(mainAnalysisPath) || !fs.existsSync(qualityFixedPath)) {
    console.log(`⏭️  Skipping ${path.basename(municipalityDir)} - missing analysis files`);
    return false;
  }

  try {
    // Load both analysis files
    const mainAnalysis: Analysis = JSON.parse(fs.readFileSync(mainAnalysisPath, 'utf-8'));
    const qualityFixed: Analysis = JSON.parse(fs.readFileSync(qualityFixedPath, 'utf-8'));
    
    console.log(`🔄 Processing ${mainAnalysis.municipality.displayName}...`);
    
    // Create a map of quality-fixed questions by ID for quick lookup
    const qualityQuestionMap = new Map();
    qualityFixed.questions.forEach(q => {
      qualityQuestionMap.set(q.id, q);
    });
    
    // Update main analysis questions with gap data and improved scores
    let updatedCount = 0;
    mainAnalysis.questions = mainAnalysis.questions.map(question => {
      const qualityQuestion = qualityQuestionMap.get(question.id);
      if (qualityQuestion) {
        updatedCount++;
        return {
          ...question,
          answer: qualityQuestion.answer, // Use improved answer
          score: qualityQuestion.score, // Use improved score
          gap: qualityQuestion.gap || undefined, // Add gap analysis
          sourceRefs: qualityQuestion.sourceRefs || question.sourceRefs,
          relevantSections: qualityQuestion.relevantSections || question.relevantSections
        };
      }
      return question;
    });
    
    // Update overall score and processing method
    mainAnalysis.overallScore = qualityFixed.overallScore;
    mainAnalysis.processingMethod = "quality-improved-with-gaps";
    mainAnalysis.lastUpdated = new Date().toISOString();
    
    // Save updated main analysis
    fs.writeFileSync(mainAnalysisPath, JSON.stringify(mainAnalysis, null, 2));
    
    console.log(`✅ Updated ${updatedCount} questions with gap data for ${mainAnalysis.municipality.displayName}`);
    return true;
    
  } catch (error) {
    console.error(`❌ Error processing ${path.basename(municipalityDir)}:`, error);
    return false;
  }
}

async function integrateAllGapData(domainId: string = 'trees'): Promise<void> {
  const domainDir = `data/${domainId}`;
  
  if (!fs.existsSync(domainDir)) {
    console.error(`❌ Domain directory not found: ${domainDir}`);
    process.exit(1);
  }
  
  console.log(`🚀 Integrating gap data for ${domainId} domain...`);
  
  // Find all municipality directories
  const entries = fs.readdirSync(domainDir, { withFileTypes: true });
  const municipalityDirs = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('NY-'))
    .map(entry => path.join(domainDir, entry.name));
    
  console.log(`🏘️  Found ${municipalityDirs.length} municipalities to process`);
  
  let successful = 0;
  let skipped = 0;
  
  for (const municipalityDir of municipalityDirs) {
    const wasUpdated = await integrateGapDataForMunicipality(municipalityDir);
    if (wasUpdated) {
      successful++;
    } else {
      skipped++;
    }
  }
  
  console.log(`\n🎉 Integration complete!`);
  console.log(`✅ Successfully updated: ${successful}`);
  console.log(`⏭️  Skipped: ${skipped}`);
  console.log(`📁 Total processed: ${municipalityDirs.length}`);
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const domainId = process.argv[2] || 'trees';
  
  integrateAllGapData(domainId)
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

export { integrateGapDataForMunicipality, integrateAllGapData };