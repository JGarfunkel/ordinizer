import { type Municipality, type Domain, type MunicipalityDomain, type Statute, type Question, type Analysis, type InsertMunicipality, type InsertDomain, type InsertStatute, type InsertQuestion, type InsertAnalysis } from "@ordinizer/core";
import fs from "fs-extra";
import path from "path";
import { randomUUID } from "crypto";

export interface IStorage {
  // Realms
  getRealms(): Promise<any[]>;
  getRealm(id: string): Promise<any | undefined>;
  
  // Entities (generic for municipalities, school districts, etc.)
  getEntitiesByRealm(realmId: string): Promise<any[]>;
  getEntity(realmId: string, entityId: string): Promise<any | undefined>;
  
  // Municipalities (legacy - now realm-specific)
  getMunicipalities(): Promise<Municipality[]>;
  getMunicipality(id: string): Promise<Municipality | undefined>;
  createMunicipality(municipality: InsertMunicipality): Promise<Municipality>;

  // Domains
  getDomains(): Promise<Domain[]>;
  getDomain(id: string): Promise<Domain | undefined>;
  createDomain(domain: InsertDomain): Promise<Domain>;

  // Statutes
  getStatutes(): Promise<Statute[]>;
  getStatute(id: string): Promise<Statute | undefined>;
  getStatuteByMunicipalityAndDomain(municipalityId: string, domainId: string): Promise<Statute | undefined>;
  createStatute(statute: InsertStatute): Promise<Statute>;
  updateStatute(id: string, updates: Partial<InsertStatute>): Promise<Statute | undefined>;

  // Questions
  getQuestionsByDomain(domainId: string): Promise<Question[]>;
  createQuestion(question: InsertQuestion): Promise<Question>;

  // Analyses
  getAnalysesByMunicipalityAndDomain(municipalityId: string, domainId: string): Promise<Analysis[]>;
  createAnalysis(analysis: InsertAnalysis): Promise<Analysis>;
  updateAnalysis(id: string, updates: Partial<InsertAnalysis>): Promise<Analysis | undefined>;

  // Combined queries
  getMunicipalityDomains(municipalityId: string): Promise<MunicipalityDomain[]>;
}

export class JsonFileStorage implements IStorage {
  private dataDir: string;
  private municipalitiesFile: string;
  private domainsFile: string;

  constructor(dataDir: string = "data") {
    this.dataDir = dataDir;
    this.municipalitiesFile = path.join(dataDir, "municipalities.json");
    this.domainsFile = path.join(dataDir, "domains.json");
    this.ensureDataDir();
  }

  setDataDir(dataDir: string) {
    this.dataDir = dataDir;
    this.municipalitiesFile = path.join(dataDir, "municipalities.json");
    this.domainsFile = path.join(dataDir, "domains.json");
    this.ensureDataDir();
  }

  getDataDir(): string {
    return this.dataDir;
  }

  private async ensureDataDir() {
    await fs.ensureDir(this.dataDir);
    
    // Initialize files if they don't exist
    if (!await fs.pathExists(this.municipalitiesFile)) {
      await this.initializeMunicipalities();
    }
    
    if (!await fs.pathExists(this.domainsFile)) {
      await this.initializeDomains();
    }
  }

