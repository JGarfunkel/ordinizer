#!/usr/bin/env tsx

import { program } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { extractGoogleSheetsAsCsv, processSpreadsheetData } from './extractFromGoogleSheets.js';

// Import analyze functions
async function analyzeAllDomains(): Promise<void> {
  const domainsData = await fs.readJson('data/domains.json');
  const domains = domainsData.domains || [];
  
  console.log(`Found ${domains.length} domains to analyze`);
  
  for (const domain of domains) {
    console.log(`\n=== Analyzing domain: ${domain.displayName} ===`);
    
    try {
      // Import the analyze module dynamically
      const { main: analyzeDomain } = await import('./analyzeDomain.js');
      
      // Simulate command line args
      process.argv = ['node', 'analyzeDomain.js', domain.name, '--all'];
      await analyzeDomain();
    } catch (error) {
      console.error(`Failed to analyze domain ${domain.name}:`, error);
    }
  }
}

async function generateQuestionsForDomain(domainName: string): Promise<void> {
  console.log(`Generating questions for domain: ${domainName}`);
  
  try {
    const { main: analyzeDomain } = await import('./analyzeDomain.js');
    
    process.argv = ['node', 'analyzeDomain.js', domainName, '--generate-questions'];
    await analyzeDomain();
  } catch (error) {
    console.error(`Failed to generate questions for domain ${domainName}:`, error);
    throw error;
  }
}

async function analyzeStatutesForDomain(domainName: string): Promise<void> {
  console.log(`Analyzing statutes for domain: ${domainName}`);
  
  try {
    const { main: analyzeDomain } = await import('./analyzeDomain.js');
    
    process.argv = ['node', 'analyzeDomain.js', domainName, '--analyze'];
    await analyzeDomain();
  } catch (error) {
    console.error(`Failed to analyze statutes for domain ${domainName}:`, error);
    throw error;
  }
}

async function showStatus(): Promise<void> {
  console.log("=== Ordinizer Data Status ===\n");
  
  // Check municipalities
  const municipalitiesFile = 'data/municipalities.json';
  if (await fs.pathExists(municipalitiesFile)) {
    const municData = await fs.readJson(municipalitiesFile);
    console.log(`📍 Municipalities: ${municData.municipalities?.length || 0} loaded`);
    console.log(`   Last updated: ${municData.lastUpdated || 'Unknown'}`);
  } else {
    console.log("📍 Municipalities: Not loaded");
  }
  
  // Check domains
  const domainsFile = 'data/domains.json';
  if (await fs.pathExists(domainsFile)) {
    const domainsData = await fs.readJson(domainsFile);
    console.log(`📂 Domains: ${domainsData.domains?.length || 0} configured`);
    console.log(`   Last updated: ${domainsData.lastUpdated || 'Unknown'}`);
    
    // Check each domain for data
    for (const domain of domainsData.domains || []) {
      const domainPath = path.join('data', domain.name);
      const questionsFile = path.join(domainPath, 'questions.json');
      
      let statuteCount = 0;
      let analysisCount = 0;
      
      if (await fs.pathExists(domainPath)) {
        const entries = await fs.readdir(domainPath, { withFileTypes: true });
        
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('NY-')) {
            const statuteFile = path.join(domainPath, entry.name, 'statute.txt');
            const analysisFile = path.join(domainPath, entry.name, 'analysis.json');
            
            if (await fs.pathExists(statuteFile)) {
              statuteCount++;
            }
            
            if (await fs.pathExists(analysisFile)) {
              analysisCount++;
            }
          }
        }
      }
      
      const hasQuestions = await fs.pathExists(questionsFile);
      console.log(`   ${domain.displayName}: ${statuteCount} statutes, ${hasQuestions ? '✓' : '✗'} questions, ${analysisCount} analyses`);
    }
  } else {
    console.log("📂 Domains: Not configured");
  }
  
  console.log();
}

async function cleanData(options: { domain?: string; force?: boolean }): Promise<void> {
  if (!options.force) {
    console.log("This will delete generated data files. Use --force to confirm.");
    return;
  }
  
  if (options.domain) {
    const domainPath = path.join('data', options.domain);
    if (await fs.pathExists(domainPath)) {
      // Remove questions and analysis files but keep statutes
      const questionsFile = path.join(domainPath, 'questions.json');
      if (await fs.pathExists(questionsFile)) {
        await fs.remove(questionsFile);
        console.log(`Removed questions for domain: ${options.domain}`);
      }
      
      const entries = await fs.readdir(domainPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('NY-')) {
          const analysisFile = path.join(domainPath, entry.name, 'analysis.json');
          if (await fs.pathExists(analysisFile)) {
            await fs.remove(analysisFile);
          }
        }
      }
      console.log(`Cleaned analysis data for domain: ${options.domain}`);
    }
  } else {
    // Clean all generated data
    const domainsData = await fs.readJson('data/domains.json');
    for (const domain of domainsData.domains || []) {
      await cleanData({ domain: domain.name, force: true });
    }
    console.log("Cleaned all generated data");
  }
}

