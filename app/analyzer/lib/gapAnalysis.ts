// gapAnalysis.ts
// This file provides a mapping from gap keywords to improvement categories.
// The actual mapping data is loaded from gapAnalysis.json for domain flexibility.

import gapAnalysisMap from './gapAnalysis.json';

export function analyzeGapText(gapText: string): string[] {
  const results: string[] = [];
  const lowerGap = gapText.toLowerCase();
  for (const [category, keywords] of Object.entries(gapAnalysisMap)) {
    for (const keyword of keywords) {
      if (lowerGap.includes(keyword)) {
        results.push(category);
        break;
      }
    }
  }
  return results;
}
