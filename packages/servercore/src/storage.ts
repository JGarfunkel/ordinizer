/**
 * JsonFileStorage — filesystem-backed data access layer shared by the server and the analyzer CLI.
 *
 * All path resolution is centralised here. Callers supply a `realmId` when they need
 * realm-specific data; the class resolves the correct subdirectory internally so no
 * caller ever has to juggle `dataPath` strings.
 */
import fs from "fs-extra";
import path from "path";
import { randomUUID } from "crypto";
import type {
  Domain, EntityDomain,
  Statute, Question, Analysis, AnalysisVersionRef,
  InsertEntity, InsertDomain, InsertQuestion, InsertAnalysis,
  Realm, Ruleset,
  EntityCollection, Entity,
  DomainSummaryRow, CombinedMatrixRow, SectionIndexEntry, DataSourcesConfig,
} from "@ordinizer/core";
import { log } from "util";

const DEFAULT_DATA_ROOT = "data";

const storageInstanceMap: Record<string, IStorage> = {};
const readOnlyStorageInstanceMap: Record<string, IStorageReadOnly> = {};

let realms: Realm[] | null = null;

export async function getRealmsFromStorage(): Promise<Realm[]> {
  if (!realms) {
    const realmsFile = path.join(await PathResolver.getDataDir(), "realms.json");
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

  static async getDataDir(): Promise<string> {
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
  getRealmConfig(): Promise<Realm | null>;
  getRealm(id: string): Promise<any | undefined>;
  getDataDir(): string;

  getEntitiesByRealm(realmId: string): Promise<Entity[]>;
  getEntities(): Promise<Entity[]>;
  getEntity(entityId: string): Promise<Entity | undefined>;

  getDomains(): Promise<Domain[]>;
  getDomainsByRealm(realmId: string): Promise<Domain[]>;
  getDomain(id: string): Promise<Domain | undefined>;

  // getStatutes(): Promise<Statute[]>;
  // getStatute(id: string): Promise<Statute | undefined>;

  getStatuteByEntityAndDomain(
    entityId: string, domainId: string, realmId?: string
  ): Promise<Statute | undefined>;

  getBoundariesForRealm(realmId: string): Promise<any | undefined>;

  getQuestionsByDomain(domainId: string, realmId?: string): Promise<Question[]>;

  getAnalysesByEntityAndDomain(entityId: string, domainId: string): Promise<Analysis[]>;
  getAnalysisByEntityAndDomain(entityId: string, domainId: string): Promise<Analysis | null>;
  getAnalysisVersionsByEntityAndDomain(entityId: string, domainId: string): Promise<AnalysisVersionRef[]>;

  getEntityDomains(entityId: string): Promise<EntityDomain[]>;

  getMetaAnalysisByDomain(domainId: string): Promise<any | null>;

  // --- Data access methods (previously handled by raw fs in routes) ---

  /** Read the ruleset (metadata.json) for an entity/domain. */
  getRuleset(domainId: string, entityId: string, realmId?: string): Promise<Ruleset | null>;

  /** Read the statute or policy text for an entity/domain. */
  getDocumentText(domainId: string, entityId: string, realmId?: string): Promise<string | null>;

  /** Summary row per entity for a domain (grade, availability, state code). */
  getDomainSummary(domainId: string, realmId?: string): Promise<DomainSummaryRow[]>;

  /** Bulk read for the combined matrix view: metadata + analysis for all entities × domains. */
  getCombinedMatrixData(realmId: string): Promise<CombinedMatrixRow[]>;

  /** Read datasources.json configuration. */
  getDataSources(): Promise<DataSourcesConfig | null>;

  /** Read a specific data source's data file (referenced from datasources.json). */
  getSourceData(sourceId: string): Promise<{ source: any; data: any } | null>;

  /** Parse statuteSectionIndex.csv and return structured entries. */
  getSectionIndex(): Promise<SectionIndexEntry[]>;
}

export interface IStorage extends IStorageReadOnly {
  createDomain(domain: InsertDomain): Promise<Domain>;

  // createStatute(statute: InsertStatute): Promise<Statute>;
  // updateStatute(id: string, updates: Partial<InsertStatute>): Promise<Statute | undefined>;

  createQuestion(question: InsertQuestion): Promise<Question>;

  createAnalysis(analysis: InsertAnalysis): Promise<Analysis>;
  updateAnalysis(id: string, updates: Partial<InsertAnalysis>): Promise<Analysis | undefined>;
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
  protected realmId: string;
  protected realmConfig: Realm | null = null;
  protected entityCollection: EntityCollection | null = null;
  protected domains: Domain[] | null = null;
  protected mapBoundaries: any | null = null;
  protected questionCache: Map<string, Question[]> = new Map();

  constructor(realmId: string) {
    this.realmId = realmId;
    this.dataDir = path.resolve(DEFAULT_DATA_ROOT, realmId);
    // void this.ensureDataDir();
  }

  public getDataDir(): string {
    return this.dataDir;
  }

  async getDataSources(): Promise<DataSourcesConfig | null> {
    const file = path.join(this.dataDir, "datasources.json");
    if (!await fs.pathExists(file)) return null;
    return fs.readJson(file);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  protected async ensureDataDir() {
    await fs.ensureDir(this.dataDir);
  }

  /**
   * Resolve the realm-specific data subdirectory and document type.
   * Returns defaults when realmId is not supplied.
   */
  protected async resolveRealmParts(realmId?: string): Promise<{ dataPath: string; realmType: string; state: string }> {
    let dataPath = "";
    let realmType = "statute";
    let state = "";
    if (realmId) {
      const realm = await this.getRealm(realmId);
      if (realm?.datapath) dataPath = realm.datapath;
      if (realm?.state) state = realm.state;

      if (realm?.ruleType)  realmType = realm.ruleType;
    }
    return { dataPath, realmType, state };
  }

  // -------------------------------------------------------------------------
  // Realm
  // -------------------------------------------------------------------------

  async getRealmConfig(): Promise< Realm> {
    console.debug("Fetching realm config for realmId:", this.realmId);
    if (this.realmConfig && this.realmConfig.id === this.realmId) {
      console.debug("Returning cached realm config:", this.realmConfig.id);
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
    return this.getEntitiesByRealm(this.realmId);
  }

  async getEntitiesByRealm(realmId: string): Promise<Entity[]> {
    if (this.entityCollection) {
      console.debug("Reading entities from cache:", this.entityCollection.entities.length, "entities");
      return this.entityCollection.entities;
    }

    const realm = await this.getRealmConfig();
    if (!realm?.entityFile) return [];
    console.debug(`Loading entities for realm ${realmId} from file:`, realm.entityFile);
    const entityFile = path.join(this.dataDir, realm.entityFile);
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

  async getEntity(entityId: string): Promise<any | undefined> {
    const entities = await this.getEntities();
    return entities.find((e) => e.id === entityId);
  }

  async addEntity(entity: Entity, realmId: string): Promise<Entity> {
    const all = await this.getEntitiesByRealm(realmId);
    all.push(entity);
    const collectionFile = await this.getRealmConfig().then(realm => realm?.entityFile ? path.join(this.dataDir, realm.entityFile) : null);
    if (collectionFile) {
      await fs.writeJson(
        collectionFile,
        { entities: all, lastUpdated: new Date().toISOString() },
        { spaces: 2 },
      );
    }
    return entity;
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
    const realmDomainsFile = path.join(this.dataDir, "domains.json");
    if (await fs.pathExists(realmDomainsFile)) {
      const data = await fs.readJson(realmDomainsFile);
      return (this.domains = data.domains || []);
    } else {
      console.warn("Domains file does not exist for realm:", this.realmId, "expected at path:", realmDomainsFile);
    }
    throw new Error("Could not find domains for realm: " + this.realmId);
  }

  async getDomainsByRealm(realmId: string): Promise<Domain[]> {
    const realm = await this.getRealm(realmId);
    if (realm?.datapath) {
      const realmDomainsFile = path.join(this.dataDir, realm.datapath, "domains.json");
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
    const all = await this.getDomains();
    return all.find((d) => d.id === id);
  }

  async createDomain(domain: InsertDomain): Promise<Domain> {
    const all = await this.getDomains();
    const newDomain: Domain = { id: randomUUID(), ...domain };
    all.push(newDomain);
    await fs.writeJson(
      path.join(this.dataDir, "domains.json"),
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
  //       const file = path.join(this.dataDir, domain.id, entity.id, "statute.txt");
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
    const { dataPath, realmType, state } = await this.resolveRealmParts(realmId);

    // Check for state-code redirect in metadata
    const stateFolder = state ? `${state}-State` : "";
    const metadataPath = path.join(this.dataDir, dataPath, domainId, entityId, "metadata.json");
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

    const file = path.join(this.dataDir, dataPath, domainId, targetId, `${realmType}.txt`);
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
    if (!this.realmConfig) {
      throw new Error("realm is not set");
    }
    const dataPath = this.realmConfig.datapath;
    const file = path.join(this.dataDir, dataPath, domainId, "questions.json");
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

  async getAnalysisByEntityAndDomain(
    entityId: string,
    domainId: string,
  ): Promise<Analysis | null> {
    const file = path.join(this.dataDir, domainId, entityId, "analysis.json");
    if (!await fs.pathExists(file)) return null;
    return await fs.readJson(file);
  }

  async getAnalysisVersionsByEntityAndDomain(entityId: string, domainId: string): Promise<AnalysisVersionRef[]> {
    const directoryPath = path.join(this.dataDir, domainId, entityId);
    const files = await fs.readdir(directoryPath);
      const versions: AnalysisVersionRef[] = [];
      const currentAnalysisPath = path.join(directoryPath, 'analysis.json');
      if (await fs.pathExists(currentAnalysisPath)) {
        const stats = await fs.stat(currentAnalysisPath);
        versions.push({
          version: 'current',
          filename: 'analysis.json',
          displayName: 'Current',
          timestamp: stats.mtime.toISOString(),
          isCurrent: true
        });
      }
      const backupFiles = files.filter(file => file.startsWith('analysis-backup-') && file.endsWith('.json')).sort().reverse();
      for (const backupFile of backupFiles) {
        const timestampMatch = backupFile.match(/analysis-backup-(.+)\.json$/);
        if (timestampMatch) {
          const timestampStr = timestampMatch[1];
          const isoTimestamp = timestampStr.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3') + 'Z';
          const timestamp = new Date(isoTimestamp);
          versions.push({
            version: timestampStr,
            filename: backupFile,
            displayName: 'Backup',
            timestamp: timestamp.toISOString(),
            isCurrent: false
          });
        }
      }
      versions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      return versions;
  }


  async getAnalysesByEntityAndDomain(
    entityId: string,
    domainId: string,
  ): Promise<Analysis[]> {
    const file = path.join(this.dataDir, domainId, entityId, "analysis.json");
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
    const allDomains = await this.getDomains();
    const result: EntityDomain[] = [];
    for (const domain of allDomains) {
      const dir = path.join(this.dataDir, domain.id, entityId);
      const available = await fs.pathExists(path.join(dir, "statute.txt"));
      let grade: string | undefined;
      const analysisFile = path.join(dir, "analysis.json");
      if (await fs.pathExists(analysisFile)) {
        try {
          const analysis = await fs.readJson(analysisFile);
          grade = analysis.grade ?? undefined;
        } catch { /* ignore */ }
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
    return result;
  }

  async getDomainSummary(domainId: string, realmId: string): Promise<DomainSummaryRow[]> {
    const { dataPath, state } = await this.resolveRealmParts(realmId);
    const municipalities = await this.getEntitiesByRealm(realmId);

    const result: DomainSummaryRow[] = [];
    for (const municipality of municipalities) {
      const dir = path.join(this.dataDir, dataPath, domainId, municipality.id);
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
            grade = state ? `${state} State` : "State";
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

  /**
   * Read metadata.json for an entity/domain in the given realm.
   * Returns the data as a Ruleset or null when the file does not exist.
   */
  async getRuleset(domainId: string, entityId: string, realmId?: string): Promise<Ruleset | null> {
    const { dataPath } = await this.resolveRealmParts(realmId);
    const file = path.join(this.dataDir, dataPath, domainId, entityId, "metadata.json");
    if (!await fs.pathExists(file)) return null;
    return fs.readJson(file);
  }

  /** @deprecated Use getRuleset() instead. */
  async getRegulationMetadata(domainId: string, entityId: string, realmId?: string): Promise<Ruleset | null> {
    return this.getRuleset(domainId, entityId, realmId);
  }

    async getMetaAnalysisByDomain(domainId: string): Promise<any | null> {
        const file = path.join(this.dataDir, domainId, "meta-analysis.json");
        if (!await fs.pathExists(file)) return null;
        return fs.readJson(file);
    }


  /**
   * Read raw analysis.json for an entity/domain.
   * Returns null when the file does not exist.
   */
  async getAnalysisRaw(domainId: string, entityId: string, realmId?: string): Promise<Analysis | null> {
    const { dataPath } = await this.resolveRealmParts(realmId);
    const file = path.join(this.dataDir, dataPath, domainId, entityId, "analysis.json");
    if (!await fs.pathExists(file)) return null;
    return fs.readJson(file);
  }

  /**
   * Read the statute or policy text for an entity/domain.
   * Returns null when the file does not exist.
   */
  async getDocumentText(domainId: string, entityId: string, realmId?: string): Promise<string | null> {
    const { dataPath, realmType } = await this.resolveRealmParts(realmId);
    const file = path.join(this.dataDir, dataPath, domainId, entityId, `${realmType}.txt`);
    if (!await fs.pathExists(file)) return null;
    return fs.readFile(file, "utf-8");
  }

  /**
   * Read optional supplementary source files (guidance.txt, form.txt).
   */
  async getAdditionalSources(
    domainId: string,
    entityId: string,
    realmId?: string,
  ): Promise<{ guidance?: string; form?: string }> {
    const { dataPath } = await this.resolveRealmParts(realmId);
    const dir = path.join(this.dataDir, dataPath, domainId, entityId);
    const sources: { guidance?: string; form?: string } = {};

    const guidancePath = path.join(dir, "guidance.txt");
    if (await fs.pathExists(guidancePath)) {
      sources.guidance = await fs.readFile(guidancePath, "utf-8");
    }
    const formPath = path.join(dir, "form.txt");
    if (await fs.pathExists(formPath)) {
      sources.form = await fs.readFile(formPath, "utf-8");
    }
    return sources;
  }

  /**
   * Read a specific data source's data file (referenced from datasources.json).
   */
  async getSourceData(sourceId: string): Promise<{ source: any; data: any } | null> {
    const config = await this.getDataSources();
    if (!config) return null;
    const sourceConfig = config.sources.find((s: any) => s.id === sourceId);
    if (!sourceConfig || !sourceConfig.dataFile) return null;
    const dataPath = path.join(this.dataDir, sourceConfig.dataFile);
    if (!await fs.pathExists(dataPath)) return null;
    const data = await fs.readJson(dataPath);
    return { source: sourceConfig, data };
  }

  /**
   * Parse statuteSectionIndex.csv and return structured entries.
   */
  async getSectionIndex(): Promise<SectionIndexEntry[]> {
    const file = path.join(this.dataDir, "statuteSectionIndex.csv");
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

    const domains = await this.getDomainsByRealm(realmId);
    const visibleDomains = domains.filter((d: any) => d.show !== false);
    const municipalities = await this.getEntitiesByRealm(realmId);
    const validMunicipalities = municipalities
      .filter((m: any) => !(m as any).test)
      .sort((a: any, b: any) => (a.displayName || a.name).localeCompare(b.displayName || b.name));

    const { dataPath } = await this.resolveRealmParts(realmId);

    const result: CombinedMatrixRow[] = [];
    for (const municipality of validMunicipalities) {
      const row: CombinedMatrixRow = {
        municipality: {
          id: municipality.id,
          displayName: municipality.displayName || municipality.name,
        },
        domains: {},
      };

      for (const domain of visibleDomains) {
        const dir = path.join(this.dataDir, dataPath, domain.id, municipality.id);
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
    const { dataPath } = await this.resolveRealmParts(realmId);
    const dir = path.join(this.dataDir, dataPath);
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
    const { dataPath, realmType } = await this.resolveRealmParts(realmId);
    const dir = path.join(this.dataDir, dataPath, domainId);
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
    const { dataPath } = await this.resolveRealmParts(realmId);
    const file = path.join(this.dataDir, dataPath, domainId, entityId, "analysis.json");
    if (!await fs.pathExists(file)) return { mtime: new Date(0), exists: false };
    const stat = await fs.stat(file);
    return { mtime: stat.mtime, exists: true };
  }

  /**
   * Stat the statute/policy document for an entity/domain.
   */
  async getDocumentStat(domainId: string, entityId: string, realmId?: string): Promise<FileStat> {
    const { dataPath, realmType } = await this.resolveRealmParts(realmId);
    const file = path.join(this.dataDir, dataPath, domainId, entityId, `${realmType}.txt`);
    if (!await fs.pathExists(file)) return { mtime: new Date(0), exists: false };
    const stat = await fs.stat(file);
    return { mtime: stat.mtime, exists: true };
  }

  /** True when metadata.json (ruleset) exists for the given entity/domain. */
  async rulesetExists(domainId: string, entityId: string, realmId?: string): Promise<boolean> {
    const { dataPath } = await this.resolveRealmParts(realmId);
    return fs.pathExists(path.join(this.dataDir, dataPath, domainId, entityId, "metadata.json"));
  }

  /** @deprecated Use rulesetExists() instead. */
  async metadataExists(domainId: string, entityId: string, realmId?: string): Promise<boolean> {
    return this.rulesetExists(domainId, entityId, realmId);
  }

  /** True when analysis.json exists for the given entity/domain. */
  async analysisExists(domainId: string, entityId: string, realmId?: string): Promise<boolean> {
    const { dataPath } = await this.resolveRealmParts(realmId);
    return fs.pathExists(path.join(this.dataDir, dataPath, domainId, entityId, "analysis.json"));
  }

  /** True when the statute/policy document exists for the given entity/domain. */
  async documentExists(domainId: string, entityId: string, realmId?: string): Promise<boolean> {
    const { dataPath, realmType } = await this.resolveRealmParts(realmId);
    return fs.pathExists(path.join(this.dataDir, dataPath, domainId, entityId, `${realmType}.txt`));
  }

  /** True when questions.json exists for the given domain. */
  async questionsExist(domainId: string, realmId?: string): Promise<boolean> {
    const { dataPath } = await this.resolveRealmParts(realmId);
    return fs.pathExists(path.join(this.dataDir, dataPath, domainId, "questions.json"));
  }

  /**
   * Write (or overwrite) questions.json for a domain.
   */
  async writeQuestions(domainId: string, data: any, realmId?: string): Promise<void> {
    const { dataPath } = await this.resolveRealmParts(realmId);
    const file = path.join(this.dataDir, dataPath, domainId, "questions.json");
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
   * Write (or overwrite) analysis.json for an entity/domain.
   */
  async writeAnalysis(domainId: string, entityId: string, data: Analysis, realmId?: string): Promise<void> {
    const { dataPath } = await this.resolveRealmParts(realmId);
    const file = path.join(this.dataDir, dataPath, domainId, entityId, "analysis.json");
    await fs.writeJson(file, data, { spaces: 2 });
  }

  /**
   * Create a timestamped backup of the current analysis.json.
   * Returns the backup path and the original file's mtime, or null when no analysis exists.
   */
  async writeAnalysisBackup(domainId: string, entityId: string, realmId?: string): Promise<BackupResult | null> {
    const { dataPath } = await this.resolveRealmParts(realmId);
    const file = path.join(this.dataDir, dataPath, domainId, entityId, "analysis.json");
    if (!await fs.pathExists(file)) return null;
    const stat = await fs.stat(file);
    const timestamp = stat.mtime.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupFile = path.join(this.dataDir, dataPath, domainId, entityId, `analysis-backup-${timestamp}.json`);
    await fs.copy(file, backupFile);
    return { backupPath: backupFile, mtime: stat.mtime };
  }

    async createAnalysis(analysis: InsertAnalysis): Promise<Analysis> {
    return {
      id: `${analysis.entityId ?? ""}-${analysis.domainId}-${Date.now()}`,
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



}
