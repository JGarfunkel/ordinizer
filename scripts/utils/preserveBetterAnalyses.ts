#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';

interface Question {
  id: string;
  question: string;
  answer: string;
  confidence: number;
  sourceRefs: string[];
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
  questions: Question[];
}

function calculateAnalysisQuality(analysis: Analysis): number {
  if (!analysis.questions || analysis.questions.length === 0) return 0;
  
  let qualityScore = 0;
  const totalQuestions = analysis.questions.length;
  
  for (const question of analysis.questions) {
    // Score based on answer content
    if (question.answer === "Not specified in the statute.") {
      qualityScore += 1; // Low score for "not specified"
    } else if (question.answer.length > 50) {
      qualityScore += 10; // High score for detailed answers
    } else if (question.answer.length > 10) {
      qualityScore += 5; // Medium score for basic answers
    }
    
    // Bonus for source references
    if (question.sourceRefs && question.sourceRefs.length > 0) {
      qualityScore += 3;
    }
    
    // Bonus for high confidence
    if (question.confidence > 80) {
      qualityScore += 2;
    }
  }
  
  return qualityScore / totalQuestions; // Average quality per question
}

async function recoverBetterAnalyses(domain: string = 'property-maintenance') {
  console.log(`🔄 Recovering better analyses for ${domain}...`);
  
  const domainDir = path.join(process.cwd(), '..', 'data', domain);
  if (!await fs.pathExists(domainDir)) {
    console.log(`❌ Domain directory ${domain} not found`);
    return;
  }
  
  const municipalities = await fs.readdir(domainDir);
  let recoveredCount = 0;
  
  for (const municDir of municipalities) {
    if (municDir === 'questions.json' || !municDir.startsWith('NY-')) continue;
    
    const analysisPath = path.join(domainDir, municDir, 'analysis.json');
    if (!await fs.pathExists(analysisPath)) {
      console.log(`⚠️  ${municDir}: No analysis.json found`);
      continue;
    }
    
    try {
      const currentAnalysis: Analysis = await fs.readJson(analysisPath);
      const currentQuality = calculateAnalysisQuality(currentAnalysis);
      
      console.log(`\n🔍 ${municDir}: Current quality score: ${currentQuality.toFixed(1)}`);
      
      // If current quality is very low, try to recover from git history
      if (currentQuality < 3) {
        console.log(`  🚨 Low quality detected, searching git history...`);
        
        const gitPath = `data/${domain}/${municDir}/analysis.json`;
        try {
          // Get commit history for this file
          const commits = execSync(`git log --oneline --follow ${gitPath} | head -10`, 
            { encoding: 'utf-8', cwd: path.join(process.cwd(), '..') }).trim().split('\n');
          
          let bestAnalysis: Analysis | null = null;
          let bestQuality = currentQuality;
          let bestCommit = '';
          
          // Check previous versions
          for (let i = 1; i < Math.min(commits.length, 6); i++) {
            const commit = commits[i].split(' ')[0];
            try {
              console.log(`    🔍 Checking commit ${commit}...`);
              const historicalContent = execSync(`git show ${commit}:${gitPath}`, 
                { encoding: 'utf-8', cwd: path.join(process.cwd(), '..') });
              
              const historicalAnalysis: Analysis = JSON.parse(historicalContent);
              const historicalQuality = calculateAnalysisQuality(historicalAnalysis);
              
              console.log(`      Quality score: ${historicalQuality.toFixed(1)}`);
              
              if (historicalQuality > bestQuality) {
                bestAnalysis = historicalAnalysis;
                bestQuality = historicalQuality;
                bestCommit = commit;
              }
            } catch (error) {
              console.log(`      ❌ Failed to parse commit ${commit}`);
            }
          }
          
          // If we found a better version, restore it
          if (bestAnalysis && bestQuality > currentQuality + 2) {
            console.log(`    ✅ Found better version from commit ${bestCommit} (quality: ${bestQuality.toFixed(1)})`);
            
            // Preserve the current structure but use better content
            bestAnalysis.municipality = currentAnalysis.municipality;
            bestAnalysis.domain = currentAnalysis.domain;
            
            await fs.writeJson(analysisPath, bestAnalysis, { spaces: 2 });
            recoveredCount++;
            
            console.log(`    ✅ Restored better analysis for ${municDir}`);
          } else {
            console.log(`    ℹ️  No significantly better version found`);
          }
          
        } catch (error) {
          console.log(`    ❌ Git recovery failed: ${error.message}`);
        }
      } else {
        console.log(`  ✅ Quality acceptable (${currentQuality.toFixed(1)})`);
      }
      
    } catch (error) {
      console.error(`❌ ${municDir}: Error processing analysis - ${error.message}`);
    }
  }
  
  console.log(`\n🎉 Recovery complete! Restored ${recoveredCount} analyses with better content.`);
}

// Run the recovery
recoverBetterAnalyses().catch(console.error);