async function exportData(format: string): Promise<void> {
  console.log(`Exporting data in ${format} format...`);
  
  const municData = await fs.readJson('data/municipalities.json');
  const domainsData = await fs.readJson('data/domains.json');
  
  const exportData = {
    municipalities: municData.municipalities,
    domains: domainsData.domains,
    statutes: [],
    analyses: [],
    exportedAt: new Date().toISOString()
  };
  
  // Add statute and analysis data
  for (const domain of domainsData.domains || []) {
    const domainPath = path.join('data', domain.name);
    
    if (await fs.pathExists(domainPath)) {
      const entries = await fs.readdir(domainPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('NY-')) {
          const statuteFile = path.join(domainPath, entry.name, 'statute.txt');
          const analysisFile = path.join(domainPath, entry.name, 'analysis.json');
          
          if (await fs.pathExists(statuteFile)) {
            const content = await fs.readFile(statuteFile, 'utf-8');
            (exportData.statutes as any[]).push({
              municipality: entry.name,
              domain: domain.name,
              content: content.substring(0, 1000) + (content.length > 1000 ? '...' : ''),
              fullLength: content.length
            });
          }
          
          if (await fs.pathExists(analysisFile)) {
            const analysis = await fs.readJson(analysisFile);
            (exportData.analyses as any[]).push({
              municipality: entry.name,
              domain: domain.name,
              questionCount: analysis.length
            });
          }
        }
      }
    }
  }
  
  const exportFile = `civicdiff-export-${new Date().toISOString().split('T')[0]}.${format}`;
  
  if (format === 'json') {
    await fs.writeJson(exportFile, exportData, { spaces: 2 });
  } else if (format === 'csv') {
    // Simple CSV export of municipalities
    const csvContent = [
      'Name,Type,State,Domains',
      ...exportData.municipalities.map((m: any) => {
        const municipalityDomains = exportData.statutes
          .filter((s: any) => s.municipality.includes(m.name))
          .map((s: any) => s.domain);
        return `"${m.name}","${m.type}","${m.state}","${[...new Set(municipalityDomains)].join(';')}"`;
      })
    ].join('\n');
    
    await fs.writeFile(exportFile, csvContent);
  }
  
  console.log(`Exported to: ${exportFile}`);
}

// CLI Setup
program
  .name('civicdiff')
  .description('Ordinizer data management CLI')
  .version('1.0.0');

program
  .command('extract')
  .description('Extract data from Google Sheets or CSV file')
  .argument('<source>', 'Google Sheets URL or CSV file path')
  .action(async (source) => {
    try {
      let csvData: string;
      
      if (source.startsWith('http')) {
        csvData = await extractGoogleSheetsAsCsv(source);
      } else {
        csvData = await fs.readFile(source, 'utf-8');
      }
      
      await processSpreadsheetData(csvData);
      console.log("✅ Data extraction completed successfully!");
    } catch (error) {
      console.error("❌ Extraction failed:", error);
      process.exit(1);
    }
  });

program
  .command('generate')
  .description('Generate questions for a domain')
  .argument('<domain>', 'Domain name (trees, zoning, etc.)')
  .action(async (domain) => {
    try {
      await generateQuestionsForDomain(domain);
      console.log(`✅ Questions generated for domain: ${domain}`);
    } catch (error) {
      console.error("❌ Question generation failed:", error);
      process.exit(1);
    }
  });

program
  .command('analyze')
  .description('Analyze statutes for a domain')
  .argument('<domain>', 'Domain name (trees, zoning, etc.)')
  .action(async (domain) => {
    try {
      await analyzeStatutesForDomain(domain);
      console.log(`✅ Analysis completed for domain: ${domain}`);
    } catch (error) {
      console.error("❌ Analysis failed:", error);
      process.exit(1);
    }
  });

program
  .command('process')
  .description('Generate questions and analyze all domains')
  .action(async () => {
    try {
      await analyzeAllDomains();
      console.log("✅ All domains processed successfully!");
    } catch (error) {
      console.error("❌ Processing failed:", error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current data status')
  .action(async () => {
    await showStatus();
  });

program
  .command('clean')
  .description('Clean generated data (questions and analyses)')
  .option('-d, --domain <domain>', 'Clean specific domain only')
  .option('-f, --force', 'Force deletion without confirmation')
  .action(async (options) => {
    await cleanData(options);
  });

program
  .command('export')
  .description('Export all data')
  .option('-f, --format <format>', 'Export format (json, csv)', 'json')
  .action(async (options) => {
    await exportData(options.format);
  });

// Parse CLI arguments
program.parse();