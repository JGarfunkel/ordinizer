/**
 * JsonFileStorage — filesystem-backed data access layer shared by the server and the analyzer CLI.
 *
 * All path resolution is centralised here. Callers supply a `realmId` when they need
 * realm-specific data; the class resolves the correct subdirectory internally so no
 * caller ever has to juggle `dataPath` strings.
 */
import fs, { readFile } from "fs-extra";
import path from "path";
import { randomUUID } from "crypto";
import type {
  Domain, EntityDomain,
  Statute, Question, Analysis, AnalysisVersionRef,
  InsertEntity, InsertDomain, InsertQuestion, InsertAnalysis,
  Realm, Ruleset,
  EntityCollection, Entity,
  DomainSummaryRow, CombinedMatrixRow, SectionIndexEntry, DataSourcesConfig,
} from "@civillyengaged/ordinizer-core";
import { log } from "util";
import { getEntityId } from "./utils";

const DEFAULT_DATA_ROOT = process.env.DATA_ROOT || "data";

const storageInstanceMap: Record<string, IStorage> = {};
const readOnlyStorageInstanceMap: Record<string, IStorageReadOnly> = {};

let realms: Realm[] | null = null;

export async function getRealmsFromStorage(): Promise<Realm[]> {
  if (!realms) {
    const realmsFile = path.join(await PathResolver.getRealmDir(), "realms.json");
    if (!await fs.pathExists(realmsFile)) return [];
    const data = await fs.readJson(realmsFile);
    if (data) {
      realms = data.realms || [];
    }
  }
  return realms ?? [];
}


export function getDefaultStorage(realmPath: string): IStorage {
    if (!storageInstanceMap[realmPath]) {
        storageInstanceMap[realmPath] = new JsonFileStorage(realmPath);
    }
    return storageInstanceMap[realmPath];
}

export function getReadOnlyStorage(realmPath: string): IStorageReadOnly {
    if (!readOnlyStorageInstanceMap[realmPath]) {
        readOnlyStorageInstanceMap[realmPath] = new JsonFileStorageReadOnly(realmPath);
    }
    return readOnlyStorageInstanceMap[realmPath];
}

