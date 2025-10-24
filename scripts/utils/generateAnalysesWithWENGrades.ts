#!/usr/bin/env tsx
import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';
import { google } from 'googleapis';

// Initialize OpenAI - the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SPREADSHEET_URL = process.env.WEN_SPREADSHEET_URL;
const API_KEY = process.env.GOOGLE_SHEETS_API_KEY;

interface Question {
  id: number;
  text: string;
  category: string;
}

interface Answer {
  questionId: number;
  question: string;
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  relevantSections: string[];
}

interface Analysis {
  municipality: string;
  domain: string;
  grade: string;
  gradeColor: string;
  lastUpdated: string;
  answers: Answer[];
  alignmentSuggestions: {
    strengths: string[];
    improvements: string[];
    recommendations: string[];
    bestPractices: string[];
  };
}

interface WENGradeMapping {
  [municipalityId: string]: {
    grade: string;
    gradeColor: string;
  };
}

// WEN grade prefix to display name and color mapping
const GRADE_MAPPING = {
  'GG': { grade: 'Very Good', gradeColor: '#059669' }, // Dark green
  'G': { grade: 'Good', gradeColor: '#84cc16' },        // Light green  
  'Y': { grade: 'Yellow', gradeColor: '#eab308' },      // Yellow
  'R': { grade: 'Red', gradeColor: '#ef4444' },         // Red
  'X': { grade: 'Not Available', gradeColor: '#6b7280' } // Gray
};

function extractSpreadsheetId(url: string): string {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) {
    throw new Error('Invalid Google Sheets URL');
  }
  return match[1];
}

function parseGradeFromText(text: string): { grade: string; gradeColor: string } | null {
  if (!text) return null;
  
  // Check for grade prefixes at the start of URLs or text
  const prefixMatch = text.match(/^(GG|G|Y|R|X)-/);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    return GRADE_MAPPING[prefix] || null;
  }
  
  return null;
}

