/**
 * Core types for the Ordinizer library
 * Provides domain-agnostic types for municipal statute analysis
 */

export interface RealmConfig {
  id: string;
  displayName: string;
  type: 'statute' | 'policy';
  entityType: 'municipalities' | 'school-districts';
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

export interface Question {
  id: number | string; // Support both numeric and string IDs
  question?: string;    // Current format uses 'question' field
  text?: string;        // Alternative field name for flexibility  
  category?: string;
  weight?: number;
  scoreInstructions?: string;
  order?: number;
  additionalSource?: string;
}

export interface Analysis {
  entityId?: string;    // Library format
  domainId?: string;    // Library format
  municipality?: {      // Current format (backward compatibility)
    id: string;
    displayName: string;
  };
  domain?: {            // Current format (backward compatibility)
    id: string;
    displayName: string;
  };
  grades?: Record<string, any>; // WEN grades (backward compatibility)
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

export interface DataAdapter {
  getQuestions(domainId: string): Promise<Question[]>;
  getAnalysis(domainId: string, entityId: string): Promise<Analysis | null>;
  listEntities(): Promise<Entity[]>;
  loadMetadata(domainId: string, entityId: string): Promise<any>;
  normalizeEntityId(id: string): string;
  safeResolve(path: string): string;
  getDomains(): Promise<Domain[]>;
}

export interface LLMProvider {
  analyze(prompt: string, context?: any): Promise<any>;
}

export interface EmbeddingsProvider {
  createEmbedding(text: string): Promise<number[]>;
  search(query: string, options?: any): Promise<any[]>;
}

export interface PluginConfig {
  llm?: {
    provider: string;
    options?: Record<string, any>;
  };
  embeddings?: {
    provider: string;
    options?: Record<string, any>;
  };
}