import { getDefaultStorage } from "@civillyengaged/ordinizer-servercore";
import { generateMetaAnalysis } from "./createMetaAnalysis.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const domainId = process.argv[2] || 'trees';
  const storage = getDefaultStorage('data');
  generateMetaAnalysis(storage, domainId)
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Meta-analysis generation failed:', error);
      process.exit(1);
    });
}
