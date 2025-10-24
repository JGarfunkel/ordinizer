#!/usr/bin/env tsx

import fs from "fs-extra";
import path from "path";

interface AnalysisData {
  questions?: any[];
  [key: string]: any;
}

interface RestoreStats {
  checked: number;
  missing: number;
  emptyQuestions: number;
  emptyAnswers: number;
  restored: number;
  errors: number;
}

function getProjectDataDir(): string {
  return path.resolve(process.cwd(), "data");
}

async function findLatestBackup(municipalityDir: string): Promise<string | null> {
  try {
    const files = await fs.readdir(municipalityDir);
    const backupFiles = files
      .filter(f => f.startsWith('analysis-backup-') && f.endsWith('.json'))
      .sort()
      .reverse(); // Get most recent first

    return backupFiles.length > 0 ? path.join(municipalityDir, backupFiles[0]) : null;
  } catch (error) {
    return null;
  }
}

async function validateAnalysis(analysisPath: string): Promise<{ isValid: boolean; reason?: string }> {
  try {
    if (!(await fs.pathExists(analysisPath))) {
      return { isValid: false, reason: "Missing file" };
    }

    const analysis: AnalysisData = await fs.readJson(analysisPath);
    
    if (!analysis.questions || !Array.isArray(analysis.questions)) {
      return { isValid: false, reason: "Missing or invalid questions field" };
    }

    if (analysis.questions.length === 0) {
      return { isValid: false, reason: "Empty questions array" };
    }

    // Check if questions have empty answers
    const emptyAnswers = analysis.questions.filter(q => !q.answer || q.answer.trim() === '');
    if (emptyAnswers.length === analysis.questions.length) {
      return { isValid: false, reason: "All questions have empty answers" };
    }

    return { isValid: true };
  } catch (error) {
    return { isValid: false, reason: `Parse error: ${error.message}` };
  }
}

async function restoreFromBackup(analysisPath: string, backupPath: string): Promise<boolean> {
  try {
    const backupData = await fs.readJson(backupPath);
    const backupValidation = await validateAnalysis(backupPath);
    
    if (!backupValidation.isValid) {
      console.log(`    ⚠️  Backup is also invalid: ${backupValidation.reason}`);
      return false;
    }

    await fs.copy(backupPath, analysisPath);
    console.log(`    ✅ Restored from backup: ${path.basename(backupPath)}`);
    return true;
  } catch (error) {
    console.log(`    ❌ Failed to restore from backup: ${error.message}`);
    return false;
  }
}

async function processMunicipality(municipalityDir: string, municipalityName: string): Promise<{ restored: boolean; reason?: string }> {
  const analysisPath = path.join(municipalityDir, 'analysis.json');
  const validation = await validateAnalysis(analysisPath);

  if (validation.isValid) {
    return { restored: false };
  }

  console.log(`  ❌ ${municipalityName}: ${validation.reason}`);

  // Look for backup
  const backupPath = await findLatestBackup(municipalityDir);
  if (!backupPath) {
    console.log(`    ⚠️  No backup file found`);
    return { restored: false, reason: "No backup available" };
  }

  console.log(`    🔍 Found backup: ${path.basename(backupPath)}`);
  
  // Compare current with backup (if current exists)
  if (await fs.pathExists(analysisPath)) {
    try {
      const currentData = await fs.readJson(analysisPath);
      const backupData = await fs.readJson(backupPath);
      
      if (JSON.stringify(currentData) === JSON.stringify(backupData)) {
        console.log(`    ℹ️  Current and backup are identical`);
        return { restored: false, reason: "Backup identical to current" };
      }
    } catch (error) {
      // If current file is corrupted, proceed with restore
    }
  }

  const restored = await restoreFromBackup(analysisPath, backupPath);
  return { restored, reason: restored ? "Restored from backup" : "Restore failed" };
}

