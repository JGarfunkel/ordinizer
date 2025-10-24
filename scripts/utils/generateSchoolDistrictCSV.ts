#!/usr/bin/env tsx

import { promises as fs } from 'fs';
import * as path from 'path';

interface PolicyEntry {
  category: string;
  policy_number: string | null;
  policy_title: string;
  policy_url: string;
  description: string;
}

interface SchoolDistrict {
  id: string;
  name: string;
  url: string;
  policies: PolicyEntry[];
}

function formatPolicyCell(policies: PolicyEntry[], category: string): string {
  const categoryPolicies = policies.filter(p => p.category === category);
  
  if (categoryPolicies.length === 0) {
    return '';
  }
  
  // For multiple policies in same category, separate with double newlines
  const policyContents = categoryPolicies.map(policy => {
    return [
      policy.policy_title || '',
      policy.policy_url || '',
      policy.description || ''
    ].join('\n');
  });
  
  const content = policyContents.join('\n\n');
  
  // Escape double quotes by doubling them and wrap the entire field in quotes
  return `"${content.replace(/"/g, '""')}"`;
}

function escapeCSVField(field: string): string {
  // If field contains comma, newline, or quotes, wrap in quotes and escape internal quotes
  if (field.includes(',') || field.includes('\n') || field.includes('"')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

async function generateCSV(): Promise<void> {
  try {
    console.log('🔄 Reading school district sustainability policies data...');
    
    // Read the JSON file
    const dataPath = path.join(process.cwd(), 'data', 'environmental-schools', 'school_district_sustainability_policies.json');
    const fileContent = await fs.readFile(dataPath, 'utf-8');
    const schoolDistricts: SchoolDistrict[] = JSON.parse(fileContent);
    
    console.log(`📊 Found ${schoolDistricts.length} school districts`);
    
    // Define CSV headers
    const headers = [
      'ID',
      'Name', 
      'url',
      'overall',
      'building',
      'curriculum', 
      'food',
      'gardens',
      'stormwater'
    ];
    
    // Start building CSV content
    const csvLines: string[] = [];
    
    // Add header row
    csvLines.push(headers.join(','));
    
    // Process each school district
    for (const district of schoolDistricts) {
      const row = [
        escapeCSVField(district.id || ''),
        escapeCSVField(district.name || ''),
        escapeCSVField(district.url || ''),
        formatPolicyCell(district.policies, 'overall'),
        formatPolicyCell(district.policies, 'building'),
        formatPolicyCell(district.policies, 'curriculum'),
        formatPolicyCell(district.policies, 'food'),
        formatPolicyCell(district.policies, 'gardens'),
        formatPolicyCell(district.policies, 'stormwater')
      ];
      
      csvLines.push(row.join(','));
    }
    
    // Write CSV file
    const csvContent = csvLines.join('\n');
    const outputPath = path.join(process.cwd(), 'data', 'environmental-schools', 'school_districts_export.csv');
    
    await fs.writeFile(outputPath, csvContent, 'utf-8');
    
    console.log(`✅ CSV file generated successfully: ${outputPath}`);
    console.log(`📈 Exported ${schoolDistricts.length} school districts with policy data`);
    
    // Show preview of first few lines
    console.log('\n📄 Preview (first 3 lines):');
    csvLines.slice(0, 3).forEach((line, index) => {
      console.log(`${index + 1}: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`);
    });
    
  } catch (error) {
    console.error('❌ Error generating CSV:', error);
    process.exit(1);
  }
}

// Handle direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  generateCSV().catch(console.error);
}

export { generateCSV };