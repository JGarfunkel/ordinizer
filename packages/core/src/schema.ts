/**
 * Shared types for ordinizer application
 * These types are used across client and server components
 */


export interface EntityCollection {
  generated?: string;
  totalEntities?: number;
  availableDomains?: string[];
  entities: Entity[];   
}

export interface Entity {
  id: string;
  name: string;
  displayName: string; // i.e. "Name - Type"
  singular?: string; // Added: from municipalities.json
  type?: string;   // e.g., City, Town, Village, School District, etc.
  county?: string;
  state?: string;
  population?: number;
  area?: number;
  density?: number;
  website?: string;
  contact?: string;
  lastUpdated?: string; // String format
  domains: { [domain: string]: DomainData };
}

// Only used by source-data.tsx!
// For a municipality's domain-specific data
export interface DomainData {
  sourceUrl: string | null;
  lastDownloadTime: string | null;
  wordCount: number;
  characterCount: number;
  isArticleBased: boolean;
  usesStateCode: boolean;
  referencesStateFile?: boolean;
  articleCount?: number;
  ruleset: Ruleset | null;
  sourceUrls?: Array<{ title: string; url: string }>;
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

export interface EntityDomain {
  id: string; 
  entityId: string;
  domainId: string;
  displayName: string; // Added: used in home.tsx
  hasData: boolean;
  available?: boolean; // Added: used in home.tsx
  grade?: string | number; // Added: used in home.tsx
  lastUpdated?: string; // String format
}

/**
 * A Ruleset represents a text of rules, policies, or regulations that applies to a municipality within a domain. 
 * It can be used for more granular analysis and scoring, 
 * especially when the scoring engine needs to evaluate specific rules or regulations rather than just high-level questions.
 * These provide the metadata; the content is referenced by the Url and in the vector database, but not stored directly.
 * These are currently stored in metdadat.json
 */
export interface Ruleset {
  id: string;
  municipality: string;
  municipalityType: string;
  entityId: string;
  domain: string;
  domainId: string;
  originalCellValue?: string; // The original text from the source file (for reference)
  metadataCreated: string; // Timestamp when the ruleset metadata was created
  stateCodeApplies: boolean; // legacy field indicating if state code applies, used for scoring adjustments
  sources: RulesetSource[]; // Array of sources that inform this ruleset, with metadata about each source
}

export interface RulesetSource {
  downloadedAt: string; // Timestamp when the source was downloaded
  sourceUrl: string; // URL of the source document
  title?: string; // Optional title of the source document
  type?: 'statute' | 'policy' | 'form' | 'guidance'; // Type of the governance source
  contentLength?: number; // Optional length of the source content (e.g., word count)
}

export interface DomainWithQuestions {
  id: string;
  name: string;
  displayName: string;
  questions: Question[];
  questionCount: number;
  totalWeight: number;
}

export interface Question {
  id: number; // Changed: used as number in storage.ts
  domainId: string;
  title: string;
  text: string;
  category?: string;
  order: string;
  weight: number; // Added: used in scoring
  lastUpdated?: string; // String format
  scoreInstructions?: string; // Added: used in scoring
}

export interface Analysis {
  id: string;
  municipality?: {      // Current format (backward compatibility)
    id: string;
    displayName: string;
  };
  entityId?: string;   // Library format
  domainId: string;
  domain?: {            // Current format (backward compatibility)
    id: string;
    displayName: string;
  };
  grades?: Record<string, any>; // Legacy grades (backward compatibility)
  questions: AnalyzedQuestion[];
  overallScore?: number; // Pre-calculated overall score (0-10 scale)
  normalizedScore?: number; // Pre-calculated normalized score (0-1 scale)
  scores?: {            // Detailed score breakdown
    overallScore?: number;
    normalizedScore?: number;
    averageConfidence?: number;
    questionsAnswered?: number;
    totalQuestions?: number;
    scoreBreakdown?: any;
  };
  metadata?: {
    analysisDate?: string;
    version?: string;
    method?: 'conversation' | 'vector';
    [key: string]: any;
  };
  lastUpdated?: string; // String format
}

export interface AnalysisVersionRef {
  version: string;
  filename: string;
  displayName: string;
  timestamp: string;
  isCurrent: boolean;
}

export interface AnalysisAnswer {
	id: number;
	question: string;
	answer: string;
	confidence: number;
	score: number;
	gap?: string;
	sourceRefs: string[];
	relevantSections?: string[];
}

export interface BestPractice {
	questionId: number;
	question: string;
	bestAnswer: string;
	bestScore: number;
	bestEntity: {
		id: string;
		displayName: string;
	};
	quantitativeHighlights?: string[]; // New field for specific numbers/measurements
	supportingExamples: Array<{ // Up to 3 municipal references
		municipality: {
			id: string;
			displayName: string;
		};
		score: number;
		confidence: number;
	}>;
  improvementSuggestions?: string[]; // Actionable recommendations
	commonGaps: string[];
}

export interface MetaAnalysis {
	domain: {
		id: string;
		displayName: string;
		description?: string;
	};
	analysisDate: string;
	totalMunicipalitiesAnalyzed: number;
	averageScore: number;
	highestScoringEntity: {
		id: string;
		displayName: string;
		score: number;
	};
	bestPractices: BestPractice[];
	overallRecommendations: {
		commonWeaknesses: string[];
		keyImprovements: string[];
		modelMunicipalities: string[];
	};
	version: string;
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
  municipality: Entity;
  domain: EntityDomain;
  ruleset?: Ruleset;
  questions: QuestionWithAnswer[];
  lastUpdated?: string;
  alignmentSuggestions?: {
    strengths?: string[];
    improvements?: string[];
    recommendations?: string[];
    bestPractices?: string[];
  };
}

/** @deprecated Use Ruleset + RulesetSource instead. */
export interface Statute {
  id: string;
  entityId: string;
  domainId: string;
  content: string;
  lastUpdated?: string;
}

export interface DataSource {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: string;
  url: string;
  dataFile?: string;
  lastUpdated?: string;
  domains: string[];
  municipalities: number;
  status: string;
}

export interface DataSourcesResponse {
  sources: DataSource[];
}

// UNUSED: QuestionWithScore is not used in the codebase
export interface QuestionWithScore {
  id: number;
  question: string;
  answer: string;
  score: number; // Individual score 0.0 - 1.0
  weight: number; // Question weight (default 1)
  weightedScore: number; // score * weight
  maxWeightedScore: number; // weight (max possible for this question)
  confidence: number;
}

// UNUSED: EntityScore is not used in the codebase
export interface EntityScore {
  entityId: string;
  domainId: string;
  questions: QuestionWithScore[];
  totalWeightedScore: number;
  totalPossibleWeight: number;
  overallScore: number; // 0.0 - 10.0
}


/**
 * Core types for the Ordinizer library
 * Provides domain-agnostic types for municipal statute analysis
 */


export interface Realm {
  id: string;
  name: string;
  displayName: string;
  description: string;
  ruleType: 'statute' | 'policy';
  state: string;
  county: string;
  datapath: string;
  entityType: 'municipalities' | 'school-districts';
  entityFile: string;
  mapBoundaries: string;
  dataSource: {
    type: 'google-sheets' | 'json-file';
    url?: string;
    path?: string;
  };
  domains: string[];
  isDefault?: boolean;
  realmType?: string;
  dataPath: string;
  mapCenter?: [number, number];
  mapZoom?: number;
  geoBoundaryProvider?: {
    kind: 'file' | 'url' | 'service';
    options?: Record<string, any>;
  };
  terminology?: {
    documentSingular?: string;
    documentPlural?: string;
    entitySingular?: string;
    entityPlural?: string;
  };
  paths?: {
    entitiesFile?: string;
    domainsFile?: string;
    questionsPattern?: string;
    analysisPattern?: string;
    metadataPattern?: string;
  };
  scoring?: {
    ignoreIf?: (metadata: any) => boolean;
    thresholds?: {
      low: number;
      high: number;
    };
    colorGradient?: {
      low: string;
      medium: string;
      high: string;
    };
  };
}

export interface RealmsConfig {
  realms: Realm[];
  lastUpdated: string;
}

export interface Entity {
  id: string;
  name: string;
  displayName: string;
  type?: string;
  region?: string;
  state?: string;
  country?: string;
  singular?: string; // URL-friendly singular form (backward compatibility)
}

export interface Domain {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  questions?: Question[];
}

export interface AnalyzedQuestion {
  id?: number | string;        // Current format uses 'id'
  questionId?: number | string; // Library format
  question: string;
  answer: string;
  confidence: number;  // Can be 0-1 or 0-100
  score: number;       // Environmental protection score
  sourceRefs?: (string | SourceRef)[];
  gap?: string;        // Current format: gap analysis
  gapAnalysis?: string; // Library format: gap analysis
}

export interface SourceRef {
  type?: string;        // Current format: 'statute', 'form', etc.
  name?: string;        // Current format: document name
  document?: string;    // Library format: document name
  section?: string;
  sections?: string[];  // Current format: array of sections
  page?: number;
  url?: string;
}

export interface EntitySummary {
  entityId: string;
  name?: string;
  available: boolean;
  stateCodeApplies?: boolean;
  score?: number | null;
  scoreColor?: string;
}

export interface DomainSummary {
  domainId: string;
  totalEntities: number;
  entitiesWithData: number;
  averageScore?: number;
  entities: EntitySummary[];
}

// ---------------------------------------------------------------------------
// Storage result types — used by IStorageReadOnly method signatures
// ---------------------------------------------------------------------------

export interface DomainSummaryRow {
  entityId: string;
  grade: string | null;
  gradeColor: string | null;
  available: boolean;
  stateCodeApplies: boolean;
}

export interface CombinedMatrixRow {
  municipality: {
    id: string;
    displayName: string;
  };
  domains: Record<string, {
    hasStatute: boolean;
    referencesStateCode: boolean;
    statuteNumber?: string;
    statuteTitle?: string;
    sourceUrl?: string;
    score?: number;
    scoreColor?: string;
  }>;
}

export interface SectionIndexEntry {
  entityId: string;
  domain: string;
  sourceUrl: string;
  sectionNumber: string;
  anchorId: string;
  sectionUrl: string;
}

export interface DataSourceConfig {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: string;
  url: string;
  dataFile?: string;
  lastUpdated?: string;
  domains: string[];
  municipalities: number;
  status: string;
}

export interface DataSourcesConfig {
  sources: DataSourceConfig[];
}

// Insert types (for creating new records, typically omitting id and timestamps)
export type InsertEntity = Omit<Entity, 'id' | 'lastUpdated'>;
export type InsertDomain = Omit<Domain, 'id' | 'lastUpdated'>;
export type InsertEntityDomain = Omit<EntityDomain, 'id' | 'lastUpdated'>;
export type InsertStatute = Omit<Statute, 'id' | 'lastUpdated'>;
export type InsertQuestion = Omit<Question, 'id' | 'lastUpdated'>;
export type InsertAnalysis = Omit<Analysis, 'id' | 'lastUpdated'>;