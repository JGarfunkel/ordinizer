#!/usr/bin/env tsx
import { generatePropertyMaintenanceAnalysis } from './generatePropertyMaintenanceAnalysis.js';

// Test with just one municipality
async function test() {
  try {
    console.log('Testing property maintenance analysis generation...');
    await generatePropertyMaintenanceAnalysis('NY-NewCastle-Town');
    console.log('Test completed successfully!');
  } catch (error) {
    console.error('Test failed:', error);
  }
}

test();