  private async initializeMunicipalities() {
    const municipalities: Municipality[] = [
      { id: randomUUID(), name: "Albany", type: "City", state: "NY", displayName: "Albany - City", singular: "albany" },
      { id: randomUUID(), name: "Bedford", type: "Town", state: "NY", displayName: "Bedford - Town", singular: "bedford" },
      { id: randomUUID(), name: "Buffalo", type: "City", state: "NY", displayName: "Buffalo - City", singular: "buffalo" },
      { id: randomUUID(), name: "Eastchester", type: "Town", state: "NY", displayName: "Eastchester - Town", singular: "eastchester" },
      { id: randomUUID(), name: "Harrison", type: "Town", state: "NY", displayName: "Harrison - Town", singular: "harrison" },
      { id: randomUUID(), name: "Larchmont", type: "Village", state: "NY", displayName: "Larchmont - Village", singular: "larchmont" },
      { id: randomUUID(), name: "Mamaroneck", type: "Town", state: "NY", displayName: "Mamaroneck - Town", singular: "mamaroneck" },
      { id: randomUUID(), name: "Mamaroneck", type: "Village", state: "NY", displayName: "Mamaroneck - Village", singular: "mamaroneck" },
      { id: randomUUID(), name: "Mount Vernon", type: "City", state: "NY", displayName: "Mount Vernon - City", singular: "mountvernon" },
      { id: randomUUID(), name: "New Rochelle", type: "City", state: "NY", displayName: "New Rochelle - City", singular: "newrochelle" },
      { id: randomUUID(), name: "Pelham", type: "Village", state: "NY", displayName: "Pelham - Village", singular: "pelham" },
      { id: randomUUID(), name: "Rye", type: "City", state: "NY", displayName: "Rye - City", singular: "rye" },
      { id: randomUUID(), name: "Scarsdale", type: "Village", state: "NY", displayName: "Scarsdale - Village", singular: "scarsdale" },
      { id: randomUUID(), name: "White Plains", type: "City", state: "NY", displayName: "White Plains - City", singular: "whiteplains" },
      { id: randomUUID(), name: "Yonkers", type: "City", state: "NY", displayName: "Yonkers - City", singular: "yonkers" },
    ];

    await fs.writeJson(this.municipalitiesFile, {
      municipalities,
      lastUpdated: new Date().toISOString()
    }, { spaces: 2 });
  }

  private async initializeDomains() {
    const domains: Domain[] = [
      { id: "trees", name: "trees", displayName: "Trees & Urban Forestry", description: "Tree removal, planting, and maintenance regulations" },
      { id: "zoning", name: "zoning", displayName: "Zoning & Land Use", description: "Land use regulations and zoning ordinances" },
      { id: "parking", name: "parking", displayName: "Parking Regulations", description: "Parking rules and enforcement" },
      { id: "noise", name: "noise", displayName: "Noise Control", description: "Noise ordinances and quiet hours" },
      { id: "building", name: "building", displayName: "Building Codes", description: "Construction and building regulations" },
      { id: "environmental", name: "environmental", displayName: "Environmental Protection", description: "Environmental protection and conservation" },
      { id: "business", name: "business", displayName: "Business Licensing", description: "Business permits and licensing requirements" },
    ];

    await fs.writeJson(this.domainsFile, {
      domains,
      lastUpdated: new Date().toISOString()
    }, { spaces: 2 });
  }

  async getMunicipalities(): Promise<Municipality[]> {
    const data = await fs.readJson(this.municipalitiesFile);
    return data.municipalities || [];
  }

  async getMunicipality(id: string): Promise<Municipality | undefined> {
    const municipalities = await this.getMunicipalities();
    return municipalities.find(m => m.id === id);
  }

  // Realm methods implementation
  async getRealms(): Promise<any[]> {
    const realmsFile = path.join(this.dataDir, "realms.json");
    if (!await fs.pathExists(realmsFile)) {
      return [];
    }
    const data = await fs.readJson(realmsFile);
    return data.realms || [];
  }

  async getRealm(id: string): Promise<any | undefined> {
    const realms = await this.getRealms();
    return realms.find(r => r.id === id);
  }

  async getEntitiesByRealm(realmId: string): Promise<any[]> {
    const realm = await this.getRealm(realmId);
    if (!realm) {
      return [];
    }
    
    const entityFile = path.join(this.dataDir, realm.entityFile);
    if (!await fs.pathExists(entityFile)) {
      return [];
    }
    
    const data = await fs.readJson(entityFile);
    // Handle both municipalities.json and school-districts.json formats
    return data.municipalities || data['school-districts'] || [];
  }

