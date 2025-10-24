#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

interface SectionMapping {
  municipalityId: string;
  domain: string;
  sourceUrl: string;
  sectionNumber: string;
  anchorId: string;
  sectionUrl: string;
}

async function extractSectionMappings(): Promise<SectionMapping[]> {
  const mappings: SectionMapping[] = [];
  const dataDir = path.join(process.cwd(), 'data');
  
  // Get all domain directories
  const domains = await fs.readdir(dataDir);
  const domainDirs = domains.filter(async (dir) => {
    const stat = await fs.stat(path.join(dataDir, dir));
    return stat.isDirectory() && !['municipalities.json', 'westchester-boundaries.json'].includes(dir);
  });

  for (const domain of domainDirs) {
    const domainPath = path.join(dataDir, domain);
    
    // Skip files, only process directories
    const stat = await fs.stat(domainPath);
    if (!stat.isDirectory()) continue;
    
    console.log(`Processing domain: ${domain}`);
    
    // Get all municipality directories in this domain
    const municipalities = await fs.readdir(domainPath);
    const municipalityDirs = municipalities.filter(async (dir) => {
      const municipalityPath = path.join(domainPath, dir);
      const stat = await fs.stat(municipalityPath);
      return stat.isDirectory();
    });

    for (const municipalityId of municipalityDirs) {
      const municipalityPath = path.join(domainPath, municipalityId);
      const htmlPath = path.join(municipalityPath, 'statute.html');
      const metadataPath = path.join(municipalityPath, 'metadata.json');
      
      // Check if both HTML and metadata files exist
      if (!(await fs.pathExists(htmlPath)) || !(await fs.pathExists(metadataPath))) {
        console.log(`Skipping ${municipalityId} in ${domain} - missing files`);
        continue;
      }

      try {
        // Read metadata to get source URL
        const metadata = await fs.readJson(metadataPath);
        const sourceUrl = metadata.sourceUrl;
        
        if (!sourceUrl) {
          console.log(`No source URL found for ${municipalityId} in ${domain}`);
          continue;
        }

        // Read HTML file
        const htmlContent = await fs.readFile(htmlPath, 'utf-8');
        
        // Extract section mappings using regex
        // Pattern: § followed by section number, with corresponding anchor ID
        const sectionRegex = /<div[^>]+id="(\d+)"[^>]*>[\s\S]*?§\s*(\d+(?:-\d+)*)/g;
        
        let match;
        while ((match = sectionRegex.exec(htmlContent)) !== null) {
          const anchorId = match[1];
          const sectionNumber = match[2];
          
          mappings.push({
            municipalityId,
            domain,
            sourceUrl,
            sectionNumber: `§ ${sectionNumber}`,
            anchorId,
            sectionUrl: `${sourceUrl}#${anchorId}`
          });
        }

        console.log(`Extracted ${mappings.filter(m => m.municipalityId === municipalityId && m.domain === domain).length} sections for ${municipalityId} in ${domain}`);

      } catch (error) {
        console.error(`Error processing ${municipalityId} in ${domain}:`, error);
      }
    }
  }

  return mappings;
}

async function main() {
  try {
    console.log('Starting statute section index creation...');
    
    const mappings = await extractSectionMappings();
    
    console.log(`Total section mappings extracted: ${mappings.length}`);
    
    // Convert to CSV format
    const csvData = mappings.map(mapping => [
      mapping.municipalityId,
      mapping.domain,
      mapping.sourceUrl,
      mapping.sectionNumber,
      mapping.anchorId,
      mapping.sectionUrl
    ]);
    
    // Add header
    const csvContent = [
      ['municipalityId', 'domain', 'sourceUrl', 'sectionNumber', 'anchorId', 'sectionUrl'],
      ...csvData
    ];
    
    // Write CSV file
    const outputPath = path.join(process.cwd(), 'data', 'statuteSectionIndex.csv');
    const csvString = csvContent.map(row => 
      row.map(field => 
        typeof field === 'string' && field.includes(',') ? `"${field}"` : field
      ).join(',')
    ).join('\n');
    
    await fs.writeFile(outputPath, csvString);
    
    console.log(`Statute section index created: ${outputPath}`);
    console.log(`Total sections indexed: ${mappings.length}`);
    
    // Show some examples
    console.log('\nExample entries:');
    mappings.slice(0, 5).forEach(mapping => {
      console.log(`${mapping.municipalityId}/${mapping.domain}: ${mapping.sectionNumber} -> ${mapping.sectionUrl}`);
    });

  } catch (error) {
    console.error('Error creating statute section index:', error);
    process.exit(1);
  }
}

main();