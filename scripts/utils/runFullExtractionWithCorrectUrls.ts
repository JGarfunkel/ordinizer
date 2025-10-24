#!/usr/bin/env tsx

import { spawn } from 'child_process';
import path from 'path';

async function runFullExtraction() {
  console.log('🚀 Running full extraction with corrected spreadsheet logic...');
  
  return new Promise((resolve, reject) => {
    const extractScript = spawn('tsx', ['extractFromGoogleSheets.ts'], {
      cwd: path.join(process.cwd()),
      stdio: 'inherit'
    });
    
    extractScript.on('close', (code) => {
      if (code === 0) {
        console.log('✅ Extraction completed successfully');
        resolve(code);
      } else {
        console.error(`❌ Extraction failed with code ${code}`);
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
}

runFullExtraction().catch(console.error);