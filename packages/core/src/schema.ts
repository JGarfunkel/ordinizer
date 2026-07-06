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
 * These are currently stored in metadata.json
 */
export interface Ruleset {
  id?: string;
  municipality?: string;
  municipalityType?: string;
  entityId: string;
  domain: string;
  domainId: string;
  homePage: string; // URL of the main page for the entity/domain
  originalCellValue?: string; // The original text from the source file (for reference)
  metadataCreated: string; // Timestamp when the ruleset metadata was created
  stateCodeApplies?: boolean; // legacy field indicating if state code applies, used for scoring adjustments
  statuteNumber?: string; // Optional statute number (e.g., "Section 5.2")
  sources: RulesetSource[]; // Array of sources that inform this ruleset, with metadata about each source
  isArticleBased?: boolean; // Indicates if the ruleset is based on multiple articles/sections
}

/**
 * This is the metadata for a source document that informs a Ruleset. 
 * It includes information about when it was downloaded, the URL, type of source,
 *  and where the content is stored locally. 
 * The actual text content of the source is not stored here, 
 * but can be retrieved using the sourceUrl or downloadedFilename as needed.
 */
export interface RulesetSource {
  downloadedAt?: string; // Timestamp when the source was downloaded
  sourceUrl: string; // URL of the source document
  title?: string; // Optional title of the source document
  type?: 'statute' | 'policy' | 'form' | 'guidance' | 'information' | 'homepage' | 'general'; // Type of the governance source
  contentLength?: number; // Optional length of the source content (e.g., word count)
  downloadedFilename?: string; // Relative path to the downloaded artifact (HTML or TXT file)
}

/** 
 * TODO: merge with RulesetSource
 */
export interface LinkedResource {
  url: string;
  title: string;
  matchedDomainIds: string[];
  timestamp: string;
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
  question: string; // TODO consider changing to something else to avoid question.question redundancy
  category?: string;
  order: string;
  weight: number; // Added: used in scoring
  lastUpdated?: string; // String format
  scoreInstructions?: string; // Added: used in scoring
  dependsOn?: number[]; // IDs of questions whose answers should inform this one
}

