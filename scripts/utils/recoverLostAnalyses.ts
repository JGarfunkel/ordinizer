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

async function checkAndRecoverAnalyses(domain: string = 'property-maintenance') {
  console.log(`🔍 Checking ${domain} analyses for lost data...`);
  
  const domainDir = path.join(process.cwd(), '..', 'data', domain);
  if (!await fs.pathExists(domainDir)) {
    console.log(`❌ Domain directory ${domain} not found`);
    return;
  }
  
  const municipalities = await fs.readdir(domainDir);
  const problematicMunicipalities: string[] = [];
  let recoveredCount = 0;
  
  for (const municDir of municipalities) {
    if (municDir === 'questions.json' || !municDir.startsWith('NY-')) continue;
    
    const analysisPath = path.join(domainDir, municDir, 'analysis.json');
    if (!await fs.pathExists(analysisPath)) {
      console.log(`⚠️  ${municDir}: No analysis.json found`);
      continue;
    }
    
    try {
      const analysis: Analysis = await fs.readJson(analysisPath);
      
      // Count "Not specified in the statute" answers
      const notSpecifiedCount = analysis.questions?.filter(q => 
        q.answer === "Not specified in the statute."
      ).length || 0;
      
      const totalQuestions = analysis.questions?.length || 0;
      
      // If most/all answers are "Not specified", it might be a problem
      if (totalQuestions > 0 && notSpecifiedCount >= totalQuestions * 0.8) {
        problematicMunicipalities.push(municDir);
        console.log(`🚨 ${municDir}: ${notSpecifiedCount}/${totalQuestions} questions have "Not specified" answers`);
        
        // Try to recover from git history
        const gitPath = `data/${domain}/${municDir}/analysis.json`;
        try {
          console.log(`  🔄 Attempting to recover ${municDir} from git history...`);
          
          // Check if file exists in previous commits
          const commits = execSync(`git log --oneline --follow ${gitPath} | head -5`, 
            { encoding: 'utf-8', cwd: path.join(process.cwd(), '..') }).trim().split('\n');
          
          if (commits.length > 1) {
            // Try the previous commit
            const prevCommit = commits[1].split(' ')[0];
            const recoveredContent = execSync(`git show ${prevCommit}:${gitPath}`, 
              { encoding: 'utf-8', cwd: path.join(process.cwd(), '..') });
            
            const recoveredAnalysis: Analysis = JSON.parse(recoveredContent);
            const recoveredNotSpecified = recoveredAnalysis.questions?.filter(q => 
              q.answer === "Not specified in the statute."
            ).length || 0;
            
            // Only recover if the previous version was better
            if (recoveredNotSpecified < notSpecifiedCount) {
              await fs.writeJson(analysisPath, recoveredAnalysis, { spaces: 2 });
              console.log(`  ✅ Recovered ${municDir} from commit ${prevCommit} (${recoveredNotSpecified}/${recoveredAnalysis.questions?.length} not specified)`);
              recoveredCount++;
            } else {
              console.log(`  ⚠️  Previous version of ${municDir} was not better`);
            }
          } else {
            console.log(`  ❌ No previous versions found for ${municDir}`);
          }
        } catch (gitError) {
          console.log(`  ❌ Git recovery failed for ${municDir}:`, gitError.message);
        }
      } else if (notSpecifiedCount > 0) {
        console.log(`✅ ${municDir}: ${notSpecifiedCount}/${totalQuestions} not specified (acceptable)`);
      } else {
        console.log(`✅ ${municDir}: All questions have specific answers`);
      }
      
    } catch (error) {
      console.log(`❌ Failed to read ${municDir}/analysis.json:`, error.message);
    }
  }
  
  console.log(`\n📊 Summary:`);
  console.log(`  Municipalities checked: ${municipalities.length}`);
  console.log(`  Problematic analyses found: ${problematicMunicipalities.length}`);
  console.log(`  Successfully recovered: ${recoveredCount}`);
  
  if (problematicMunicipalities.length > 0) {
    console.log(`\n🚨 Municipalities with mostly "Not specified" answers:`);
    problematicMunicipalities.forEach(m => console.log(`  - ${m}`));
  }
  
  return { 
    checked: municipalities.length, 
    problematic: problematicMunicipalities.length, 
    recovered: recoveredCount 
  };
}

// Run the script if called directly
const domain = process.argv[2] || 'property-maintenance';
checkAndRecoverAnalyses(domain)
  .then(result => {
    console.log(`\n🎉 Recovery complete! ${result?.recovered || 0} analyses recovered.`);
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Recovery failed:', error);
    process.exit(1);
  });

export { checkAndRecoverAnalyses };