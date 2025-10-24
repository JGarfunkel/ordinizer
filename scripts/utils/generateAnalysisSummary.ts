#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";

interface AnalysisSummary {
  municipality: string;
  municipalityId: string;
  comprehensiveness: string;
  clarity: string;
  modernization: string;
  suggestionCategories: {
    alignmentGaps: number;
    bestPracticesFromOthers: number;
    potentialImprovements: number;
    modernizationOpportunities: number;
  };
  answersCount: number;
  highConfidenceAnswers: number;
}

async function generateAnalysisSummary(): Promise<void> {
  const treesDir = path.join(process.cwd(), 'data', 'trees');
  const municipalities = await fs.readdir(treesDir);
  const analyses: AnalysisSummary[] = [];
  
  for (const municipalityId of municipalities) {
    const analysisPath = path.join(treesDir, municipalityId, 'analysis.json');
    
    if (!(await fs.pathExists(analysisPath))) continue;
    
    try {
      const analysis = await fs.readJson(analysisPath);
      
      const highConfidenceCount = (analysis.answers || []).filter(
        (a: any) => a.confidence === 'high'
      ).length;
      
      const suggestions = analysis.suggestions || {};
      
      const summary: AnalysisSummary = {
        municipality: analysis.municipality,
        municipalityId: analysis.municipalityId,
        comprehensiveness: analysis.overallAssessment?.comprehensiveness || 'unknown',
        clarity: analysis.overallAssessment?.clarity || 'unknown',
        modernization: analysis.overallAssessment?.modernization || 'unknown',
        suggestionCategories: {
          alignmentGaps: (suggestions.alignmentGaps || []).length,
          bestPracticesFromOthers: (suggestions.bestPracticesFromOthers || []).length,
          potentialImprovements: (suggestions.potentialImprovements || []).length,
          modernizationOpportunities: (suggestions.modernizationOpportunities || []).length
        },
        answersCount: (analysis.answers || []).length,
        highConfidenceAnswers: highConfidenceCount
      };
      
      analyses.push(summary);
    } catch (error) {
      console.error(`Failed to process ${municipalityId}:`, error);
      continue;
    }
  }
  
  // Sort by municipality name
  analyses.sort((a, b) => a.municipality.localeCompare(b.municipality));
  
  const summaryData = {
    domain: "trees",
    generatedAt: new Date().toISOString(),
    totalMunicipalities: analyses.length,
    summaryStats: {
      comprehensiveness: {
        comprehensive: analyses.filter(a => a.comprehensiveness === 'comprehensive').length,
        moderate: analyses.filter(a => a.comprehensiveness === 'moderate').length,
        limited: analyses.filter(a => a.comprehensiveness === 'limited').length
      },
      clarity: {
        clear: analyses.filter(a => a.clarity === 'clear').length,
        moderate: analyses.filter(a => a.clarity === 'moderate').length,
        unclear: analyses.filter(a => a.clarity === 'unclear').length
      },
      modernization: {
        modern: analyses.filter(a => a.modernization === 'modern').length,
        dated: analyses.filter(a => a.modernization === 'dated').length,
        outdated: analyses.filter(a => a.modernization === 'outdated').length
      },
      totalSuggestions: analyses.reduce((sum, a) => 
        sum + Object.values(a.suggestionCategories).reduce((s, v) => s + v, 0), 0
      ),
      averageHighConfidenceAnswers: Math.round(
        analyses.reduce((sum, a) => sum + a.highConfidenceAnswers, 0) / analyses.length
      )
    },
    municipalities: analyses
  };
  
  const summaryPath = path.join(treesDir, 'analysis-summary.json');
  await fs.writeJson(summaryPath, summaryData, { spaces: 2 });
  
  console.log('\n🎉 Tree Analysis Summary Complete!');
  console.log(`- ${analyses.length} municipalities analyzed`);
  console.log(`- ${summaryData.summaryStats.totalSuggestions} total alignment suggestions generated`);
  console.log(`- Average ${summaryData.summaryStats.averageHighConfidenceAnswers} high-confidence answers per municipality`);
  console.log('\nComprehensiveness:');
  console.log(`  • Comprehensive: ${summaryData.summaryStats.comprehensiveness.comprehensive}`);
  console.log(`  • Moderate: ${summaryData.summaryStats.comprehensiveness.moderate}`);
  console.log(`  • Limited: ${summaryData.summaryStats.comprehensiveness.limited}`);
  console.log('\nModernization Status:');
  console.log(`  • Modern: ${summaryData.summaryStats.modernization.modern}`);
  console.log(`  • Dated: ${summaryData.summaryStats.modernization.dated}`);
  console.log(`  • Outdated: ${summaryData.summaryStats.modernization.outdated}`);
  console.log(`\nSummary saved to: ${summaryPath}`);
}

async function main(): Promise<void> {
  try {
    await generateAnalysisSummary();
  } catch (error) {
    console.error('Summary generation failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { generateAnalysisSummary };