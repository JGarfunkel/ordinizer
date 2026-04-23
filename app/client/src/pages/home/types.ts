/** Shared types used across the home page sub-components. */

export interface ScoreQuestion {
  id: number;
  question: string;
  answer: string;
  score: number;
  weight: number;
  weightedScore: number;
  maxWeightedScore: number;
  confidence: number;
}

export interface ScoreData {
  entityId: string;
  domainId: string;
  questions: ScoreQuestion[];
  totalWeightedScore: number;
  totalPossibleWeight: number;
  overallScore: number;
  scoreColor: string;
}

export interface AnalysisVersion {
  version: string;
  filename: string;
  displayName: string;
  timestamp: string;
  isCurrent: boolean;
}

export interface VersionsData {
  versions: AnalysisVersion[];
}

export interface DomainItem {
  id: string;
  name: string;
  displayName: string;
  description: string;
  show?: boolean;
}