async function cleanPathname(name: string): Promise<string> {
  // Replace characters that are illegal in filenames
  return name.replace(/^[A-Za-z_\-]/g, '');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Centralized path resolver to work from any directory
class PathResolver {
  private static _projectRoot: string | null = null;

  static async getProjectRoot(): Promise<string> {
    if (this._projectRoot) {
      return this._projectRoot;
    }

    // Start from current working directory and walk up to find project root
    let currentDir = process.cwd();

    while (currentDir !== path.dirname(currentDir)) {
      // Check for package.json as project root marker
      const packageJsonPath = path.join(currentDir, "package.json");
      try {
        await fs.access(packageJsonPath);
        this._projectRoot = currentDir;
        return currentDir;
      } catch {
        // Continue searching
      }

      currentDir = path.dirname(currentDir);
    }

    // Fallback: assume current directory is project root
    this._projectRoot = process.cwd();
    return this._projectRoot;
  }

  static async getRealmDir(): Promise<string> {
    const projectRoot = await this.getProjectRoot();
    return path.join(projectRoot, "data");
  }

  static async getRealmsPath(): Promise<string> {
    const projectRoot = await this.getProjectRoot();
    return path.join(projectRoot, "data", "realms.json");
  }

  static async getRealmDataDir(realmDatapath: string): Promise<string> {
    const projectRoot = await this.getProjectRoot();
    return path.join(projectRoot, "data", realmDatapath);
  }

  static async getOrdinizerRoot(): Promise<string> {
    const projectRoot = await this.getProjectRoot();
    // Check if we're in the ordinizer subdirectory or at workspace root
    const ordinizerPath = path.join(projectRoot, "ordinizer");
    try {
      await fs.access(ordinizerPath);
      return ordinizerPath;
    } catch {
      // Assume we're already in ordinizer directory
      return projectRoot;
    }
  }

  static async getAIModelsPath(): Promise<string> {
    const ordinizerRoot = await this.getOrdinizerRoot();
    return path.join(ordinizerRoot, "AI-models.json");
  }

}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------


export interface IStorageReadOnly {
  // Realm
  getRealmConfig(): Promise<Realm>;
  getRealm(id: string): Promise<Realm | undefined>;

  loadRealmDataSource(realm: Realm): Promise<any>;

  // Entities
  getEntities(): Promise<Entity[]>;
  getEntityIds(domainId?: string): Promise<string[]>;
  getEntity(entityId: string): Promise<Entity | undefined>;

  // Domains
  getDomains(): Promise<Domain[]>;
  getDomainsByRealm(realmId: string): Promise<Domain[]>;
  getDomain(id: string): Promise<Domain | undefined>;

  // Statutes
  getStatuteByEntityAndDomain(entityId: string, domainId: string, realmId?: string): Promise<Statute | undefined>;
  // getStatutes(): Promise<Statute[]>;
  // getStatute(id: string): Promise<Statute | undefined>;

  // Questions
  getQuestionsByDomain(domainId: string, realmId?: string): Promise<Question[]>;
  createQuestion(question: InsertQuestion): Promise<Question>;

  // Analyses
  getAnalysisByEntityAndDomain(entityId: string, domainId: string): Promise<Analysis | null>;
  getAnalysisVersionsByEntityAndDomain(entityId: string, domainId: string): Promise<AnalysisVersionRef[]>;
  getAnalysisVersionsWithAnalysis(entityId: string, domainId: string, analysis: Analysis): Promise<AnalysisVersionRef[]>;
  createVersionedRecord(filename: string, timestampStr: string | undefined, isCurrent: boolean): Promise<AnalysisVersionRef>;
  getAnalysesByEntityAndDomain(entityId: string, domainId: string): Promise<Analysis[]>;

  // Entity-Domain
  getEntityDomains(entityId: string): Promise<EntityDomain[]>;

  // Domain Summary
  getDomainSummary(domainId: string, realmId?: string): Promise<DomainSummaryRow[]>;

  // Ruleset/Metadata
  getRuleset(domainId: string, entityId: string): Promise<Ruleset | null>;
  getRulesetOrCreate(domainId: string, entityId: string): Promise<Ruleset>;
  getRegulationMetadata(domainId: string, entityId: string): Promise<Ruleset | null>;
  rulesetExists(domainId: string, entityId: string, realmId?: string): Promise<boolean>;
  metadataExists(domainId: string, entityId: string, realmId?: string): Promise<boolean>;

  // Meta Analysis
  getMetaAnalysisByDomain(domainId: string): Promise<any | null>;

  // Raw Analysis
  getAnalysis(domainId: string, entityId: string, realmId?: string): Promise<Analysis | null>;

  // Document
  getDocumentText(domainId: string, entityId: string, realmId?: string): Promise<string | null>;
  getDocumentStat(domainId: string, entityId: string, realmId?: string): Promise<FileStat>;
  documentExists(domainId: string, entityId: string, realmId?: string): Promise<boolean>;

  // Additional Sources
  /**
   * @param domainId 
   * @param entityId 
   * @param realmId 
   */
  getAdditionalSources(domainId: string, entityId: string): Promise<{ data: string[] }>;
  processEntityDownloads(entityId: string, 
      processFunc: (content: string, entityId: string, domainIds: string[], filename: string) => Promise<void>
  ): Promise<void>;


  // Data Sources
  getDataSources(): Promise<DataSourcesConfig | null>;
  getSourceData(sourceId: string): Promise<{ source: any; data: any } | null>;

  // Section Index
  getSectionIndex(): Promise<SectionIndexEntry[]>;

  // Combined Matrix
  getCombinedMatrixData(realmId: string): Promise<CombinedMatrixRow[]>;

  // Boundaries
  getBoundariesForRealm(realmId: string): Promise<any | undefined>;

  // List helpers
  listDomainIds(realmId?: string): Promise<string[]>;
  listEntityIds(domainId: string, realmId?: string, realmTypeOverride?: string): Promise<string[]>;

  // Stat helpers
  getAnalysisStat(domainId: string, entityId: string, realmId?: string): Promise<FileStat>;

  // Existence helpers
  analysisExists(domainId: string, entityId: string, realmId?: string): Promise<boolean>;
  questionsExist(domainId: string, realmId?: string): Promise<boolean>;

  // Data dir
  getDataDir(): string;
  getRealmDir(): string;

  getPathForDomainAndEntity(ruleset: Ruleset): Promise<string>;
  getEntityIdForRuleset(ruleset: Ruleset): Promise<string>;

  getAnalysisEntityId(analysis: Analysis): string | undefined;

  processEntityDownloads(
    entityId: string,
    processFunc: (content: string, entityId: string, domainIds: string[]) => Promise<void>
  ): Promise<void>;
}

export interface IStorage extends IStorageReadOnly {
  createDomain(domain: InsertDomain): Promise<Domain>;
  saveEntities(entities: Entity[]): Promise<Entity[]>;

  // createStatute(statute: InsertStatute): Promise<Statute>;
  // updateStatute(id: string, updates: Partial<InsertStatute>): Promise<Statute | undefined>;

  createQuestion(question: InsertQuestion): Promise<Question>;

  saveAnalysis(analysis: InsertAnalysis): Promise<Analysis>;

    // Domain creation (should only be in IStorage, but present in base class)
  createDomain(domain: InsertDomain): Promise<Domain>;

  // Write helpers (should only be in IStorage, but present in base class)
  writeQuestions(domainId: string, data: any, realmId?: string): Promise<void>;

  // save the ruleset
  saveRuleset(ruleset: Ruleset): Promise<Ruleset>;

  deleteAnalysisBackups(domainId: string, entityId: string): Promise<number>;
  deleteMetadataBackups(domainId: string, entityId: string): Promise<number>;

}

export interface FileStat {
  mtime: Date;
  exists: boolean;
}

export interface BackupResult {
  backupPath: string;
  mtime: Date;
}

/**
 * JsonFileStorage refers to a single directory of storage items
 */
export class JsonFileStorageReadOnly implements IStorageReadOnly {
  protected dataDir: string;
  protected realmDir: string;
  protected realmId: string;
  protected realmConfig: Realm | null = null;
  protected entityCollection: EntityCollection | null = null;
  protected domains: Domain[] | null = null;
  protected domainMap: Map<string, Domain> | null = null;
  protected mapBoundaries: any | null = null;
  protected questionCache: Map<string, Question[]> = new Map();
  protected entityDomainCache: Map<string, EntityDomain[]> = new Map();

  constructor(realmId: string) {
    this.realmId = realmId;
    this.dataDir = path.resolve(DEFAULT_DATA_ROOT);
    this.realmDir = path.resolve(DEFAULT_DATA_ROOT, realmId);
    // void this.ensureDataDir();
  }

  /**
   * Returns the path for a given ruleset's domain and entity.
   * Example: /data/{realmId}/{domainId}/{entityId}/metadata.json
   */
  async getPathForDomainAndEntity(ruleset: Ruleset): Promise<string> {
    return path.join(this.getRealmDir(), ruleset.domainId, await this.getEntityIdForRuleset(ruleset));
  }

  /**
   * Backwards compatibility method to get entity ID for a ruleset, which may not have been created with an entityId field. 
   * Falls back to constructing an ID from realm and municipality if entityId is missing.
   * @param ruleset 
   * @returns 
   */
  async getEntityIdForRuleset(ruleset: Ruleset): Promise<string> {
    // backwards compatibility if not created
    if (!ruleset.entityId) {
      let realm = await this.getRealmConfig();
      ruleset.entityId = realm?.territory + "-" + ruleset.municipality + "-" + ruleset.municipalityType;
    }
    return ruleset.entityId;
  }

  public getDataDir(): string {
    return this.dataDir;
  }

  public getRealmDir(): string {
    return this.realmDir;
  }

  async getDataSources(): Promise<DataSourcesConfig | null> {
    const file = path.join(this.realmDir, "datasources.json");
    if (!await fs.pathExists(file)) return null;
    return fs.readJson(file);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  protected async ensureDataDir() {
    await fs.ensureDir(this.realmDir);
  }

  async loadRealmDataSource(realm: Realm): Promise<any> {
    const dataSourcePath = realm.dataSource?.path;
    if (dataSourcePath) {
      const filePath = path.join(this.getRealmDir(), dataSourcePath);
      return await fs.readJson(filePath);
    }
    throw new Error(`No data source configured for realm ${realm.id}`);
  }

  // -------------------------------------------------------------------------
  // Realm
  // -------------------------------------------------------------------------

  async getRealmConfig(): Promise< Realm> {
    //console.debug("Fetching realm config for realmId:", this.realmId);
    if (this.realmConfig && this.realmConfig.id === this.realmId) {
      //console.debug("Returning cached realm config:", this.realmConfig.id);
      return this.realmConfig;
    }
    const realmsPath = path.join(DEFAULT_DATA_ROOT, "realms.json");
    if (await fs.pathExists(realmsPath)) {
        const realmsData = await fs.readJson(realmsPath);
        const realmConfig = realmsData.realms?.find((r: any) => r.id === this.realmId);
        if (realmConfig) {
          // console.debug("Realm config loaded from file:", realmConfig);
          this.realmConfig = realmConfig;
          return realmConfig;
        } else {
          // collect realm IDs from realmsData for debugging
          const availableRealmIds = realmsData.realms ? realmsData.realms.map((r: any) => r.id) : [];
          throw new Error(`Realm config not found in realms.json for realmId: ${this.realmId}. Available realm IDs: ${availableRealmIds.join(", ")}`);
        }
    } else {
      throw new Error(`Realms file does not exist at path: ${realmsPath}`);
    }
  }


  async getRealm(id: string): Promise<Realm | undefined> {
    const realms = await getRealmsFromStorage();
    return realms.find((r) => r.id === id);
  }

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  async getEntities(): Promise<Entity[]> {
    const realmId = this.realmId;
    if (this.entityCollection) {
      console.debug("Reading entities from cache:", this.entityCollection.entities.length, "entities");
      return this.entityCollection.entities;
    }

    const realm = await this.getRealmConfig();
    if (!realm?.entityFile) return [];
    console.debug(`Loading entities for realm ${realmId} from file:`, realm.entityFile);
    const entityFile = path.join(this.realmDir, realm.entityFile);
    console.debug(`Loading entities for realm ${realmId} from file:`, entityFile);
    if (!await fs.pathExists(entityFile)) return [];
    try {
      const data = await fs.readJson(entityFile);
      if (data.entities) {
        console.debug("Caching entities:", data.entities.length, "entities");
        this.entityCollection = data;
        return data.entities;
      } else {
        console.warn("No entities found in entity file for realm:", realmId);
        let keys = Object.keys(data);
        console.warn("Keys found in entity file:", keys);
        return [];
      }
    } catch (error) {
      console.error(`Error reading entity file for realm ${realmId}:`, error);
      return [];
    }
  }

  async getEntityIds(domainId?: string): Promise<string[]> {
    if (domainId) {
        // do a quick scan of the domain directory to find entity IDs
        const domainDir = path.join(this.realmDir, domainId);
        if (await fs.pathExists(domainDir)) {
          const entries = await fs.readdir(domainDir, { withFileTypes: true });
          const entityIds = entries.filter(e => e.isDirectory()).map(e => e.name);
          console.debug(`Found ${entityIds.length} entity IDs in domain directory ${domainDir}`);
          return entityIds;
        }
    }
    const entities = await this.getEntities();
    return entities.map(e => e.id);
  }

  async getEntity(entityId: string): Promise<any | undefined> {
    const entities = await this.getEntities();
    return entities.find((e) => e.id === entityId);
  }

  // -------------------------------------------------------------------------
  // Domains
  // -------------------------------------------------------------------------

  /**
   * Check cache first, then load from disk if not cached. Caches result for future calls.
   * @returns domain array
   */
  async getDomains(): Promise<Domain[]> {
    if (this.domains && this.domains.length > 0) {
      console.debug("Returning cached domains:", this.domains.length, "domains");
      return this.domains;
    }
    const realmDomainsFile = path.join(this.realmDir, "domains.json");
    if (await fs.pathExists(realmDomainsFile)) {
      const data = await fs.readJson(realmDomainsFile);
      if (data.domains) {
        const domains: Domain[] = data.domains || [];
        this.domains = domains;
        // set domainMap for quick lookup by ID
        this.domainMap = new Map(domains.map((d: Domain) => [d.id, d]));
        return domains;
      }
    } else {
      console.warn("Domains file does not exist for realm:", this.realmId, "expected at path:", realmDomainsFile);
    }
    throw new Error("Could not find domains for realm: " + this.realmId);
  }

  async getDomainsByRealm(realmId: string): Promise<Domain[]> {
    const realm = await this.getRealm(realmId);
    if (realm?.datapath) {
      const realmDomainsFile = path.join(this.realmDir, realm.datapath, "domains.json");
      if (await fs.pathExists(realmDomainsFile)) {
        const data = await fs.readJson(realmDomainsFile);
        return data.domains || [];
      }
    }
    return [];

  }

  /**
   * Return a single domain by ID. 
   * @param id specific id of domain
   * @returns domain object or undefined if not found
   */
  async getDomain(id: string): Promise<Domain | undefined> {
    if (this.domainMap) {
      return this.domainMap.get(id);
    }
    const all = await this.getDomains();
    return all.find((d) => d.id === id);
  }

  async createDomain(domain: InsertDomain): Promise<Domain> {
    const all = await this.getDomains();
    const newDomain: Domain = { id: randomUUID(), ...domain };
    all.push(newDomain);
    await fs.writeJson(
      path.join(this.realmDir, "domains.json"),
      { domains: all, lastUpdated: new Date().toISOString() },
      { spaces: 2 },
    );
    return newDomain;
  }

  // -------------------------------------------------------------------------
  // Statutes
  // -------------------------------------------------------------------------

  // async getStatutes(): Promise<Statute[]> {
  //   // Expensive O(m×d) scan — kept for IStorage compliance; prefer getStatuteByEntityAndDomain.
  //   const entities = await this.getEntitiesByRealm();
  //   const domains = await this.getDomains();
  //   const statutes: Statute[] = [];
  //   for (const entity of entities) {
  //     for (const domain of domains) {
  //       const file = path.join(this.realmDir, domain.id, entity.id, "statute.txt");
  //       if (await fs.pathExists(file)) {
  //         const content = await fs.readFile(file, "utf-8");
  //         statutes.push({
  //           id: `${municipality.id}-${domain.id}`,
  //           entityId: municipality.id,
  //           domainId: domain.id,
  //           content,
  //           lastUpdated: (await fs.stat(file)).mtime.toISOString(),
  //         });
  //       }
  //     }
  //   }
  //   return statutes;
  // }

  // async getStatute(id: string): Promise<Statute | undefined> {
  //   const all = await this.getStatutes();
  //   return all.find((s) => s.id === id);
  // }

  async getStatuteByEntityAndDomain(
    entityId: string,
    domainId: string,
    realmId?: string,
  ): Promise<Statute | undefined> {
    const realmConfig = await this.getRealmConfig();
    const realmType = realmConfig.ruleType ?? 'statute';
    const territory = realmConfig.territory ?? '';

    // Check for state-code redirect in metadata
    const stateFolder = territory ? `${territory}-State` : "";
    const metadataPath = path.join(this.getRealmDir(), domainId, entityId, "metadata.json");
    let targetId = entityId;
    if (stateFolder && await fs.pathExists(metadataPath)) {
      try {
        const metadata = await fs.readJson(metadataPath);
        if (
          metadata.usesStateCode ||
          metadata.stateCodeApplies ||
          metadata.referencesStateCode
        ) {
          targetId = stateFolder;
        }
      } catch { /* ignore */ }
    }

    const file = path.join(this.getRealmDir(), domainId, targetId, `${realmType}.txt`);
    if (!await fs.pathExists(file)) return undefined;
    const content = await fs.readFile(file, "utf-8");
    return {
      id: `${targetId}-${domainId}`,
      entityId: targetId,
      domainId,
      content,
      lastUpdated: (await fs.stat(file)).mtime.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Questions
  // -------------------------------------------------------------------------

  async getQuestionsByDomain(domainId: string, realmId?: string): Promise<Question[]> {
    if (this.questionCache.has(domainId)) {
      return this.questionCache.get(domainId)!;
    }
    const file = path.join(this.getRealmDir(), domainId, "questions.json");
    console.debug("Reading questions for domain", domainId, "from file:", file);
    if (!await fs.pathExists(file)) return [];
    const data = await fs.readJson(file);
    const questions: Question[] = Array.isArray(data) ? data : (data.questions || []);
    let sortedQuestions = questions.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
    this.questionCache.set(domainId, sortedQuestions);
    return sortedQuestions;
  }

  async createQuestion(question: InsertQuestion): Promise<Question> {
    return { id: Date.now(), ...question };
  }

  // -------------------------------------------------------------------------
  // Analyses
  // -------------------------------------------------------------------------

  /**
   * support backwards compatibility - analysis.json currently has municipality id, but we need to move to entityId
   */
  getAnalysisEntityId(analysis: InsertAnalysis): string | undefined {
    return analysis.entityId || analysis.municipality?.id;
  }

  /**
   * Get the analysis for the domain and entity
   * @param domainId Domain (e.g. "police-transparency")
   * @param entityId Entity ID (e.g. municipality ID)
   * @returns Analysis object or null if not found. 
   */
  async getAnalysis(domainId: string, entityId: string): Promise<Analysis | null> {
    const file = path.join(this.realmDir, domainId, entityId, "analysis.json");
    if (!await fs.pathExists(file))  {
      console.debug("Could not find analysis for domain", domainId, " applying to ", entityId, "from file:", file);
      return null;
    }
    return await fs.readJson(file);
  }

  /**
   * @deprecated Use getAnalysis instead, which is more generically named 
   * @param entityId 
   * @param domainId 
   * @returns 
   */
  async getAnalysisByEntityAndDomain(entityId: string, domainId: string,
  ): Promise<Analysis | null> {
    return this.getAnalysis(domainId, entityId);
  }

  /**
   * Backwards compatible method to get all analysis versions for an entity/domain. 
   * If no analysis.json exists, returns empty array. 
   * If analysis.json exists, returns it as the "current" version,
   *  plus any backup files it finds in the same directory.
   * @param entityId 
   * @param domainId 
   * @returns array of analysis version references, sorted by timestamp desc (newest first), with the current version first and marked as isCurrent=true
   */
  async getAnalysisVersionsByEntityAndDomain(entityId: string, domainId: string): Promise<AnalysisVersionRef[]> {
    const analysis: Analysis | null = await this.getAnalysisByEntityAndDomain(entityId, domainId);
    if (analysis)
      return this.getAnalysisVersionsWithAnalysis(entityId, domainId, analysis);
    return [];
  }

  /**
   * Method to get analysis versions 
   * when we already have the current analysis object (to avoid redundant file reads).  
   * @param entityId 
   * @param domainId 
   * @param analysis 
   * @returns array of analysis version references, sorted by timestamp desc (newest first), with the current version first and marked as isCurrent=true
   */
  async getAnalysisVersionsWithAnalysis(entityId: string, domainId: string, analysis: Analysis): Promise<AnalysisVersionRef[]> {
    const directoryPath = path.join(this.realmDir, domainId, entityId);
    console.debug("Checking for analysis versions in directory:", directoryPath);
    if (!await fs.pathExists(directoryPath)) return [];
    const files = await fs.readdir(directoryPath);
    const versions: AnalysisVersionRef[] = [];
    
    versions.push(await this.createVersionedRecord('analysis.json', analysis.lastUpdated, true));
    

    const backupFiles = files.filter(file => file.startsWith('analysis-backup-') && file.endsWith('.json')).sort().reverse();
    for (const backupFile of backupFiles) {
      const timestampMatch = backupFile.match(/analysis-backup-(.+)\.json$/);
      if (timestampMatch) {
        const timestampStr = timestampMatch[1];
        const isoTimestamp = timestampStr.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3') + 'Z';
        versions.push(await this.createVersionedRecord(backupFile, isoTimestamp, false));
      }
    }
    versions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return versions;
  }

  async createVersionedRecord(filename: string, timestampStr: string | undefined, isCurrent: boolean): 
    Promise<AnalysisVersionRef> {
      const displayTimestamp = timestampStr ? new Date(timestampStr).toISOString().replace(/\.d{3}Z$/,'Z') : '';
        return {
          version: displayTimestamp,
          filename: filename,
          displayName: isCurrent ?  'Current' : 'Backup',
          timestamp: displayTimestamp,
          isCurrent: isCurrent
        }
  }


  async getAnalysesByEntityAndDomain(
    entityId: string,
    domainId: string,
  ): Promise<Analysis[]> {
    const file = path.join(this.realmDir, domainId, entityId, "analysis.json");
    if (!await fs.pathExists(file)) return [];
    const data = await fs.readJson(file);
    if (data.answers && Array.isArray(data.answers)) {
      return data.answers.map((a: any) => ({
        id: `${entityId}-${domainId}-${a.questionId}`,
        entityId,
        domainId,
        questions: [],
        answer: a.answer,
        sourceReference: a.relevantSections?.join(", ") ?? null,
        confidence: a.confidence === "high" ? 0.9 : a.confidence === "medium" ? 0.6 : 0.3,
        lastUpdated: data.analyzedAt ?? null,
      }));
    }
    return [];
  }

  async getEntityDomains(entityId: string): Promise<EntityDomain[]> {
    if (this.entityDomainCache.has(entityId)) {
      console.debug("Returning cached entity-domain associations for entityId:", entityId);
      return this.entityDomainCache.get(entityId)!;
    }
    const allDomains = await this.getDomains();
    const result: EntityDomain[] = [];
    for (const domain of allDomains) {
      const dir = path.join(this.realmDir, domain.id, entityId);
      let available = false; // will set to true if the analysis is found

      // legacy code - do we care if statute text exists?
      // const statuteFile = path.join(dir, "statute.txt");  
      // console.debug("Checking for statute file at path:", statuteFile, "available:", available);
      let grade: string | undefined;
      const analysisFile = path.join(dir, "analysis.json");
      if (await fs.pathExists(analysisFile)) {
        try {
          const analysis = await fs.readJson(analysisFile);
          grade = analysis.grade ?? undefined;
          available = true;
        } catch { /* ignore */ }
      } else {
        console.warn(`No analysis found for entity ${entityId} in domain ${domain.id} at expected path:`, analysisFile);
      }
      result.push({
        id: `${entityId}-${domain.id}`,
        entityId,
        domainId: domain.id,
        displayName: domain.displayName,
        hasData: available,
        available,
        grade,
      });
    }
    this.entityDomainCache.set(entityId, result);
    return result;
  }

  async getDomainSummary(domainId: string, realmId: string): Promise<DomainSummaryRow[]> {
    const realmConfig = await this.getRealmConfig();
    const territory = realmConfig.territory ?? '';
    const municipalities = await this.getEntities();

    const result: DomainSummaryRow[] = [];
    for (const municipality of municipalities) {
      const dir = path.join(this.getRealmDir(), domainId, municipality.id);
      const available = await fs.pathExists(path.join(dir, "statute.txt"));
      let grade: string | null = null;
      let gradeColor: string | null = null;
      let stateCodeApplies = false;

      const metadataFile = path.join(dir, "metadata.json");
      if (await fs.pathExists(metadataFile)) {
        try {
          const metadata = await fs.readJson(metadataFile);
          if (
            metadata.usesStateCode ||
            metadata.stateCodeApplies ||
            metadata.referencesStateCode
          ) {
            stateCodeApplies = true;
            grade = territory ? `${territory} State` : "State";
            gradeColor = "#3b82f6";
          }
        } catch { /* ignore */ }
      }

      if (!stateCodeApplies) {
        const analysisFile = path.join(dir, "analysis.json");
        if (await fs.pathExists(analysisFile)) {
          try {
            const analysis = await fs.readJson(analysisFile);
            grade = analysis.grade ?? null;
            gradeColor = analysis.gradeColor ?? null;
          } catch { /* ignore */ }
        }
      }

      result.push({ entityId: municipality.id, grade, gradeColor, available, stateCodeApplies });
    }
    return result;
  }

  // =========================================================================
  // Analyzer-specific methods
  // =========================================================================

  async getRulesetOrCreate(domainId: string, entityId: string): Promise<Ruleset> {
    let ruleset = await this.getRuleset(domainId, entityId);
    if (ruleset) {
      // Normalize legacy/partial metadata so downstream path joins never receive undefined.
      ruleset.entityId = ruleset.entityId || entityId;
      ruleset.domainId = ruleset.domainId || domainId;
      ruleset.domain = ruleset.domain || domainId;
      ruleset.homePage = ruleset.homePage || "";
      ruleset.metadataCreated = ruleset.metadataCreated || new Date().toISOString();
      if (!Array.isArray(ruleset.sources)) {
        ruleset.sources = [];
      }
      return ruleset;
    }
    return {
              entityId,
              domainId,
              domain: domainId,
              homePage: "",
              metadataCreated: new Date().toISOString(),
              stateCodeApplies: false,
              sources: [],
    };
  }

  /**
   * Read metadata.json for an entity/domain in the given realm.
   * Returns the data as a Ruleset or null when the file does not exist.
   */
  async getRuleset(domainId: string, entityId: string): Promise<Ruleset | null> {
    const file = path.join(this.getRealmDir(), domainId, entityId, "metadata.json");
    if (!await fs.pathExists(file)) {
        console.debug("No metadata found for entity", entityId, "and domain", domainId, "from file:", file);
          return null;
    }
    try {
          const raw = await fs.readFile(file, "utf-8");
          if (!raw.trim()) {
            console.warn(`Blank metadata.json for entity ${entityId} and domain ${domainId} at ${file}; treating as missing.`);
            return null;
          }
          return await fs.readJson(file);
    } catch (error) {
          console.error(`Error reading metadata for entity ${entityId} and domain ${domainId} from file ${file}:`, error);
          // TODO - presently assuming blank
          return null;
    }
  }

  /** @deprecated Use getRuleset() instead. */
  async getRegulationMetadata(domainId: string, entityId: string): Promise<Ruleset | null> {
    return this.getRuleset(domainId, entityId);
  }

    async getMetaAnalysisByDomain(domainId: string): Promise<any | null> {
        const file = path.join(this.realmDir, domainId, "meta-analysis.json");
        if (!await fs.pathExists(file)) return null;
        return fs.readJson(file);
    }




  /**
   * Read the statute or policy text for an entity/domain.
   * This skips checking the ruleset (metadata.json)
   * Returns null when the file does not exist.
   */
  async getDocumentText(domainId: string, entityId: string, realmId?: string): Promise<string | null> {
    const realmConfig = await this.getRealmConfig();
    const realmType = realmConfig.ruleType ?? 'statute';
    const file = path.join(this.getRealmDir(), domainId, entityId, `${realmType}.txt`);
    if (!await fs.pathExists(file)) { 
      return null;
    }
    return fs.readFile(file, "utf-8");
  }

  async getAdditionalSources(domainId: string, entityId: string): Promise<{ data: string[] }> {
    const data: string[] = [];

    await this.processEntityDownloads(entityId, async (content, _entityId, domainIds) => {
      if (domainIds.includes(domainId)) {
        data.push(content);
      }
    });

    return { data };
  }

  async processEntityDownloads(
    entityId: string,
    processFunc: (content: string, entityId: string, domainIds: string[], filename: string) => Promise<void>
  ): Promise<void> {
    console.debug("Processing entity downloads for entityId:", entityId);
    const entityDocsDir = path.join(this.getRealmDir(), "EntityDownloads", entityId);
    const historyFile = path.join(entityDocsDir, "history.json");
    if (!await fs.pathExists(historyFile)) {
      console.warn(`No history.json found for entity ${entityId} at expected path:`, historyFile);
      return;
    }
    try {
      const history = await fs.readJson(historyFile);
      if (!history.records || !Array.isArray(history.records)) {
        console.warn("no history.records found in history.json for entity", entityId);
        return;
      }
      const relatedDocs = history.records.filter((doc: any) =>
        doc.status === "related" && Array.isArray(doc.matchedDomainIds) && doc.matchedDomainIds.length > 0
      );
      console.debug(`Found ${relatedDocs.length} related documents for entity ${entityId} in history.json`);
      for (const doc of relatedDocs) {
        const localFile = doc.localFileText;
        // TODO - we'll need to clean up the file references in history.json to strip the path
        const fileName = localFile ? localFile.split("/").pop() : doc.filename;
        if (!fileName) continue;
        const filePath = path.join(entityDocsDir, fileName);
        if (!await fs.pathExists(filePath)) continue;
        const content = await fs.readFile(filePath, "utf-8");
        await processFunc(content, entityId, doc.matchedDomainIds, fileName);
      }
    } catch (error) {
      console.error(`Error processing entity downloads for ${entityId}:`, error);
    }
  }

  /**
   * Read a specific data source's data file (referenced from datasources.json).
   */
  async getSourceData(sourceId: string): Promise<{ source: any; data: any } | null> {
    const config = await this.getDataSources();
    if (!config) return null;
    const sourceConfig = config.sources.find((s: any) => s.id === sourceId);
    if (!sourceConfig || !sourceConfig.dataFile) return null;
    const dataPath = path.join(this.realmDir, sourceConfig.dataFile);
    if (!await fs.pathExists(dataPath)) return null;
    const data = await fs.readJson(dataPath);
    return { source: sourceConfig, data };
  }

  /**
   * Parse statuteSectionIndex.csv and return structured entries.
   */
  async getSectionIndex(): Promise<SectionIndexEntry[]> {
    const file = path.join(this.realmDir, "statuteSectionIndex.csv");
    if (!await fs.pathExists(file)) return [];
    const csvContent = await fs.readFile(file, "utf-8");
    const lines = csvContent.split("\n");
    const entries: SectionIndexEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const [entityId, domain, sourceUrl, sectionNumber, anchorId, sectionUrl] = line.split(",");
      entries.push({ entityId, domain, sourceUrl, sectionNumber, anchorId, sectionUrl });
    }
    return entries;
  }

  /**
   * Bulk read for the combined matrix view.
   * Reads metadata.json + analysis.json for all entities × visible domains in a realm.
   */
  async getCombinedMatrixData(realmId: string): Promise<CombinedMatrixRow[]> {
    const realm = await this.getRealm(realmId);
    if (!realm) return [];

    const domains = await this.getDomains();
    const visibleDomains = domains.filter((d: any) => d.show !== false);
    const entities = await this.getEntities();
    const validEntities = entities
      .filter((e: any) => !(e as any).test)
      .sort((a: any, b: any) => (a.displayName || a.name).localeCompare(b.displayName || b.name));

    const result: CombinedMatrixRow[] = [];
    for (const entity of validEntities) {
      const row: CombinedMatrixRow = {
        entity: {
          id: entity.id,
          displayName: entity.displayName || entity.name,
        },
        domains: {},
      };

      for (const domain of visibleDomains) {
        const dir = path.join(this.getRealmDir(), domain.id, entity.id);
        const metadataPath = path.join(dir, "metadata.json");
        const analysisPath = path.join(dir, "analysis.json");

        let domainData: CombinedMatrixRow["domains"][string] = {
          hasStatute: false,
          referencesStateCode: false,
        };

        // Read metadata.json
        if (await fs.pathExists(metadataPath)) {
          try {
            const metadata = await fs.readJson(metadataPath);
            if (metadata.referencesStateCode === true) {
              domainData.referencesStateCode = true;
              domainData.hasStatute = true;
            }
            domainData.sourceUrl = metadata.sourceUrl;
            if (!domainData.statuteNumber) {
              domainData.statuteNumber = metadata.statuteId || metadata.id || metadata.statuteNumber || metadata.number || "";
            }
            if (!domainData.statuteTitle) {
              domainData.statuteTitle = metadata.statuteTitle || metadata.title || metadata.name || "";
            }
            if ((metadata.statuteNumber || metadata.number || metadata.statuteId || metadata.id) && !domainData.referencesStateCode) {
              domainData.hasStatute = true;
            }
          } catch { /* ignore */ }
        }

        // Read analysis.json
        if (await fs.pathExists(analysisPath) && !domainData.referencesStateCode) {
          try {
            const analysisData = await fs.readJson(analysisPath);
            domainData.hasStatute = true;

            if (analysisData.questions && Array.isArray(analysisData.questions)) {
              let totalScore = 0;
              let totalQuestions = 0;
              analysisData.questions.forEach((q: any) => {
                if (q.id && typeof q.score === "number") {
                  totalScore += q.score;
                  totalQuestions++;
                }
              });
              if (totalQuestions > 0) {
                domainData.score = totalScore / totalQuestions;
              }
            }

            if (analysisData.statute) {
              domainData.statuteNumber = analysisData.statute.id || analysisData.statute.number || domainData.statuteNumber || "";
              domainData.statuteTitle = analysisData.statute.title || analysisData.statute.name || domainData.statuteTitle || "";
            }
          } catch { /* ignore */ }
        }

        row.domains[domain.id] = domainData;
      }

      result.push(row);
    }
    return result;
  }

  /**
   * List domain subdirectory names within the realm's data path.
   * Excludes hidden directories.
   */
  async listDomainIds(realmId?: string): Promise<string[]> {
    const dir = this.getRealmDir();
    if (!await fs.pathExists(dir)) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  }

  /**
   * List entity subdirectory names within a domain directory.
   * For municipal realms (default) returns only NY-prefixed directories.
   * For policy realms returns all non-hidden directories.
   */
  async listEntityIds(domainId: string, realmId?: string, realmTypeOverride?: string): Promise<string[]> {
    const realmConfig = await this.getRealmConfig();
    const realmType = realmConfig.ruleType ?? 'statute';
    const dir = path.join(this.getRealmDir(), domainId);
    if (!await fs.pathExists(dir)) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const effective = realmTypeOverride ?? realmType;
    if (effective === "policy") {
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    }
    return entries.filter((e) => e.isDirectory() && e.name.startsWith("NY-")).map((e) => e.name);
  }

  /**
   * Stat the analysis.json file for an entity/domain.
   * Returns { exists: false, mtime: epoch } when absent.
   */
  async getAnalysisStat(domainId: string, entityId: string, realmId?: string): Promise<FileStat> {
    const file = path.join(this.getRealmDir(), domainId, entityId, "analysis.json");
    if (!await fs.pathExists(file)) return { mtime: new Date(0), exists: false };
    const stat = await fs.stat(file);
    return { mtime: stat.mtime, exists: true };
  }

  /**
   * Stat the statute/policy document for an entity/domain.
   */
  async getDocumentStat(domainId: string, entityId: string, realmId?: string): Promise<FileStat> {
    const realmConfig = await this.getRealmConfig();
    const realmType = realmConfig.ruleType ?? 'statute';
    const file = path.join(this.getRealmDir(), domainId, entityId, `${realmType}.txt`);
    if (!await fs.pathExists(file)) return { mtime: new Date(0), exists: false };
    const stat = await fs.stat(file);
    return { mtime: stat.mtime, exists: true };
  }

  /** True when metadata.json (ruleset) exists for the given entity/domain. */
  async rulesetExists(domainId: string, entityId: string, realmId?: string): Promise<boolean> {
    return fs.pathExists(path.join(this.getRealmDir(), domainId, entityId, "metadata.json"));
  }

  /** @deprecated Use rulesetExists() instead. */
  async metadataExists(domainId: string, entityId: string, realmId?: string): Promise<boolean> {
    return this.rulesetExists(domainId, entityId, realmId);
  }

  /** True when analysis.json exists for the given entity/domain. */
  async analysisExists(domainId: string, entityId: string, realmId?: string): Promise<boolean> {
    return fs.pathExists(path.join(this.getRealmDir(), domainId, entityId, "analysis.json"));
  }

  /** True when the statute/policy document exists for the given entity/domain. */
  async documentExists(domainId: string, entityId: string, realmId?: string): Promise<boolean> {
    const realmConfig = await this.getRealmConfig();
    const realmType = realmConfig.ruleType ?? 'statute';
    return fs.pathExists(path.join(this.getRealmDir(), domainId, entityId, `${realmType}.txt`));
  }

  /** True when questions.json exists for the given domain. */
  async questionsExist(domainId: string, realmId?: string): Promise<boolean> {
    return fs.pathExists(path.join(this.getRealmDir(), domainId, "questions.json"));
  }

  /**
   * Write (or overwrite) questions.json for a domain.
   */
  async writeQuestions(domainId: string, data: any, realmId?: string): Promise<void> {
    const file = path.join(this.getRealmDir(), domainId, "questions.json");
    await fs.writeJson(file, data, { spaces: 2 });
  }

  async getBoundariesForRealm(realmId: string): Promise<any | undefined> {
    if (this.mapBoundaries) {
      console.log("Reading map boundaries from cache");
      return this.mapBoundaries;
    }
    let realm = await this.getRealmConfig();
    if (!realm) {
      console.log("No realm config found for realmId:", realmId);
      return undefined;
    }
    if (!realm.mapBoundaries) {
      console.log("No mapBoundaries property in realm config for realmId:", realmId);
      return undefined;
    } 
    const file = path.join(DEFAULT_DATA_ROOT, realm.mapBoundaries);
    console.log("Loading map boundaries from file:", file);
    if (!await fs.pathExists(file)) return undefined;
    if ((await fs.stat(file)).isDirectory()) {
      console.warn("Map boundaries file a directory:", file);
      return undefined;
    }
    const boundaries = await fs.readJson(file);
    this.mapBoundaries = boundaries;
    return boundaries;
  }

}

export class JsonFileStorage extends JsonFileStorageReadOnly implements IStorage {

  constructor(realmId: string) {
    super(realmId);
    void this.ensureDataDir();
  }

  // async createStatute(statute: InsertStatute): Promise<Statute> {
  //   return { id: `${statute.entityId}-${statute.domainId}`, ...statute, lastUpdated: new Date().toISOString() };
  // }

  // async updateStatute(id: string, updates: Partial<InsertStatute>): Promise<Statute | undefined> {
  //   const existing = await this.getStatute(id);
  //   if (!existing) return undefined;
  //   return { ...existing, ...updates, lastUpdated: new Date().toISOString() };
  // }

  /**
   * Save the analysis, takes backup first
   */
  async saveAnalysis(analysis: InsertAnalysis): Promise<Analysis> {
    const newAnalysis = await this.createAnalysis(analysis); // adds id and lastUpdated
    const domainId = newAnalysis.domainId;
    const entityId = this.getAnalysisEntityId(newAnalysis);
    if (!entityId) {
      throw new Error("Cannot save analysis without entityId");
    }
    await this.saveAnalysisBackup(analysis.domainId, entityId);

    const file = path.join(this.getRealmDir(), domainId, entityId, "analysis.json");
    await fs.writeJson(file, newAnalysis, { spaces: 2 });
    return newAnalysis;
  }

  /**
   * Create a timestamped backup of the current analysis.json.
   * Returns the backup path and the original file's mtime, or null when no analysis exists.
   */
  async saveAnalysisBackup(domainId: string, entityId: string): Promise<BackupResult | null> {
    const file = path.join(this.getRealmDir(), domainId, entityId, "analysis.json");
    return this.saveJsonBackup(file);
  }

  async saveJsonBackup(fullpath: string): Promise<BackupResult | null> {
    if (!await fs.pathExists(fullpath)) {
      return null;
    }
    const stat = await fs.stat(fullpath);
    const timestamp = stat.mtime.toISOString().replace(/[:.]/g, "-").slice(0, 19);

    // replace .json with -backup-{timestamp}.json
    const backupPath = fullpath.replace(/\.json$/, `-backup-${timestamp}.json`);
    console.log("Creating backup of file at path:", fullpath, "to backup path:", backupPath);
    await fs.copy(fullpath, backupPath);
    return { backupPath, mtime: stat.mtime };
  }

  private async deleteBackupFiles(domainId: string, entityId: string, prefix: string): Promise<number> {
    const directoryPath = path.join(this.getRealmDir(), domainId, entityId);
    if (!await fs.pathExists(directoryPath)) {
      return 0;
    }

    const files = await fs.readdir(directoryPath);
    const backupFiles = files.filter(file => file.startsWith(prefix) && file.endsWith(".json"));

    await Promise.all(backupFiles.map(file => fs.remove(path.join(directoryPath, file))));
    return backupFiles.length;
  }

  async deleteAnalysisBackups(domainId: string, entityId: string): Promise<number> {
    return this.deleteBackupFiles(domainId, entityId, "analysis-backup-");
  }

  async deleteMetadataBackups(domainId: string, entityId: string): Promise<number> {
    return this.deleteBackupFiles(domainId, entityId, "metadata-backup-");
  }

  async createAnalysis(analysis: InsertAnalysis): Promise<Analysis> {
    let entityId = this.getAnalysisEntityId(analysis);
    if (!entityId) {
      throw new Error("Cannot create analysis without entityId");
    }
    return {
      id: `${entityId}-${analysis.domainId}-${Date.now()}`,
      ...analysis,
      lastUpdated: new Date().toISOString(),
    };
  }

  async updateAnalysis(id: string, updates: Partial<InsertAnalysis>): Promise<Analysis | undefined> {
    const existing = await this.getAnalysesByEntityAndDomain(
      updates.entityId ?? "",
      updates.domainId ?? "",
    );
    const item = existing.find((a) => a.id === id);
    if (!item) return undefined;
    return { ...item, ...updates, lastUpdated: new Date().toISOString() };
  }

  async saveEntities(entities: Entity[]): Promise<Entity[]> {
    const realm = await this.getRealmConfig();
    if (!realm?.entityFile) {
      throw new Error(`No entityFile configured for realm ${this.realmId}`);
    }

    const collectionFile = path.join(this.realmDir, realm.entityFile);
    const collection: EntityCollection = {
      ...(this.entityCollection ?? { entities: [] }),
      entities,
      totalEntities: entities.length,
    };

    await fs.writeJson(collectionFile, collection, { spaces: 2 });
    this.entityCollection = collection;
    return entities;
  }

    async addEntity(entity: Entity, realmId: string): Promise<Entity> {
    const all = await this.getEntities();
    all.push(entity);
    await this.saveEntities(all);
    return entity;
  }

  async saveRuleset(ruleset: Ruleset): Promise<Ruleset> {
    if (!ruleset.domainId || !ruleset.entityId) {
      throw new Error(
        `Cannot save ruleset with missing identifiers: domainId='${String(ruleset.domainId)}', entityId='${String(ruleset.entityId)}'`,
      );
    }
    const file = path.join(this.getRealmDir(), ruleset.domainId, ruleset.entityId, "metadata.json");
    if (!ruleset.metadataCreated) {
      ruleset.metadataCreated = new Date().toISOString();
    }
    this.saveJsonBackup(file);
    await fs.writeJson(file, ruleset, { spaces: 2 });
    console.log("saved ruleset at path:", file);
    return ruleset;
  }

}
