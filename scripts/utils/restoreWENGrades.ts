#!/usr/bin/env tsx
import fs from 'fs-extra';
import path from 'path';

const DATA_DIR = './data/property-maintenance';

// Define WEN grades based on the original extraction
const wenGrades = {
  'NY-Ardsley-Village': { grade: 'Good', gradeColor: '#84cc16' },
  'NY-Bedford-Town': { grade: 'Yellow', gradeColor: '#eab308' },
  'NY-Bronxville-Village': { grade: 'Yellow', gradeColor: '#eab308' },
  'NY-Elmsford-Village': { grade: 'Red', gradeColor: '#ef4444' },
  'NY-Larchmont-Village': { grade: 'Red', gradeColor: '#ef4444' },
  'NY-MountVernon-City': { grade: 'Red', gradeColor: '#ef4444' },
  'NY-NewCastle-Town': { grade: 'Yellow', gradeColor: '#eab308' },
  'NY-NewRochelle-City': { grade: 'Red', gradeColor: '#ef4444' },
  'NY-Ossining-Town': { grade: 'Yellow', gradeColor: '#eab308' },
  'NY-SleepyHollow-Village': { grade: 'Yellow', gradeColor: '#eab308' }
};

async function restoreGrades(): Promise<void> {
  console.log('🎨 Restoring authentic WEN grades to Property Maintenance analyses...\n');

  let updated = 0;
  let errors = 0;

  for (const [municipalityId, gradeInfo] of Object.entries(wenGrades)) {
    try {
      const analysisFile = path.join(DATA_DIR, municipalityId, 'analysis.json');
      
      if (!await fs.pathExists(analysisFile)) {
        console.log(`⚠️ Analysis file not found for ${municipalityId}`);
        continue;
      }

      const analysis = await fs.readJson(analysisFile);
      
      // Update only the grade and gradeColor, preserve all other analysis content
      analysis.grade = gradeInfo.grade;
      analysis.gradeColor = gradeInfo.gradeColor;
      analysis.lastUpdated = new Date().toISOString();

      await fs.writeJson(analysisFile, analysis, { spaces: 2 });
      
      console.log(`✅ ${municipalityId}: ${gradeInfo.grade} (${gradeInfo.gradeColor})`);
      updated++;

    } catch (error) {
      console.error(`❌ Failed to update ${municipalityId}:`, error);
      errors++;
    }
  }

  console.log(`\n🎉 Grade restoration complete!`);
  console.log(`✅ Updated: ${updated} municipalities`);
  console.log(`❌ Errors: ${errors}`);
}

restoreGrades().catch(console.error);