  async getEntity(realmId: string, entityId: string): Promise<any | undefined> {
    const entities = await this.getEntitiesByRealm(realmId);
    return entities.find(e => e.id === entityId);
  }

  async createMunicipality(municipality: InsertMunicipality): Promise<Municipality> {
    const municipalities = await this.getMunicipalities();
    const newMunicipality = { id: randomUUID(), ...municipality };
    municipalities.push(newMunicipality);
    
    await fs.writeJson(this.municipalitiesFile, {
      municipalities,
      lastUpdated: new Date().toISOString()
    }, { spaces: 2 });
    
    return newMunicipality;
  }

  async getDomains(): Promise<Domain[]> {
    const data = await fs.readJson(this.domainsFile);
    return data.domains || [];
  }

  async getDomainsByRealm(realmId: string): Promise<Domain[]> {
    // Get realm configuration from realms.json
    const realm = await this.getRealm(realmId);
    if (!realm || !realm.datapath) {
      // Fallback to global domains if realm not found
      return this.getDomains();
    }
    
    // First, try to get realm-specific domains file
    const realmDataPath = path.join(this.dataDir, realm.datapath);
    const realmDomainsFile = path.join(realmDataPath, 'domains.json');
    
    if (await fs.pathExists(realmDomainsFile)) {
      const data = await fs.readJson(realmDomainsFile);
      return data.domains || [];
    }
    
    // Fallback to global domains for backward compatibility
    return this.getDomains();
  }

  async getDomain(id: string): Promise<Domain | undefined> {
    const domains = await this.getDomains();
    return domains.find(d => d.id === id);
  }

  async createDomain(domain: InsertDomain): Promise<Domain> {
    const domains = await this.getDomains();
    const newDomain = { id: randomUUID(), ...domain };
    domains.push(newDomain);
    
    await fs.writeJson(this.domainsFile, {
      domains,
      lastUpdated: new Date().toISOString()
    }, { spaces: 2 });
    
    return newDomain;
  }

  async getStatutes(): Promise<Statute[]> {
    // Statutes are stored in individual files per municipality/domain
    const municipalities = await this.getMunicipalities();
    const domains = await this.getDomains();
    const statutes: Statute[] = [];
    
    for (const municipality of municipalities) {
      for (const domain of domains) {
        // Use the municipality directory name mapping
        const statuteFile = path.join(
          this.dataDir,
          domain.id, // Use domain.id instead of domain.name
          municipality.id,
          'statute.txt'
        );
        
        if (await fs.pathExists(statuteFile)) {
          const content = await fs.readFile(statuteFile, 'utf-8');
          statutes.push({
            id: `${municipality.id}-${domain.id}`,
            municipalityId: municipality.id,
            domainId: domain.id,
            content,
            sourceUrl: null,
            lastUpdated: (await fs.stat(statuteFile)).mtime.toISOString()
          });
        }
      }
    }
    
    return statutes;
  }

  async getStatute(id: string): Promise<Statute | undefined> {
    const statutes = await this.getStatutes();
    return statutes.find(s => s.id === id);
  }

  async getStatuteByMunicipalityAndDomain(municipalityId: string, domainId: string, realmId?: string): Promise<Statute | undefined> {
    // Get realm-specific data path
    let dataPath = 'environmental-municipal'; // default
    let realmType = 'statute'; // default
    if (realmId) {
      const realm = await this.getRealm(realmId);
      if (realm && realm.datapath) {
        dataPath = realm.datapath;
        realmType = realm.realmType || 'statute';
      }
    }
    
    // Check if municipality uses state code first
    const metadataPath = path.join(this.dataDir, dataPath, domainId, municipalityId, 'metadata.json');
    
    let targetMunicipalityId = municipalityId;
    if (await fs.pathExists(metadataPath)) {
      try {
        const metadata = await fs.readJson(metadataPath);
        if (metadata.referencesFolder === 'NY-State' || metadata.usesStateCode || metadata.stateCodeApplies || metadata.referencesStateCode) {
          targetMunicipalityId = 'NY-State';
        }
      } catch (error) {
        console.warn("Could not find metadata file for municipality: ", municipalityId, "at ", metadataPath);
      }
    }
    
    // Check for statute or policy file directly in realm-specific path
    const statuteFile = path.join(this.dataDir, dataPath, domainId, targetMunicipalityId, realmType + '.txt');
    console.debug("Looking for statute file at: ", statuteFile);
        
    if (await fs.pathExists(statuteFile)) {
      const content = await fs.readFile(statuteFile, 'utf-8');
      return {
        id: `${targetMunicipalityId}-${domainId}`,
        municipalityId: targetMunicipalityId,
        domainId: domainId,
        content,
        sourceUrl: null,
        lastUpdated: (await fs.stat(statuteFile)).mtime.toISOString()
      };
    }

    console.warn("Could not find statute file for municipality: ", municipalityId, "at ", statuteFile);
    return undefined;
  }

