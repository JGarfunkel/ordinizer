import fs from 'fs-extra';
import path from 'path';

interface Question {
  id: number;
  question: string;
  weight?: number;
}

interface AnalysisAnswer {
  id: number;
  question: string;
  answer: string;
  score: number; // 0.0 - 1.0
  confidence: number;
}

interface QuestionWithScore {
  id: number;
  question: string;
  answer: string;
  score: number; // Individual score 0.0 - 1.0
  weight: number; // Question weight (default 1)
  weightedScore: number; // score * weight
  maxWeightedScore: number; // weight (max possible for this question)
  confidence: number;
}

interface MunicipalityScore {
  municipalityId: string;
  domainId: string;
  questions: QuestionWithScore[];
  totalWeightedScore: number;
  totalPossibleWeight: number;
  overallScore: number; // 0.0 - 10.0
}

export async function calculateMunicipalityScore(
  municipalityId: string, 
  domainId: string,
  realmId?: string
): Promise<MunicipalityScore | null> {
  try {
    // Get realm-specific data path
    let dataPath = 'data/environmental-municipal'; // fallback
    if (realmId) {
      try {
        const realmsPath = path.join(process.cwd(), 'data', 'realms.json');
        if (await fs.pathExists(realmsPath)) {
          const realmsData = await fs.readJson(realmsPath);
          const realmConfig = realmsData.realms?.find((r: any) => r.id === realmId);
          if (realmConfig && realmConfig.datapath) {
            dataPath = `data/${realmConfig.datapath}`;
          }
        }
      } catch (error) {
        console.warn(`Could not load realm config for ${realmId}, using default path`);
      }
    }
    
    // Load questions for this domain
    const questionsPath = path.join(process.cwd(), dataPath, domainId, 'questions.json');
    if (!await fs.pathExists(questionsPath)) {
      console.error(`Questions file not found: ${questionsPath}`);
      return null;
    }

    const questionsData = await fs.readJson(questionsPath);
    const questions: Question[] = questionsData.questions || questionsData;

    // Load analysis for this municipality/domain
    const getMunicipalityDirectoryName = (municipalityId: string): string => {
      const mappings: { [key: string]: string } = {
        'NY-HastingsonHudson-Village': 'NY-Hastings-on-Hudson-Village',
        'NY-CrotononHudson-Village': 'NY-Croton-on-Hudson-Village',
        'NY-Scarsdale-TownVillage': 'NY-Scarsdale-Town',
        'NY-MountKisco-TownVillage': 'NY-MountKisco-Town',
        'NY-Harrison-TownVillage': 'NY-Harrison-Town'
      };
      return mappings[municipalityId] || municipalityId;
    };

    const directoryName = getMunicipalityDirectoryName(municipalityId);
    const analysisPath = path.join(process.cwd(), dataPath, domainId, directoryName, 'analysis.json');
    
    if (!await fs.pathExists(analysisPath)) {
      console.error(`Analysis file not found: ${analysisPath}`);
      return null;
    }

    const analysisData = await fs.readJson(analysisPath);
    const analysisQuestions = analysisData.questions || analysisData.answers || [];

    // Calculate weighted scores for each question
    const questionsWithScores: QuestionWithScore[] = [];
    let totalWeightedScore = 0;
    let totalPossibleWeight = 0;

    for (const question of questions) {
      // Find the corresponding analysis answer
      const analysisAnswer = analysisQuestions.find((a: any) => 
        (a.id === question.id || a.questionId === question.id)
      );

      const weight = question.weight || 1;
      const score = analysisAnswer?.score || 0.0;
      const weightedScore = score * weight;

      questionsWithScores.push({
        id: question.id,
        question: question.question,
        answer: analysisAnswer?.answer || "Not analyzed",
        score: score,
        weight: weight,
        weightedScore: weightedScore,
        maxWeightedScore: weight,
        confidence: analysisAnswer?.confidence || 0
      });

      totalWeightedScore += weightedScore;
      totalPossibleWeight += weight;
    }

    // Calculate overall score (0.0 - 10.0)
    const overallScore = totalPossibleWeight > 0 
      ? Math.round((totalWeightedScore / totalPossibleWeight) * 10 * 10) / 10
      : 0.0;

    return {
      municipalityId,
      domainId,
      questions: questionsWithScores,
      totalWeightedScore,
      totalPossibleWeight,
      overallScore
    };

  } catch (error) {
    console.error(`Error calculating municipality score for ${municipalityId}/${domainId}:`, error);
    return null;
  }
}

export function getScoreColor(score: number): string {
  // Green gradient from dark green (1.0) to light green (0.0)
  // Convert score (0.0-1.0) to green gradient
  const intensity = Math.max(0, Math.min(1, score));
  
  // Dark green: #22c55e (rgb(34, 197, 94))
  // Light green: #bbf7d0 (rgb(187, 247, 208))
  
  const darkGreen = { r: 34, g: 197, b: 94 };
  const lightGreen = { r: 187, g: 247, b: 208 };
  
  const r = Math.round(lightGreen.r + (darkGreen.r - lightGreen.r) * intensity);
  const g = Math.round(lightGreen.g + (darkGreen.g - lightGreen.g) * intensity);
  const b = Math.round(lightGreen.b + (darkGreen.b - lightGreen.b) * intensity);
  
  return `rgb(${r}, ${g}, ${b})`;
}

export function getScoreColorHex(score: number): string {
  // Same as above but returns hex color
  const intensity = Math.max(0, Math.min(1, score));
  
  const darkGreen = { r: 34, g: 197, b: 94 };
  const lightGreen = { r: 187, g: 247, b: 208 };
  
  const r = Math.round(lightGreen.r + (darkGreen.r - lightGreen.r) * intensity);
  const g = Math.round(lightGreen.g + (darkGreen.g - lightGreen.g) * intensity);
  const b = Math.round(lightGreen.b + (darkGreen.b - lightGreen.b) * intensity);
  
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// TODO delete this
export async function calculateDomainScoresUnused(domainId: string, realmId?: string): Promise<{ [municipalityId: string]: number }> {
  const scores: { [municipalityId: string]: number } = {};
  
  try {
    // Get realm-specific data path
    let dataPath = 'data/environmental-municipal'; // fallback
    if (realmId) {
      try {
        const realmsPath = path.join(process.cwd(), 'data', 'realms.json');
        if (await fs.pathExists(realmsPath)) {
          const realmsData = await fs.readJson(realmsPath);
          const realmConfig = realmsData.realms?.find((r: any) => r.id === realmId);
          if (realmConfig && realmConfig.datapath) {
            dataPath = `data/${realmConfig.datapath}`;
          }
        }
      } catch (error) {
        console.warn(`Could not load realm config for ${realmId}, using default path`);
      }
    }
    
    // Get all municipalities from the data folder
    const domainPath = path.join(process.cwd(), dataPath, domainId);
    if (!await fs.pathExists(domainPath)) {
      return scores;
    }

    const entries = await fs.readdir(domainPath);
    const municipalityDirs = entries.filter(entry => 
      entry.startsWith('NY-') && 
      !entry.endsWith('.json') && 
      !entry.endsWith('.csv')
    );

    for (const municipalityDir of municipalityDirs) {
      const municipalityScore = await calculateMunicipalityScore(municipalityDir, domainId, realmId);
      if (municipalityScore) {
        scores[municipalityDir] = municipalityScore.overallScore;
      }
    }

  } catch (error) {
    console.error(`Error calculating domain scores for ${domainId}:`, error);
  }

  return scores;
}