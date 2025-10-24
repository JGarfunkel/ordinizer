#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

const REMAINING_CORRUPTED = [
  'NY-Buchanan-Village',
  'NY-Cortlandt-Town', 
  'NY-Hastings-on-Hudson-Village',
  'NY-Mamaroneck-Town',
  'NY-MountKisco-Town'
];

async function clearCorruptionFlags() {
  console.log('🧹 Clearing corruption flags and updating analysis files...');
  
  const domain = 'property-maintenance';
  
  for (const municipalityId of REMAINING_CORRUPTED) {
    const municipalityPath = path.join(process.cwd(), '..', 'data', domain, municipalityId);
    const analysisPath = path.join(municipalityPath, 'analysis.json');
    const flagPath = path.join(municipalityPath, 'CORRUPTED_STATUTE.flag');
    
    // Remove flag file
    if (await fs.pathExists(flagPath)) {
      await fs.remove(flagPath);
      console.log(`✅ ${municipalityId}: Removed corruption flag`);
    }
    
    // Update analysis file
    if (await fs.pathExists(analysisPath)) {
      try {
        const analysis = await fs.readJson(analysisPath);
        
        // Remove corruption markers
        delete analysis.corruptedStatute;
        delete analysis.lastCorruptionCheck;
        
        // Update processing note
        analysis.processingNote = "Statute file requires manual download due to eCode360 anti-bot protection. Automated analysis pending manual statute acquisition.";
        analysis.lastUpdated = new Date().toISOString();
        
        await fs.writeJson(analysisPath, analysis, { spaces: 2 });
        console.log(`✅ ${municipalityId}: Updated analysis file`);
        
      } catch (error) {
        console.error(`❌ ${municipalityId}: Failed to update analysis - ${error.message}`);
      }
    }
  }
  
  console.log('🎉 Corruption flags cleared!');
}

clearCorruptionFlags().catch(console.error);