  async createStatute(statute: InsertStatute): Promise<Statute> {
    const id = `${statute.municipalityId}-${statute.domainId}`;
    const newStatute = { 
      id, 
      ...statute, 
      lastUpdated: new Date().toISOString() 
    };
    return newStatute;
  }

  async updateStatute(id: string, updates: Partial<InsertStatute>): Promise<Statute | undefined> {
    const existing = await this.getStatute(id);
    if (!existing) return undefined;
    
    return { 
      ...existing, 
      ...updates, 
      lastUpdated: new Date().toISOString() 
    };
  }

  async getQuestionsByDomain(domainId: string, realmId?: string): Promise<Question[]> {
    const domain = await this.getDomain(domainId);
    if (!domain) return [];
    
    // Use realm-specific path if realmId provided
    let dataPath = 'environmental-municipal'; // default
    if (realmId) {
      const realm = await this.getRealm(realmId);
      if (realm && realm.datapath) {
        dataPath = realm.datapath;
      }
    }
    
    const questionsFile = path.join(this.dataDir, dataPath, domain.name, 'questions.json');
    if (!await fs.pathExists(questionsFile)) return [];
    
    const data = await fs.readJson(questionsFile);
    return (data.questions || []).sort((a: Question, b: Question) => a.order - b.order);
  }

  async createQuestion(question: InsertQuestion): Promise<Question> {
    const newQuestion = { id: Date.now(), ...question };
    return newQuestion;
  }

  // Map WEN grades to colors (based on actual WEN spreadsheet codes)
  getGradeColor(grade: string): string {
    switch (grade) {
      // Green spectrum (good)
      case 'G+': return '#15803d'; // Dark green
      case 'G':  return '#84cc16'; // Lime green
      case 'G-': return '#65a30d'; // Darker lime
      
      // Yellow spectrum (okay/fair)  
      case 'Y+': return '#ca8a04'; // Dark yellow
      case 'Y':  return '#eab308'; // Yellow
      case 'Y-': return '#f59e0b'; // Orange-yellow
      
      // Red spectrum (poor)
      case 'R+': return '#ea580c'; // Orange-red
      case 'R':  return '#dc2626'; // Red
      case 'R-': return '#991b1b'; // Dark red
      
      // Other letter grades (neutral colors)
      case 'A': return '#3b82f6';   // Blue
      case 'B': return '#6366f1';   // Indigo
      case 'C': return '#8b5cf6';   // Purple
      case 'D': return '#d946ef';   // Fuchsia
      case 'F': return '#991b1b';   // Dark red (fail)
      case 'H': return '#06b6d4';   // Cyan
      case 'H-': return '#0891b2';  // Dark cyan
      case 'I': return '#10b981';   // Emerald
      case 'K': return '#f97316';   // Orange
      case 'L': return '#84cc16';   // Lime
      case 'M': return '#a3a3a3';   // Gray
      case 'N': return '#737373';   // Dark gray
      case 'O': return '#f59e0b';   // Amber
      case 'P': return '#ec4899';   // Pink
      case 'S': return '#14b8a6';   // Teal
      case 'T': return '#8b5cf6';   // Violet
      case 'V': return '#7c3aed';   // Purple
      
      default: return '#94a3b8';    // Slate gray for unknown
    }
  }

