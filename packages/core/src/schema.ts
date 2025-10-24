/**
 * Shared types for nyseeds application
 * These types are used across client and server components
 */

export interface Municipality {
  id: string;
  name: string;
  displayName: string;
  singular?: string; // Added: from municipalities.json
  type?: string;
  county?: string;
  state?: string;
  population?: number;
  area?: number;
  density?: number;
  website?: string;
  contact?: string;
  lastUpdated?: string; // String format
}

export interface Domain {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  show?: boolean;
  order?: number;
  color?: string;
  lastUpdated?: string; // String format
}

export interface MunicipalityDomain {
  id: string;
  municipalityId: string;
  domainId: string;
  displayName: string; // Added: used in home.tsx
  hasData: boolean;
  available?: boolean; // Added: used in home.tsx
  grade?: string | number; // Added: used in home.tsx
  lastUpdated?: string; // String format
}

export interface Statute {
  id: string;
  municipalityId: string;
  domainId: string;
  title?: string;
  number?: string;
  content?: string;
  sourceUrl?: string;
  lastUpdated?: string; // String format
}

export interface Question {
  id: number; // Changed: used as number in storage.ts
  domainId: string;
  title: string;
  text: string;
  order: string;
  lastUpdated?: string; // String format
}

export interface Analysis {
  id: string;
  municipalityId: string;
  domainId: string;
  questionId: string;
  answer: string;
  score: number;
  confidence: number;
  sourceReference?: string;
  relevantSections?: string[];
  gap?: string;
  lastUpdated?: string; // String format
}

// Additional interfaces used in home.tsx
export interface QuestionWithAnswer {
  id: number;
  title: string;
  text: string;
  order: string;
  answer: string;
  sourceReference: string | null;
  lastUpdated: string | null; // String format
  analyzedAt?: string; // Added: used in home.tsx
  relevantSections?: string[];
  gap?: string;
  resolvedSectionUrls?: Array<{sectionNumber: string, sectionUrl?: string}>;
}

export interface AnalysisResponse {
  lastUpdated?: string; // Added: used in home.tsx
  [key: string]: any;
}

// Insert types (for creating new records, typically omitting id and timestamps)
export type InsertMunicipality = Omit<Municipality, 'id' | 'lastUpdated'>;
export type InsertDomain = Omit<Domain, 'id' | 'lastUpdated'>;
export type InsertMunicipalityDomain = Omit<MunicipalityDomain, 'id' | 'lastUpdated'>;
export type InsertStatute = Omit<Statute, 'id' | 'lastUpdated'>;
export type InsertQuestion = Omit<Question, 'id' | 'lastUpdated'>;
export type InsertAnalysis = Omit<Analysis, 'id' | 'lastUpdated'>;