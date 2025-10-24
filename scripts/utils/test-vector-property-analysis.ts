#!/usr/bin/env tsx
import { generateVectorBasedPropertyAnalysis } from './generateVectorBasedPropertyAnalysis.js';

// Test with the municipality we just indexed
async function test() {
  try {
    console.log('Testing vector-based property maintenance analysis generation...');
    await generateVectorBasedPropertyAnalysis('NY-NewCastle-Town');
    console.log('Test completed successfully!');
  } catch (error) {
    console.error('Test failed:', error);
  }
}

test();