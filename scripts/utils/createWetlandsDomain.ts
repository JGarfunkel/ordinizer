#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

async function createWetlandsDomain() {
  const wetlandsMunicipalities = [
    'NY-BriarcliffManor-Village',
    'NY-Cortlandt-Town', 
    'NY-Mamaroneck-Village',
    'NY-MountPleasant-Town',
    'NY-Peekskill-City'
  ];

  // Create wetlands domain directory
  const wetlandsDir = path.join(process.cwd(), 'data', 'wetlands');
  await fs.ensureDir(wetlandsDir);

  console.log('Creating wetlands domain structure...');

  // Process each municipality that has wetlands regulations
  for (const municipalityId of wetlandsMunicipalities) {
    console.log(`Processing ${municipalityId}...`);
    
    // Find the source domain where this municipality exists with wetlands references
    const sourceDomains = ['cac-cb-etc', 'cluster-zoning', 'solar-1'];
    let sourceFound = false;
    
    for (const sourceDomain of sourceDomains) {
      const sourcePath = path.join(process.cwd(), 'data', sourceDomain, municipalityId);
      
      if (await fs.pathExists(sourcePath)) {
        const statutePath = path.join(sourcePath, 'statute.txt');
        const metadataPath = path.join(sourcePath, 'metadata.json');
        
        if (await fs.pathExists(statutePath)) {
          const statuteContent = await fs.readFile(statutePath, 'utf-8');
          
          // Check if this statute contains wetlands references
          if (statuteContent.toLowerCase().includes('wetland')) {
            console.log(`Found wetlands content in ${municipalityId} (${sourceDomain})`);
            
            // Create municipality directory in wetlands domain
            const wetlandsMuniDir = path.join(wetlandsDir, municipalityId);
            await fs.ensureDir(wetlandsMuniDir);
            
            // Extract wetlands-specific content
            const wetlandsContent = extractWetlandsContent(statuteContent);
            
            // Copy relevant files
            await fs.writeFile(path.join(wetlandsMuniDir, 'statute.txt'), wetlandsContent);
            
            if (await fs.pathExists(metadataPath)) {
              const metadata = await fs.readJson(metadataPath);
              // Update metadata for wetlands domain
              metadata.domain = 'Wetlands';
              metadata.originalDomain = sourceDomain;
              await fs.writeJson(path.join(wetlandsMuniDir, 'metadata.json'), metadata, { spaces: 2 });
            }
            
            sourceFound = true;
            break;
          }
        }
      }
    }
    
    if (!sourceFound) {
      console.log(`No wetlands content found for ${municipalityId}`);
    }
  }

  console.log('Wetlands domain creation completed.');
}

function extractWetlandsContent(fullContent: string): string {
  // Extract sections that specifically relate to wetlands
  const lines = fullContent.split('\n');
  const wetlandsLines: string[] = [];
  
  // Look for wetlands-specific sections
  let inWetlandsSection = false;
  let currentSection = '';
  
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    
    // Check for wetlands-related headers or sections
    if (lowerLine.includes('wetland') || 
        lowerLine.includes('chapter 122') ||
        lowerLine.includes('water resource') ||
        lowerLine.includes('stream buffer') ||
        lowerLine.includes('aquatic') ||
        lowerLine.includes('waterway')) {
      inWetlandsSection = true;
      currentSection = line;
      wetlandsLines.push(line);
    } 
    // Continue collecting lines if we're in a wetlands section
    else if (inWetlandsSection) {
      wetlandsLines.push(line);
      
      // Stop collecting if we hit a new major section that's not wetlands-related
      if (line.startsWith('Chapter') && !lowerLine.includes('wetland')) {
        inWetlandsSection = false;
      }
    }
  }
  
  // If no specific wetlands sections found, extract lines containing wetlands references
  if (wetlandsLines.length === 0) {
    for (const line of lines) {
      if (line.toLowerCase().includes('wetland')) {
        wetlandsLines.push(line);
      }
    }
  }
  
  return wetlandsLines.join('\n').trim() || fullContent; // Fall back to full content if extraction fails
}

async function main() {
  try {
    await createWetlandsDomain();
  } catch (error) {
    console.error('Error creating wetlands domain:', error);
    process.exit(1);
  }
}

main();