async function fetchWENGrades(domainName: string, columnName: string): Promise<WENGradeMapping> {
  try {
    if (!SPREADSHEET_URL || !API_KEY) {
      console.log('⚠️ Missing WEN credentials, using default grades');
      return {};
    }

    const spreadsheetId = extractSpreadsheetId(SPREADSHEET_URL);
    const sheets = google.sheets({ version: 'v4', auth: API_KEY });

    console.log(`📊 Fetching ${domainName} grades from WEN spreadsheet...`);

    // Load municipalities data for mapping
    const municipalitiesData = await fs.readJson('data/municipalities.json');
    const municipalityLookup = new Map();
    
    for (const muni of municipalitiesData.municipalities) {
      const simpleName = muni.name.toLowerCase().replace(/[^a-z]/g, '');
      municipalityLookup.set(simpleName, muni.id);
      municipalityLookup.set(muni.name.toLowerCase(), muni.id);
      municipalityLookup.set(`${muni.name.toLowerCase()} ${muni.type.toLowerCase()}`, muni.id);
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Ordinances!A:Z',
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) {
      throw new Error('No data found in spreadsheet');
    }

    const headerRow = rows[1];
    const columnIndex = headerRow.findIndex(header => 
      header && header.toLowerCase().includes(columnName.toLowerCase())
    );

    if (columnIndex === -1) {
      console.log(`⚠️ Column "${columnName}" not found, using default grades`);
      return {};
    }

    const gradeMapping: WENGradeMapping = {};
    let gradesFound = 0;

    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length <= columnIndex) continue;

      const municipalityName = row[0];
      const domainData = row[columnIndex];

      if (!municipalityName || !domainData) continue;

      const gradeInfo = parseGradeFromText(domainData);
      if (!gradeInfo) continue;

      let municipalityId = null;
      
      // Parse WEN format "Name (Type)"
      const parenMatch = municipalityName.match(/^(.+)\s*\((.+)\)$/);
      if (parenMatch) {
        const parsedName = parenMatch[1].trim();
        const typeText = parenMatch[2].trim();
        
        if (typeText.includes('/')) {
          const types = typeText.split('/');
          for (const type of types) {
            const testId = municipalityLookup.get(`${parsedName.toLowerCase()} ${type.trim().toLowerCase()}`);
            if (testId) {
              municipalityId = testId;
              break;
            }
          }
        } else {
          municipalityId = municipalityLookup.get(`${parsedName.toLowerCase()} ${typeText.toLowerCase()}`);
        }
      }

      if (municipalityId) {
        gradeMapping[municipalityId] = gradeInfo;
        gradesFound++;
      }
    }

    console.log(`📊 Extracted ${gradesFound} WEN grades for ${domainName}`);
    return gradeMapping;

  } catch (error) {
    console.error(`❌ Failed to fetch WEN grades for ${domainName}:`, error);
    return {};
  }
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateAnalysis(
  domainPath: string, 
  domainDisplayName: string,
  municipalityId: string,
  questions: Question[],
  wenGrades: WENGradeMapping
): Promise<void> {
  const statuteFile = path.join(domainPath, municipalityId, 'statute.txt');
  const metadataFile = path.join(domainPath, municipalityId, 'metadata.json');
  const analysisFile = path.join(domainPath, municipalityId, 'analysis.json');

  if (!await fs.pathExists(statuteFile) || !await fs.pathExists(metadataFile)) {
    console.log(`⚠️ Missing files for ${municipalityId}, skipping...`);
    return;
  }

  if (await fs.pathExists(analysisFile)) {
    console.log(`⚠️ Analysis already exists for ${municipalityId}, skipping...`);
    return;
  }

  const metadata = await fs.readJson(metadataFile);
  const municipality = `${metadata.municipalityName} - ${metadata.municipalityType}`;
  
  console.log(`🔍 Analyzing ${municipality} for ${domainDisplayName}...`);

  // Read statute (truncate for token limits)
  const fullStatute = await fs.readFile(statuteFile, 'utf-8');
  const truncatedStatute = fullStatute.substring(0, 8000);

  const analysisPrompt = `Analyze ${municipality} ${domainDisplayName.toLowerCase()} regulations. Answer these questions based on the statute excerpt below. If not clearly stated, say "not specified".

STATUTE EXCERPT:
${truncatedStatute}

QUESTIONS TO ANSWER:
${questions.map(q => `${q.id}. ${q.text}`).join('\n')}

Respond with JSON only:
{
  "answers": [
    {
      "questionId": ${questions[0]?.id || 1},
      "question": "question text",
      "answer": "brief answer",
      "confidence": "high|medium|low",
      "relevantSections": ["section references if found"]
    }
  ]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: analysisPrompt }],
      response_format: { type: "json_object" },
      max_tokens: 3000,
      temperature: 0.3
    });

    const aiAnalysis = JSON.parse(response.choices[0].message.content || '{}');
    const answers = aiAnalysis.answers || [];

    // Apply WEN grade if available
    const gradeInfo = wenGrades[municipalityId] || { grade: 'Not Graded', gradeColor: '#6b7280' };

    const analysis: Analysis = {
      municipality,
      domain: domainDisplayName,
      grade: gradeInfo.grade,
      gradeColor: gradeInfo.gradeColor,
      lastUpdated: new Date().toISOString(),
      answers,
      alignmentSuggestions: {
        strengths: [`Based on ${municipality} ${domainDisplayName.toLowerCase()} regulations`],
        improvements: ['Analysis based on partial statute excerpt'],
        recommendations: ['Full statute review recommended'],
        bestPractices: [`${domainDisplayName} standards implemented`]
      }
    };

    await fs.writeJson(analysisFile, analysis, { spaces: 2 });
    console.log(`✅ Created analysis for ${municipality} (Grade: ${gradeInfo.grade})`);

  } catch (error) {
    console.error(`❌ Failed to analyze ${municipality}:`, error.message);
  }
}

async function processDomain(domainId: string, domainDisplayName: string, wenColumnName: string): Promise<void> {
  console.log(`\n=== Processing ${domainDisplayName} ===`);
  
  const domainPath = path.join('data', domainId);
  const questionsFile = path.join(domainPath, 'questions.json');

  if (!await fs.pathExists(questionsFile)) {
    console.log(`⚠️ Questions file not found: ${questionsFile}`);
    return;
  }

  const questions: Question[] = await fs.readJson(questionsFile);
  console.log(`📋 Loaded ${questions.length} questions`);

  // Fetch WEN grades for this domain
  const wenGrades = await fetchWENGrades(domainDisplayName, wenColumnName);

  // Get municipality directories
  const municipalityDirs = await fs.readdir(domainPath);
  const validDirs = [];
  
  for (const dir of municipalityDirs) {
    const fullPath = path.join(domainPath, dir);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory() && dir.startsWith('NY-')) {
      validDirs.push(dir);
    }
  }

  console.log(`📁 Found ${validDirs.length} municipalities to analyze\n`);

  let analyzed = 0;
  let skipped = 0;

  for (const municipalityId of validDirs) {
    try {
      const startTime = Date.now();
      await generateAnalysis(domainPath, domainDisplayName, municipalityId, questions, wenGrades);
      
      const processingTime = Date.now() - startTime;
      if (processingTime > 1000) {
        analyzed++;
        // Rate limiting delay after AI calls
        if (municipalityId !== validDirs[validDirs.length - 1]) {
          console.log(`⏱️ Waiting 3 seconds...`);
          await delay(3000);
        }
      } else {
        skipped++;
      }
      
    } catch (error) {
      console.error(`❌ Error processing ${municipalityId}:`, error);
    }
  }

  console.log(`📊 ${domainDisplayName} - Analyzed: ${analyzed}, Skipped: ${skipped}`);
}

async function main(): Promise<void> {
  console.log('\n🌊 Wetland Protection Analysis Generator 🌊\n');

  try {
    const domains = [
      { id: 'wetland-protection', displayName: 'Wetland Protection', wenColumn: 'wetland' }
    ];

    for (const domain of domains) {
      await processDomain(domain.id, domain.displayName, domain.wenColumn);
    }

    console.log('\n🎉 Analysis generation complete! 🎉');

  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);