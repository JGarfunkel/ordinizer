import { downloadAndProcessSource } from "../lib/sourceDownloader";
import { setVerboseMode } from "../lib/extractionConfig";

// Integration test for downloadAndProcessSource
// Run with: npx jest tests/integration.downloadAndProcessSource.test.ts

describe('Mock Server Route Tests', () => {
  setVerboseMode(true); // Enable verbose logging for this test suite
  it('should download and process source for a specific entity', async () => {

  await downloadAndProcessSource("westchester-municipal-environmental", "wetland-protection", "NY-Bedford-Town");

}, 60000); // Set timeout to 60 seconds for this test
});