  async getAnalysesByMunicipalityAndDomain(municipalityId: string, domainId: string): Promise<Analysis[]> {
    const municipality = await this.getMunicipality(municipalityId);
    const domain = await this.getDomain(domainId);
    
    if (!municipality || !domain) return [];
    
    const analysisFile = path.join(
      this.dataDir,
      domain.id, // Use domain.id instead of domain.name
      municipalityId, // Use mapped directory name
      'analysis.json'
    );
    
    if (!await fs.pathExists(analysisFile)) return [];
    
    const analysisData = await fs.readJson(analysisFile);
    
    // Convert analysis.json structure to our API format
    if (analysisData.answers && Array.isArray(analysisData.answers)) {
      return analysisData.answers.map((answer: any) => ({
        id: `${municipalityId}-${domainId}-${answer.questionId}`,
        municipalityId,
        domainId,
        questionId: answer.questionId,
        answer: answer.answer,
        sourceReference: answer.relevantSections?.join(', ') || null,
        confidence: answer.confidence === 'high' ? 0.9 : answer.confidence === 'medium' ? 0.6 : 0.3,
        lastUpdated: analysisData.analyzedAt || null
      }));
    }
    
    return [];
  }

  async createAnalysis(analysis: InsertAnalysis): Promise<Analysis> {
    const id = `${analysis.municipalityId}-${analysis.domainId}-${analysis.questionId}`;
    const newAnalysis = { 
      id, 
      ...analysis, 
      lastUpdated: new Date().toISOString() 
    };
    return newAnalysis;
  }

  async updateAnalysis(id: string, updates: Partial<InsertAnalysis>): Promise<Analysis | undefined> {
    const existing = await this.getAnalysesByMunicipalityAndDomain(
      updates.municipalityId || '',
      updates.domainId || ''
    );
    
    const analysisItem = existing.find(a => a.id === id);
    if (!analysisItem) return undefined;
    
    return { 
      ...analysisItem, 
      ...updates, 
      lastUpdated: new Date().toISOString() 
    };
  }

  async getMunicipalityDomains(municipalityId: string): Promise<MunicipalityDomain[]> {
    const allDomains = await this.getDomains();
    
    // Check which domains have statute files for this municipality
    const municipalityDomainsWithAvailability: MunicipalityDomain[] = [];
    
    for (const domain of allDomains) {
      const statuteDir = path.join(this.dataDir, 'environmental-municipal', domain.id, municipalityId);
      const statuteExists = await fs.pathExists(path.join(statuteDir, 'statute.txt'));
      const analysisExists = await fs.pathExists(path.join(statuteDir, 'analysis.json'));
      
      // A domain is available if statute exists (analysis is optional)
      const isAvailable = statuteExists;
      
      // Try to read grade from metadata.json (WEN spreadsheet data) 
      let grade: string | null = null;
      let gradeColor: string | null = null;
      
      const metadataPath = path.join(statuteDir, 'metadata.json');
      if (await fs.pathExists(metadataPath)) {
        try {
          const metadata = await fs.readJson(metadataPath);
          // Extract grade from originalCellValue (e.g., "G- https://..." -> "G-")
          if (metadata.originalCellValue) {
            const gradeMatch = metadata.originalCellValue.match(/^([A-Z][+-]?)\s/);
            if (gradeMatch) {
              grade = gradeMatch[1];
              // Map grades to colors
              gradeColor = grade ? this.getGradeColor(grade) : null;
            }
          }
        } catch (error) {
          // Ignore metadata read errors
        }
      }

      // Fallback: Try to read from analysis.json if metadata doesn't have grade
      if (!grade) {
        const analysisPath = path.join(statuteDir, 'analysis.json');
        if (await fs.pathExists(analysisPath)) {
          try {
            const analysis = await fs.readJson(analysisPath);
            grade = analysis.grade || null;
            gradeColor = analysis.gradeColor || null;
          } catch (error) {
            // Ignore analysis read errors
          }
        }
      }
      
      municipalityDomainsWithAvailability.push({
        ...domain,
        available: isAvailable,
        grade,
        gradeColor
      });
    }
    
    return municipalityDomainsWithAvailability;
  }