async function processDomain(realmDir: string, domain: string): Promise<RestoreStats> {
  const stats: RestoreStats = {
    checked: 0,
    missing: 0,
    emptyQuestions: 0,
    emptyAnswers: 0,
    restored: 0,
    errors: 0
  };

  const domainDir = path.join(realmDir, domain);
  
  if (!(await fs.pathExists(domainDir))) {
    console.log(`⚠️  Domain directory not found: ${domain}`);
    return stats;
  }

  console.log(`\n📂 Processing domain: ${domain}`);
  
  const municipalities = await fs.readdir(domainDir);
  const municipalityDirs = municipalities.filter(m => m.startsWith('NY-'));

  for (const municipalityDir of municipalityDirs) {
    const municipalityPath = path.join(domainDir, municipalityDir);
    const municipalityStat = await fs.stat(municipalityPath);
    
    if (!municipalityStat.isDirectory()) continue;

    const municipalityName = municipalityDir.replace(/^NY-/, '').replace(/-/g, ' ');
    stats.checked++;

    try {
      const result = await processMunicipality(municipalityPath, municipalityName);
      if (result.restored) {
        stats.restored++;
      } else if (result.reason === "Missing file") {
        stats.missing++;
      } else if (result.reason?.includes("questions")) {
        stats.emptyQuestions++;
      } else if (result.reason?.includes("answers")) {
        stats.emptyAnswers++;
      }
    } catch (error) {
      console.log(`  ❌ ${municipalityName}: Error processing - ${error.message}`);
      stats.errors++;
    }
  }

  return stats;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const realmId = args.find(arg => arg.startsWith('--realm='))?.split('=')[1] || 'westchester-municipal-environmental';
  const domainsArg = args.find(arg => arg.startsWith('--domains='))?.split('=')[1];
  const domains = domainsArg ? domainsArg.split(',') : ['glb', 'trees', 'weeds', 'wetland-protection'];

  console.log(`🔧 Analysis Recovery Utility`);
  console.log(`Realm: ${realmId}`);
  console.log(`Domains: ${domains.join(', ')}`);

  const realmDir = path.join(getProjectDataDir(), 'environmental-municipal'); // Map realm to data path
  
  if (!(await fs.pathExists(realmDir))) {
    console.error(`❌ Realm directory not found: ${realmDir}`);
    process.exit(1);
  }

  const totalStats: RestoreStats = {
    checked: 0,
    missing: 0,
    emptyQuestions: 0,
    emptyAnswers: 0,
    restored: 0,
    errors: 0
  };

  for (const domain of domains) {
    const domainStats = await processDomain(realmDir, domain);
    
    totalStats.checked += domainStats.checked;
    totalStats.missing += domainStats.missing;
    totalStats.emptyQuestions += domainStats.emptyQuestions;
    totalStats.emptyAnswers += domainStats.emptyAnswers;
    totalStats.restored += domainStats.restored;
    totalStats.errors += domainStats.errors;

    console.log(`📊 ${domain} summary:`);
    console.log(`  - Checked: ${domainStats.checked}`);
    console.log(`  - Restored: ${domainStats.restored}`);
    if (domainStats.missing > 0) console.log(`  - Missing: ${domainStats.missing}`);
    if (domainStats.emptyQuestions > 0) console.log(`  - Empty questions: ${domainStats.emptyQuestions}`);
    if (domainStats.emptyAnswers > 0) console.log(`  - Empty answers: ${domainStats.emptyAnswers}`);
    if (domainStats.errors > 0) console.log(`  - Errors: ${domainStats.errors}`);
  }

  console.log(`\n📋 Overall Summary:`);
  console.log(`✅ Total municipalities checked: ${totalStats.checked}`);
  console.log(`🔄 Successfully restored: ${totalStats.restored}`);
  console.log(`❌ Issues found:`);
  console.log(`  - Missing files: ${totalStats.missing}`);
  console.log(`  - Empty questions: ${totalStats.emptyQuestions}`);
  console.log(`  - Empty answers: ${totalStats.emptyAnswers}`);
  console.log(`  - Processing errors: ${totalStats.errors}`);

  if (totalStats.restored > 0) {
    console.log(`\n🎉 Restored ${totalStats.restored} analysis files from backups!`);
  } else {
    console.log(`\nℹ️  No files needed restoration.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("❌ Script failed:", error);
    process.exit(1);
  });
}