export interface Analysis {
  id: string;
  municipality?: {      // Current format (backward compatibility)
    id: string;
    displayName: string;
  };
  entity?: {      // Current format (backward compatibility)
    id: string;
    displayName: string;
  };
  entityId?: string;   // Library format
  domainId: string;
  domain?: {            // Current format (backward compatibility)
    id: string;
    displayName: string;
    grade?: string | number; // May be present in analysis JSON files
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
  alignmentSuggestions?: {
    strengths?: string[];
    improvements?: string[];
    recommendations?: string[];
    bestPractices?: string[];
  };
  metadata?: {
    analysisDate?: string;
    version?: string;
    method?: 'conversation' | 'vector';
    [key: string]: any;
  };
  lastUpdated?: string; // String format
  processingMethod?: string;
  gapAnalysis?: string; // Added: used in home.tsx for gap analysis summary
  sources: SourceLink[]; // Added: used in home.tsx to display source links
}

// TODO: extend this
export interface SourceLink extends UrlAndTitle {
}

export interface AnalysisVersionRef {
  version: string;
  filename: string;
  displayName: string;
  timestamp: string;
  isCurrent: boolean;
}

export interface BestPractice {
	questionId: number;
	question: string;
	bestAnswer?: string;
	bestScore?: number;
	bestEntity?: {
		id: string;
		displayName: string;
	};
	quantitativeHighlights?: string[]; // New field for specific numbers/measurements
	supportingExamples?: Array<{ // Up to 3 municipal references
		municipality: {
			id: string;
			displayName: string;
		};
		score: number;
		confidence: number;
	}>;
  improvementSuggestions?: string[]; // Actionable recommendations
	commonGaps?: string[];
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
  shortAnswer: string;
  sourceReference: string | null;
  lastUpdated: string | null; // String format
  analyzedAt?: string; // Added: used in home.tsx
  relevantSections?: string[];
  gap?: string;
  resolvedSectionUrls?: Array<{sectionNumber: string, sectionUrl?: string}>;
}

/** @deprecated Use Analysis directly — the server now returns Analysis without a wrapper. */
export interface AnalysisResponse {
  municipality: Entity;
  domain: EntityDomain;
  ruleset?: Ruleset;
  questions: AnalyzedQuestion[];
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

export interface UrlAndTitle {
  url: string;
  title: string;
}

export type SourceMapLink = UrlAndTitle;

export interface SourceMapEntity {
  entityId: string;
  displayName: string;
  domains: Record<string, SourceMapLink[]>;
}

export interface QuestionWithScore {
  id: string | number;
  question?: string;
  answer?: string;
  /** Individual question score, 0–1 scale */
  score: number;
  /** Question weight (default 1) */
  weight: number;
  /** score × weight */
  weightedScore: number;
  /** Maximum possible weighted score (equals weight) */
  maxWeightedScore: number;
  /** Confidence level, 0–100 */
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


export interface RealmGeo {
  stateProvince?: string;
  county?: string;
  mapBoundaries?: string;
  mapCenter?: [number, number];
  mapZoom?: number;
}

export interface Realm {
  id: string;
  name: string;
  displayName: string;
  description: string;
  ruleType: 'statute' | 'policy';
  geo?: RealmGeo;
  datapath: string;
  entityType: 'municipalities' | 'school-districts' | 'product';
  entityFile: string;
  dataSource: {
    type: 'google-sheets' | 'json-file';
    url?: string;
    path?: string;
  };
  domains?: string[];
  isDefault?: boolean;
  realmType?: string;
  dataPath: string;
  geoBoundaryProvider?: {
    kind: 'file' | 'url' | 'service';
    options?: Record<string, any>;
  };
  terminology?: {
    documentSingular?: string;
    documentPlural?: string;
    entitySingular?: string;
    entityPlural?: string;
    scoreText?: string;
  };
  spiderHints?: {
    /** URL path segment keywords that signal high-value pages; matched URLs are crawled first. */
    priorityPathKeywords?: string[];
    /** Page-body phrases that indicate a navigation/index page (replaces default municipal signals). */
    indexNavSignals?: string[];
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

export type MapClickBehavior = 'floatingPopup' | 'sidebar';

export interface LayoutOptions {
  showHeader?: boolean;
  onMapClick?: MapClickBehavior[];
}

export interface RealmsConfig {
  realms: Realm[];
  lastUpdated: string;
  layout?: LayoutOptions;
}

export interface Entity {
  id: string;
  name: string;
  displayName: string;
  type?: string;
  description: string;
  singular?: string;
  county?: string;
  state?: string;
  country?: string;
  region?: string;
  population?: number;
  area?: number;
  density?: number;
  website?: string;
  contact?: string;
  lastUpdated?: string;
  mainUrl?: string;
  governingUrl?: string;
  governingBody?: string;
  hubUrl?: string;
  authorityUrl?: string;
  links?: EntityLink[];
  parentId?: string | null;
  domains?: { [domain: string]: DomainData };
}

export type EntityLinkType = "main" | "governing" | "hub" | "authority";

export interface EntityLink {
  type: EntityLinkType;
  url: string;
}

export interface LegendItem {
  color: string;
  label: string;
}

export interface DomainLegend {
  title?: string;
  items: LegendItem[];
}

export interface Domain {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  show?: boolean;
  order?: number;
  color?: string;
  lastUpdated?: string;
  questions?: Question[];
  questionPromptScope?: string;
  questionPromptRequirements?: string[];
  keywords?: string[];
  type?: 'statutory' | 'policy' | 'general';
  searchEnhancements?: Array<{ conditions: string[]; terms: string[] }>;
  /** 'analysis' = AI Q&A driven; 'data' = hard statistical data from a spreadsheet */
  kind?: 'analysis' | 'data';
  /** URL of the source spreadsheet or dataset for this domain */
  source?: string;
  /** Custom map legend for this domain */
  legend?: DomainLegend;
}

/**
 * Configuration stored in {realmDir}/{domainId}/data-config.json.
 * Tells the parseDataDomain script how to read the source spreadsheet.
 */
export interface DataDomainConfig {
  /** Google Sheets URL (or any CSV URL) */
  sourceUrl: string;
  /** 1-indexed row number that contains column headers (default: 1) */
  headerRow?: number;
  /** Header label of the column containing the entity name */
  entityNameColumn: string;
  /** Header label of the column containing the entity type (e.g. "Town", "City") */
  entityTypeColumn?: string;
  /** Optional scoring rules for map coloring */
  scoring?: DataDomainScoring[];
}

/** One scoring rule: maps ranges of a column's values to display colors */
export interface DataDomainScoring {
  /** Key of the column in data.json rows to evaluate */
  scoreColumn: string;
  /**
   * Range → CSS color name or hex string.
   * Supported range formats:
   *   ">N"   value > N
   *   ">=N"  value >= N
   *   "<N"   value < N
   *   "N-M"  N ≤ value ≤ M  (leading-zero tokens: "01" = 0.1, "05" = 0.5)
   */
  scoreMapping: Record<string, string>;
  /** How to format the score column value for display (e.g. legend labels, badges) */
  scoreColumnFormat?: 'percentage' | 'number' | 'string';
}

/** A single typed data column descriptor written into data.json */
export interface DataColumn {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'percentage';
}

/**
 * Output written to {realmDir}/{domainId}/data.json by parseDataDomain.
 * The server merges scoring rules from data-config.json before serving.
 */
export interface DomainDataFile {
  domain: string;
  generated: string;
  sourceUrl?: string;
  columns: DataColumn[];
  rows: Array<{ entityId: string; entityName?: string; [key: string]: any }>;
  /** Scoring rules injected by the server from data-config.json */
  scoring?: DataDomainScoring[];
}

export interface AnalyzedQuestion {
  id?: number | string;        // Current format uses 'id'
  questionId?: number | string; // Library format
  question: string;
  answer: string;
  shortAnswer: string;
  confidence: number;  // Can be 0-1 or 0-100
  score: number;       // Environmental protection score
  sourceRefs?: (string | SourceRef)[];
  /** Flat string reference — present in older analysis JSON files */
  sourceReference?: string | null;
  /** Structured section list — present in older analysis JSON files */
  relevantSections?: (string | { name: string; url?: string })[];
  gap?: string;        // Current format: gap analysis
  gapAnalysis?: string; // Library format: gap analysis
  /** Per-question timestamp set when the question was last analysed */
  analyzedAt?: string;
  /** AI-suggested next research prompts for this question */
  nextPrompts?: string[];
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

export interface MatrixData {
  domain: {
    id: string;
    displayName: string;
  };
  questions: Array<{
    id: number;
    question: string;
    category?: string;
    weight?: number;
  }>;
  entities: MatrixEntity[];
}

export interface MatrixEntity {
    id: string;
    displayName: string;
    scores: Record<string, QuestionScore>
    totalScore: number;
    statute?: {
      number: string;
      title: string;
      url: string;
    };
    lastUpdated?: string;
    referencesStateCode?: boolean;
}

export interface QuestionScore {
      score: number;
      confidence: number;
      answer: string;
      shortAnswer?: string;
      sourceRefs: string[];
      analyzedAt?: string;
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
  entity: {
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