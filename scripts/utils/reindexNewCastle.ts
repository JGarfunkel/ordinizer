#!/usr/bin/env tsx

import { VectorService } from '../server/services/vectorService.js';
import fs from 'fs-extra';

async function reindexNewCastle() {
  try {
    console.log('🔄 Re-indexing NewCastle trees with cleaned statute content...\n');
    
    const vs = new VectorService();
    const statuteContent = await fs.readFile('data/trees/NY-NewCastle-Town/statute.txt', 'utf-8');
    
    console.log('📊 Statute file stats:');
    console.log(`   • Length: ${statuteContent.length} characters`);
    console.log(`   • Word count: ${statuteContent.split(' ').length} words`);
    
    // Check for navigation patterns
    console.log('\n🔍 Checking for navigation patterns in local file:');
    const navPatterns = ['email', 'Email', 'share', 'Share', 'arrow_', 'add_alert', 'download', 'Download'];
    let hasNavigation = false;
    
    navPatterns.forEach(pattern => {
      if (statuteContent.includes(pattern)) {
        console.log(`   ❌ Found: ${pattern}`);
        hasNavigation = true;
      } else {
        console.log(`   ✅ Clean: ${pattern}`);
      }
    });
    
    if (hasNavigation) {
      console.log('\n⚠️  Local file still contains navigation content! Cannot proceed.');
      return;
    }
    
    console.log('\n✅ Local file is clean of navigation content');
    
    // Show first part of content to verify quality
    console.log('\n📄 First 400 characters of statute:');
    console.log(statuteContent.substring(0, 400));
    console.log('...\n');
    
    // Re-index in vector database
    console.log('🔄 Deleting old vector chunks and re-indexing...');
    await vs.indexStatute('NY-NewCastle-Town', 'trees', statuteContent);
    console.log('✅ Re-indexing complete!\n');
    
    // Test vector search
    console.log('🔍 Testing vector search with cleaned data...');
    const results = await vs.searchRelevantSections(
      'NY-NewCastle-Town', 
      'trees', 
      'Do I need a permit to remove a tree on my private property', 
      3
    );
    
    console.log(`Found ${results.length} results:`);
    results.forEach((r, i) => {
      console.log(`\n${i+1}. Score: ${r.score.toFixed(3)} | Section: ${r.section || 'N/A'}`);
      console.log(`   Content: ${r.content.substring(0, 200)}...`);
      
      // Check if this result contains navigation
      const hasNav = navPatterns.some(pattern => r.content.includes(pattern));
      if (hasNav) {
        console.log('   ❌ Still contains navigation!');
      } else {
        console.log('   ✅ Clean content');
      }
    });
    
    console.log('\n🎉 NewCastle re-indexing complete!');
    
  } catch (error) {
    console.error('❌ Error re-indexing NewCastle:', error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reindexNewCastle();
}