  async getDomainSummary(domainId: string, realmId?: string): Promise<Array<{municipalityId: string, grade: string | null, gradeColor: string | null, available: boolean, stateCodeApplies: boolean}>> {
    // Get realm-specific entities if realmId provided
    const municipalities = realmId ? await this.getEntitiesByRealm(realmId) : await this.getMunicipalities();
    const domainSummary = [];
    
    // Get realm-specific data path
    let dataPath = 'environmental-municipal'; // fallback
    if (realmId) {
      const realm = await this.getRealm(realmId);
      if (realm && realm.datapath) {
        // Remove 'data/' prefix if present since we'll add it below
        dataPath = realm.datapath.replace(/^data\//, '');
      }
    }
    
    for (const municipality of municipalities) {
      const statuteDir = path.join(this.dataDir, dataPath, domainId, municipality.id);
      const statuteExists = await fs.pathExists(path.join(statuteDir, 'statute.txt'));
      
      let grade: string | null = null;
      let gradeColor: string | null = null;
      let stateCodeApplies = false;
      
      // Check for metadata.json to determine if municipality uses state code
      const metadataPath = path.join(statuteDir, 'metadata.json');
      if (await fs.pathExists(metadataPath)) {
        try {
          const metadata = await fs.readJson(metadataPath);
          // Check if municipality references NY-State folder or uses state code
          if (metadata.referencesFolder === 'NY-State' || metadata.usesStateCode || metadata.stateCodeApplies || metadata.referencesStateCode) {
            stateCodeApplies = true;
            grade = 'NY State';
            gradeColor = '#3b82f6'; // Blue color for state code municipalities
          }
        } catch (error) {
          // Ignore metadata read errors
        }
      }
      
      // If not using state code, try to read grade from analysis.json
      if (!stateCodeApplies) {
        const analysisPath = path.join(statuteDir, 'analysis.json');
        if (await fs.pathExists(analysisPath)) {
          try {
            const analysis = await fs.readJson(analysisPath);
            
            // Check if this uses NY State code (fallback detection)
            if (analysis.usesStateCode || analysis.processingMethod === 'state-code-detection') {
              stateCodeApplies = true;
              grade = 'NY State';
              gradeColor = '#3b82f6'; // Blue color for NY State
            } else if (analysis.grades && analysis.grades['WEN']) {
              // Use WEN grade from analysis
              grade = analysis.grades['WEN'];
              gradeColor = this.getGradeColor(grade);
            }
          } catch (error) {
            // Ignore analysis read errors
          }
        }
      }

      // Fallback: Try to read from metadata.json if no grade found and not using state code
      if (!grade && !stateCodeApplies) {
        try {
          const metadata = await fs.readJson(metadataPath);
          // Extract grade from originalCellValue (e.g., "G- https://..." -> "G-")
          if (metadata.originalCellValue) {
            const gradeMatch = metadata.originalCellValue.match(/^([A-Z][+-]?)\s/);
            if (gradeMatch) {
              grade = gradeMatch[1];
              gradeColor = this.getGradeColor(grade);
            }
          } else if (metadata.grade) {
            // Fallback to metadata.grade
            grade = metadata.grade;
            gradeColor = this.getGradeColor(grade);
          }
        } catch (error) {
          // Ignore metadata read errors
        }
      }
      
      domainSummary.push({
        municipalityId: municipality.id,
        grade,
        gradeColor,
        available: statuteExists,
        stateCodeApplies
      });
    }
    
    return domainSummary;
  }
}

export const storage = new JsonFileStorage();
