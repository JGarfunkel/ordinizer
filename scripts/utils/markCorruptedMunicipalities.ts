#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

const corruptedMunicipalities = [
  'NY-Buchanan-Village',
  'NY-Cortlandt-Town', 
  'NY-Hastings-on-Hudson-Village',
  'NY-Lewisboro-Town',
  'NY-Mamaroneck-Town',
  'NY-MountKisco-Town',
  'NY-Pelham-Town'
];

async function markCorruptedMunicipalities() {
  console.log('🔧 Marking corrupted municipalities...');
  
  const domain = 'property-maintenance';
  
  for (const municipalityId of corruptedMunicipalities) {
    const municipalityPath = path.join(process.cwd(), '..', 'data', domain, municipalityId);
    const analysisPath = path.join(municipalityPath, 'analysis.json');
    
    if (await fs.pathExists(analysisPath)) {
      try {
        const analysis = await fs.readJson(analysisPath);
        
        // Clear questions and add processing note
        analysis.questions = [];
        analysis.processingNote = "Statute file corrupted (contains HTML login page instead of statute content). Analysis cannot be generated until statute is re-downloaded from source.";
        analysis.corruptedStatute = true;
        analysis.lastCorruptionCheck = new Date().toISOString();
        
        await fs.writeJson(analysisPath, analysis, { spaces: 2 });
        console.log(`✅ ${municipalityId}: Marked as corrupted`);
        
      } catch (error) {
        console.error(`❌ ${municipalityId}: Failed to update analysis - ${error.message}`);
      }
    } else {
      // Create new analysis file marking corruption
      const newAnalysis = {
        municipality: {
          id: municipalityId,
          displayName: municipalityId.replace('NY-', '').replace('-', ' ')
        },
        domain: {
          id: domain,
          displayName: "Property Maintenance"
        },
        questions: [],
        processingNote: "Statute file corrupted (contains HTML login page instead of statute content). Analysis cannot be generated until statute is re-downloaded from source.",
        corruptedStatute: true,
        lastCorruptionCheck: new Date().toISOString()
      };
      
      await fs.writeJson(analysisPath, newAnalysis, { spaces: 2 });
      console.log(`✅ ${municipalityId}: Created corrupted analysis marker`);
    }
  }
  
  console.log(`\n📊 Summary:`);
  console.log(`- ${corruptedMunicipalities.length} municipalities have corrupted statute files`);
  console.log(`- These need to be re-downloaded from their original eCode360 sources`);
  console.log(`- Analysis generation will be skipped until statutes are fixed`);
}

markCorruptedMunicipalities().catch(console.error);