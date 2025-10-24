#!/usr/bin/env tsx

import fs from 'fs/promises';
import path from 'path';

async function regeneratePropertyMaintenanceAnalysis() {
  console.log('🔄 Regenerating Property Maintenance Analysis...');
  
  const propertyMaintenanceDir = path.join(process.cwd(), '..', 'data', 'property-maintenance');
  const questionsPath = path.join(propertyMaintenanceDir, 'questions.json');
  
  // Read questions
  const questionsData = JSON.parse(await fs.readFile(questionsPath, 'utf-8'));
  const questions = questionsData.questions;
  
  // Get all municipality directories
  const municipalities = await fs.readdir(propertyMaintenanceDir);
  const municDirs = municipalities.filter(name => name.startsWith('NY-') && name !== 'NY-State');
  
  console.log(`Processing ${municDirs.length} municipalities...`);
  
  for (const municDir of municDirs) {
    const municPath = path.join(propertyMaintenanceDir, municDir);
    const metadataPath = path.join(municPath, 'metadata.json');
    const analysisPath = path.join(municPath, 'analysis.json');
    
    try {
      // Check if metadata exists
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
      const isStateCode = metadata.stateCodeApplies === true;
      
      // Create analysis based on whether it's state code or local
      const analysis = {
        municipality: {
          id: municDir,
          displayName: `${metadata.municipalityName} - ${metadata.municipalityType}`
        },
        domain: {
          id: "property-maintenance",
          displayName: "Property Maintenance"
        },
        questions: questions.map((q: any) => ({
          id: q.id,
          question: q.text,
          answer: isStateCode 
            ? "No local ordinance; state code applies. See New York State Property Maintenance Code for detailed requirements."
            : "Not specified in the statute.",
          confidence: isStateCode ? 100 : 0,
          sourceRefs: isStateCode ? ["NY State Property Maintenance Code"] : []
        })),
        lastUpdated: new Date().toISOString(),
        processingMethod: "state-code-detection",
        usesStateCode: isStateCode
      };
      
      // Write analysis
      await fs.writeFile(analysisPath, JSON.stringify(analysis, null, 2));
      
      const status = isStateCode ? 'STATE CODE' : 'LOCAL ORDINANCE';
      console.log(`✅ ${municDir}: ${status}`);
      
    } catch (error) {
      console.error(`❌ Failed to process ${municDir}:`, error.message);
    }
  }
  
  // Create NY-State analysis
  const stateAnalysis = {
    municipality: {
      id: "NY-State",
      displayName: "New York - State"
    },
    domain: {
      id: "property-maintenance",
      displayName: "Property Maintenance"
    },
    questions: questions.map((q: any) => ({
      id: q.id,
      question: q.text,
      answer: "This is the New York State Property Maintenance Code that applies to municipalities without local ordinances.",
      confidence: 100,
      sourceRefs: ["NY State Property Maintenance Code"]
    })),
    lastUpdated: new Date().toISOString(),
    processingMethod: "state-code-reference",
    isStateCode: true
  };
  
  const stateAnalysisPath = path.join(propertyMaintenanceDir, 'NY-State', 'analysis.json');
  await fs.writeFile(stateAnalysisPath, JSON.stringify(stateAnalysis, null, 2));
  console.log('✅ NY-State: STATE CODE REFERENCE');
  
  console.log('🎉 Property Maintenance analysis regeneration complete!');
}

// Run the function
regeneratePropertyMaintenanceAnalysis().catch(console.error);