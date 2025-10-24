import type { Express } from "express";
import { createServer, type Server } from "http";
import path from "path";
import fs from "fs-extra";
import { storage } from "./storage";
import { z } from "zod";
import { vectorService } from "./services/vectorService.js";
import { createOrdinizer } from "../../src/index.js";
import type { RealmConfig } from "../../src/types.js";

// Initialize Ordinizer instances for each realm (cached)
const ordinizerCache = new Map<string, any>();

// Helper function to resolve realm-specific data path
function getRealmDataPath(realm: any): string {
  const baseDataDir = storage.getDataDir();
  if (realm.datapath) {
    return path.join(baseDataDir, realm.datapath);
  }
  // Fallback to environmental-municipal for backward compatibility
  return path.join(baseDataDir, 'environmental-municipal');
}

async function getOrdinizer(realmId: string) {
  if (!ordinizerCache.has(realmId)) {
    const realm = await storage.getRealm(realmId);
    if (!realm) {
      throw new Error(`Realm not found: ${realmId}`);
    }
    
    // Create a proper RealmConfig for the ordinizer library
    const realmConfig: RealmConfig = {
      id: realm.id,
      displayName: realm.displayName || realm.id,
      type: (realm.realmType || 'statute') as 'statute' | 'policy',
      dataPath: getRealmDataPath(realm),
      entityType: realm.entityType || 'municipalities',
      terminology: realm.terminology || {
        entitySingular: 'Municipality',
        entityPlural: 'Municipalities',
        domainSingular: 'Domain',
        domainPlural: 'Domains',
        documentSingular: 'Ordinance',
        documentPlural: 'Ordinances'
      },
      scoring: realm.scoring || {
        colorGradient: { low: '#bbf7d0', medium: '#86efac', high: '#22c55e' },
        thresholds: { low: 0.3, high: 0.7 }
      },
      paths: {
        entitiesFile: realm.entityFile || 'municipalities.json',
        domainsFile: 'domains.json',
        questionsPattern: '{domainId}/questions.json',
        analysisPattern: '{domainId}/{entityId}/analysis.json',
        metadataPattern: '{domainId}/{entityId}/metadata.json'
      }
    };
    
    const ordinizer = await createOrdinizer(realmConfig);
    
    ordinizerCache.set(realmId, ordinizer);
  }
  
  return ordinizerCache.get(realmId);
}

// Backward compatible score color utility
function getEnvironmentalScoreColor(score: number, isDisplayScale = false): string {
  const normalizedScore = isDisplayScale ? score : score * 10;
  
  if (normalizedScore >= 8.0) return '#22c55e';     // Strong green
  if (normalizedScore >= 5.0) return '#65d47f';     // Moderate green  
  if (normalizedScore >= 2.0) return '#a7e6b7';     // Weak green
  return '#bbf7d0';                                 // Very weak green
}

// Helper function to get main source from metadata based on realm type (backward compatibility)
async function getMainSourceFromMetadata(metadata: any, realmConfig: any, realmId: string, domainId: string = '', entityId: string = '') {
  if (!metadata || !realmConfig) return null;
  
  try {
    const ordinizer = await getOrdinizer(realmId);
    // Use the correct ordinizer method for getting source metadata
    if (entityId && domainId) {
      const source = await ordinizer.getPrimarySource(domainId, entityId);
      return source ? { sourceUrl: source, type: realmConfig.type || 'statute' } : null;
    }
    
    // Fallback to direct metadata processing for backward compatibility
    const { getSourceForRealm } = await import("../../src/metadata.js");
    return getSourceForRealm(metadata, realmConfig.type || 'statute');
  } catch (error) {
    console.warn('Failed to get source from metadata via ordinizer:', error);
    return null;
  }
}

export async function registerRoutes(
  app: Express, 
  apiPrefix: string = "/api",
  dataPath: string = path.join(process.cwd(), "data")
): Promise<Server> {
  // Initialize storage with the provided data path
  storage.setDataDir(dataPath);
  // Get all realms
  app.get(`${apiPrefix}/realms`, async (_req, res) => {
    try {
      const realms = await storage.getRealms();
      res.json(realms);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch realms" });
    }
  });

  // Get a specific realm
  app.get(`${apiPrefix}/realms/:realmId`, async (req, res) => {
    try {
      const { realmId } = req.params;
      const realm = await storage.getRealm(realmId);
      if (!realm) {
        return res.status(404).json({ error: "Realm not found" });
      }
      res.json(realm);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch realm" });
    }
  });

  // Get domains with questions for a specific realm
  app.get(`${apiPrefix}/realms/:realmId/domains/questions`, async (req, res) => {
    try {
      const { realmId } = req.params;
      
      // Security: Validate realmId against known realms first
      const realm = await storage.getRealm(realmId);
      if (!realm) {
        return res.status(404).json({ error: "Realm not found" });
      }
      
      // Get realm-specific domains using the correct storage method
      const domains = await storage.getDomainsByRealm(realmId);
      
      // Get the correct data path from realm configuration
      const baseDataPath = getRealmDataPath(realm);
      
      // For each domain, load questions from the questions.json file
      const domainsWithQuestions = await Promise.all(
        domains.map(async (domain) => {
          try {
            // Security: Validate domain ID contains only safe characters
            if (!/^[A-Za-z0-9-_]+$/.test(domain.id)) {
              console.warn(`Invalid domain ID detected: ${domain.id}`);
              throw new Error('Invalid domain ID');
            }
            
            // Build secure path using realm's datapath
            const questionsPath = path.resolve(baseDataPath, domain.id, 'questions.json');
            
            // Security: Ensure the resolved path stays within the base directory
            const normalizedBase = path.resolve(baseDataPath);
            if (!questionsPath.startsWith(normalizedBase + path.sep) && questionsPath !== normalizedBase) {
              console.warn(`Path traversal attempt detected: ${questionsPath}`);
              throw new Error('Invalid path');
            }
            
            let questions = [];
            if (await fs.pathExists(questionsPath)) {
              const questionsData = await fs.readJson(questionsPath);
              // Normalize questions format - handle both array and object with questions field
              questions = Array.isArray(questionsData) ? questionsData : questionsData.questions || [];
            }
            
            const totalWeight = questions.reduce((sum: number, q: any) => sum + (q.weight || 1), 0);
            
            return {
              id: domain.id,
              name: domain.name,
              displayName: domain.displayName || domain.name,
              questions: questions || [],
              questionCount: questions.length,
              totalWeight
            };
          } catch (error) {
            console.error(`Error loading questions for domain ${domain.id}:`, error);
            return {
              id: domain.id,
              name: domain.name,
              displayName: domain.displayName || domain.name,
              questions: [],
              questionCount: 0,
              totalWeight: 0
            };
          }
        })
      );
      
      res.json(domainsWithQuestions);
    } catch (error) {
      console.error('Error fetching realm domains with questions:', error);
      res.status(500).json({ error: "Failed to fetch realm domains with questions" });
    }
  });

  // Get entities for a specific realm (municipalities, school districts, etc.)
  app.get(`${apiPrefix}/realms/:realmId/entities`, async (req, res) => {
    try {
      const { realmId } = req.params;
      const entities = await storage.getEntitiesByRealm(realmId);
      res.json(entities);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch realm entities" });
    }
  });

  // Get a specific entity within a realm
  app.get(`${apiPrefix}/realms/:realmId/entities/:entityId`, async (req, res) => {
    try {
      const { realmId, entityId } = req.params;
      const entity = await storage.getEntity(realmId, entityId);
      if (!entity) {
        return res.status(404).json({ error: "Entity not found" });
      }
      res.json(entity);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch entity" });
    }
  });

  // Get all municipalities (legacy endpoint for backward compatibility)
  app.get(`${apiPrefix}/municipalities`, async (_req, res) => {
    try {
      const municipalities = await storage.getMunicipalities();
      res.json(municipalities);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch municipalities" });
    }
  });

  // Get domains for a specific realm
  app.get(`${apiPrefix}/realms/:realmId/domains`, async (req, res) => {
    try {
      const { realmId } = req.params;
      const domains = await storage.getDomainsByRealm(realmId);
      // Filter domains based on "show" property - only include domains where show is not false
      const visibleDomains = domains.filter((domain: any) => domain.show !== false);
      res.json(visibleDomains);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch realm domains" });
    }
  });

  // Get all domains (legacy endpoint for backward compatibility)
  app.get(`${apiPrefix}/domains`, async (_req, res) => {
    try {
      const domains = await storage.getDomains();
      // Filter domains based on "show" property - only include domains where show is not false
      const visibleDomains = domains.filter((domain: any) => domain.show !== false);
      res.json(visibleDomains);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch domains" });
    }
  });

  // Get domains available for a specific jurisdiction in a realm
  app.get(`${apiPrefix}/realms/:realmId/jurisdictions/:jurisdictionId/domains`, async (req, res) => {
    // Temporarily return empty array to stop errors - this endpoint needs debugging
    res.json([]);
  });

  // Get domains for a specific municipality
  app.get(`${apiPrefix}/municipalities/:id/domains`, async (req, res) => {
    try {
      const { id } = req.params;
      const domains = await storage.getMunicipalityDomains(id);
      res.json(domains);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch municipality domains" });
    }
  });

  // Get consolidated domain data (scores + summary) for map efficiency
  app.get(`${apiPrefix}/domains/:realmId/:domainId/summary`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      
      // Get both summary and scores data
      const ordinizer = await getOrdinizer(realmId);
      const [summary, scores] = await Promise.all([
        storage.getDomainSummary(domainId, realmId),
        ordinizer.getDomainScores(domainId)
      ]);
      
      // Merge the data to include scores and colors in the summary
      const consolidatedData = summary.map((item: any) => ({
        ...item,
        score: scores[item.municipalityId] || 0,
        // Normalize score from 0-10 scale to 0-1 scale for color calculation
        scoreColor: scores[item.municipalityId] ? ordinizer.getScoreColorHex(scores[item.municipalityId] / 10) : null
      }));
      
      res.json(consolidatedData);
    } catch (error) {
      console.error('Error fetching consolidated domain data:', error);
      res.status(500).json({ error: 'Failed to fetch domain data' });
    }
  });

  // Get meta-analysis for a domain
  app.get(`${apiPrefix}/domains/:realmId/:domainId/meta-analysis`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      
      // Get realm-specific data path using storage
      const realm = await storage.getRealm(realmId);
      if (!realm) {
        return res.status(404).json({ error: 'Realm not found' });
      }
      const dataPath = getRealmDataPath(realm);
      
      const metaAnalysisPath = path.join(dataPath, domainId, 'meta-analysis.json');
      
      if (!await fs.pathExists(metaAnalysisPath)) {
        return res.status(404).json({ error: 'Meta-analysis not found for this domain' });
      }
      
      const metaAnalysis = await fs.readJson(metaAnalysisPath);
      
      // Add domain description from questions.json
      const questionsPath = path.join(dataPath, domainId, 'questions.json');
      if (await fs.pathExists(questionsPath)) {
        const questionsData = await fs.readJson(questionsPath);
        if (questionsData.description) {
          metaAnalysis.domain.description = questionsData.description;
        }
      }
      
      res.json(metaAnalysis);
    } catch (error) {
      console.error('Error fetching meta-analysis:', error);
      res.status(500).json({ error: 'Failed to fetch meta-analysis' });
    }
  });

  // Matrix view endpoint for domain analysis (realm-aware)
  app.get(`${apiPrefix}/domains/:realmId/:domainId/matrix`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      
      // Get realm-specific data path and config using storage
      const realm = await storage.getRealm(realmId);
      if (!realm) {
        return res.status(404).json({ error: 'Realm not found' });
      }
      const dataPath = getRealmDataPath(realm);
      const matrixRealmConfig = realm; // Store for metadata source resolution
      
      const domainDir = path.join(dataPath, domainId);
      
      if (!await fs.pathExists(domainDir)) {
        return res.status(404).json({ error: 'Domain not found' });
      }

      // Load questions
      const questionsPath = path.join(domainDir, 'questions.json');
      if (!await fs.pathExists(questionsPath)) {
        return res.status(404).json({ error: 'Questions not found for domain' });
      }
      const questionsData = await fs.readJson(questionsPath);
      
      // Handle both array and object format for questions
      const questions = Array.isArray(questionsData) 
        ? questionsData 
        : questionsData.questions || [];
      
      if (questions.length === 0) {
        console.error(`No questions found in ${questionsPath}, data structure:`, questionsData);
        return res.status(404).json({ error: 'No questions found for domain' });
      }

      // Get domain display name (realm-aware)
      const domainsData = await storage.getDomainsByRealm(realmId);
      const domainInfo = domainsData.find((d: any) => d.id === domainId);
      const displayName = domainInfo?.displayName || domainId;

      // Load all municipality analyses
      const municipalities: Array<{
        id: string;
        displayName: string;
        scores: Record<number, {
          score: number;
          confidence: number;
          answer: string;
          sourceRefs: string[];
        }>;
        totalScore: number;
        statute?: {
          number: string;
          title: string;
          url: string;
        };
        referencesStateCode?: boolean;
      }> = [];

      const municipalityDirs = (await fs.readdir(domainDir, { withFileTypes: true }))
        .filter(dirent => dirent.isDirectory() && (dirent.name.startsWith('NY-') || dirent.name === 'NY-State'))
        .map(dirent => dirent.name);

      for (const municipalityDir of municipalityDirs) {
        // Handle NY-State directory (if it exists)
        if (municipalityDir === 'NY-State') {
          const analysisPath = path.join(domainDir, municipalityDir, 'analysis.json');
          
          if (await fs.pathExists(analysisPath)) {
            try {
              const analysisData = await fs.readJson(analysisPath);
              
              // Extract scores for NY State
              const scores: Record<number, any> = {};
              let totalScore = 0;
              let totalQuestions = 0;
              
              if (analysisData.questions && Array.isArray(analysisData.questions)) {
                analysisData.questions.forEach((q: any) => {
                  if (q.id && typeof q.score === 'number') {
                    scores[q.id] = {
                      score: q.score,
                      confidence: q.confidence || 0,
                      answer: q.answer || 'Not specified in the statute.',
                      sourceRefs: q.sourceRefs || []
                    };
                    totalScore += q.score;
                    totalQuestions++;
                  }
                });
              }

              // Get NY State statute information
              let statuteInfo = null;
              const metadataPath = path.join(domainDir, municipalityDir, 'metadata.json');
              if (await fs.pathExists(metadataPath)) {
                try {
                  const metadata = await fs.readJson(metadataPath);
                  const source = await getMainSourceFromMetadata(metadata, matrixRealmConfig || { type: 'statute' }, realmId, domainId, 'NY-State');
                  if (source && 'sourceUrl' in source && source.sourceUrl) {
                    const statuteNumber = metadata.statuteNumber || metadata.number || 'NY State Code';
                    const statuteTitle = metadata.statuteTitle || metadata.title || '';
                    
                    statuteInfo = {
                      number: statuteNumber,
                      title: statuteTitle,
                      url: source.sourceUrl
                    };
                  }
                } catch (error: any) {
                  console.error(`Error loading metadata for NY-State:`, error);
                }
              }

              municipalities.push({
                id: 'NY-State',
                displayName: 'NY State',
                scores,
                totalScore: totalQuestions > 0 ? totalScore / totalQuestions : 0,
                statute: statuteInfo || undefined
              });
            } catch (error) {
              console.error(`Error loading analysis for NY-State:`, error);
            }
          }
          continue;
        }

        // Handle regular municipalities
        const analysisPath = path.join(domainDir, municipalityDir, 'analysis.json');
        const metadataPath = path.join(domainDir, municipalityDir, 'metadata.json');
        
        // Get municipality info to check for test flag (realm-aware)
        let isTestMunicipality = false;
        try {
          const municipalitiesData = await storage.getEntitiesByRealm(realmId);
          const municipality = municipalitiesData.find((m: any) => m.id === municipalityDir);
          if (municipality && (municipality as any).test === true) {
            isTestMunicipality = true;
          }
        } catch (error: any) {
          console.warn(`Could not load municipalities.json to check test flag: ${error.message}`);
        }
        
        // Skip test municipalities
        if (isTestMunicipality) {
          continue;
        }
        
        // Check if this municipality references state code
        let referencesStateCode = false;
        if (await fs.pathExists(metadataPath)) {
          try {
            const metadata = await fs.readJson(metadataPath);
            referencesStateCode = metadata.referencesStateCode === true;
          } catch (error: any) {
            console.error(`Error reading metadata for ${municipalityDir}:`, error);
          }
        }

        // If municipality references state code, add it without analysis but with state code indicator
        if (referencesStateCode) {
          // Get municipality display name
          let cleanDisplayName = municipalityDir;
          try {
            const municipalitiesData = await storage.getMunicipalities();
            const municipality = municipalitiesData.find((m: any) => m.id === municipalityDir);
            if (municipality && municipality.displayName) {
              cleanDisplayName = municipality.displayName;
            } else {
              cleanDisplayName = municipalityDir
                .replace('NY-', '')
                .replace(/([A-Z])/g, ' $1')
                .replace(/^\s+/, '')
                .replace(/-/g, ' ')
                .trim();
            }
          } catch (error: any) {
            console.warn(`Could not load municipalities.json for display name: ${error.message}`);
          }

          municipalities.push({
            id: municipalityDir,
            displayName: cleanDisplayName,
            scores: {}, // Empty scores for state code references
            totalScore: 0,
            statute: {
              number: 'State Code',
              title: '',
              url: ''
            },
            referencesStateCode: true
          });
          continue;
        }
        
        if (!await fs.pathExists(analysisPath)) {
          continue;
        }

        try {
          const analysisData = await fs.readJson(analysisPath);
          
          // Extract scores for each question
          const scores: Record<number, any> = {};
          let totalScore = 0;
          let totalQuestions = 0;
          
          if (analysisData.questions && Array.isArray(analysisData.questions)) {
            analysisData.questions.forEach((q: any) => {
              if (q.id && typeof q.score === 'number') {
                scores[q.id] = {
                  score: q.score,
                  confidence: q.confidence || 0,
                  answer: q.answer || 'Not specified in the statute.',
                  sourceRefs: q.sourceRefs || []
                };
                totalScore += q.score;
                totalQuestions++;
              }
            });
          }

          // Clean up municipality display name - get from municipalities.json first
          let cleanDisplayName = analysisData.municipality?.displayName;
          
          // Try to get proper displayName from municipalities.json
          try {
            const municipalitiesData = await storage.getMunicipalities();
            const municipality = municipalitiesData.find((m: any) => m.id === municipalityDir);
            if (municipality && municipality.displayName) {
              cleanDisplayName = municipality.displayName;
            }
          } catch (error: any) {
            console.warn(`Could not load municipalities.json for display name: ${error.message}`);
          }
          
          // If still no displayName or it's "Unknown", use directory-based name as fallback
          if (!cleanDisplayName || cleanDisplayName.startsWith('Unknown') || cleanDisplayName === 'undefined') {
            cleanDisplayName = municipalityDir
              .replace('NY-', '')
              .replace(/([A-Z])/g, ' $1')
              .replace(/^\s+/, '') // Remove leading spaces
              .replace(/-/g, ' ')
              .trim();
          }

          // Get statute information from metadata
          let statuteInfo = null;
          const metadataPath = path.join(domainDir, municipalityDir, 'metadata.json');
          if (await fs.pathExists(metadataPath)) {
            try {
              const metadata = await fs.readJson(metadataPath);
              const source = await getMainSourceFromMetadata(metadata, matrixRealmConfig || { type: 'statute' }, realmId, domainId, municipalityDir);
              if (source?.sourceUrl) {
                // Use statute number and title from metadata if available
                const statuteNumber = metadata.statuteNumber || metadata.number || 'Local Code';
                const statuteTitle = metadata.statuteTitle || metadata.title || '';
                
                statuteInfo = {
                  number: statuteNumber,
                  title: statuteTitle,
                  url: source.sourceUrl
                };
              }
            } catch (error: any) {
              console.error(`Error loading metadata for ${municipalityDir}:`, error);
            }
          }
          
          municipalities.push({
            id: municipalityDir,
            displayName: cleanDisplayName,
            scores,
            totalScore: totalQuestions > 0 ? totalScore / totalQuestions : 0,
            statute: statuteInfo || undefined
          });
        } catch (error) {
          console.error(`Error loading analysis for ${municipalityDir}:`, error);
        }
      }

      // Sort municipalities: NY State first, then alphabetically
      municipalities.sort((a, b) => {
        if (a.id === 'NY-State') return -1;
        if (b.id === 'NY-State') return 1;
        return a.displayName.localeCompare(b.displayName);
      });



      if (!Array.isArray(questions)) {
        console.error('Questions is not an array:', questions);
        return res.status(500).json({ error: 'Invalid questions data structure' });
      }

      const matrixData = {
        domain: {
          id: domainId,
          displayName: displayName
        },
        questions: questions.map((q: any) => ({
          id: q.id,
          question: q.question,
          category: q.category || `Q${q.id}`
        })),
        municipalities
      };

      res.json(matrixData);
    } catch (error) {
      console.error('Error loading matrix data:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Admin route for viewing all domains with their questions and weights
  app.get(`${apiPrefix}/admin/domains`, async (req, res) => {
    try {
      const { realm: realmId } = req.query;
      
      // Default to first available realm if not specified
      const targetRealmId = typeof realmId === 'string' ? realmId : 'westchester-municipal-environmental';
      const ordinizer = await getOrdinizer(targetRealmId);
      
      const domains = await ordinizer.getDomains();
      const domainsWithQuestions = [];
      
      for (const domain of domains) {
        let questions = [];
        
        try {
          const questionsData = await ordinizer.getQuestions(domain.id);
          
          // Extract only the relevant fields for admin view
          questions = questionsData.map((q: any) => ({
            id: q.id,
            category: q.category,
            question: q.question || q.text,
            weight: q.weight || 1, // Default weight is 1
            order: q.order
          }));
        } catch (error) {
          console.error(`Error reading questions for domain ${domain.id}:`, error);
        }
        
        domainsWithQuestions.push({
          ...domain,
          questions,
          questionCount: questions.length,
          totalWeight: questions.reduce((sum: number, q: any) => sum + (q.weight || 1), 0)
        });
      }
      
      res.json(domainsWithQuestions);
    } catch (error) {
      console.error('Error fetching admin domains data:', error);
      res.status(500).json({ error: 'Failed to fetch admin domains data' });
    }
  });

  // Get map boundaries for a specific realm (generalized endpoint)
  app.get(`${apiPrefix}/map-boundaries`, async (req, res) => {
    try {
      const { realm: realmId } = req.query;
      
      if (!realmId || typeof realmId !== 'string') {
        return res.status(400).json({ error: 'Realm parameter is required' });
      }
      
      // Get realm configuration using storage
      const realmConfig = await storage.getRealm(realmId);
      if (!realmConfig) {
        return res.status(404).json({ error: `Realm '${realmId}' not found` });
      }
      
      if (!realmConfig.mapBoundaries) {
        return res.status(404).json({ error: `No boundary data configured for realm: ${realmId}` });
      }
      
      // Construct boundary file path based on realm configuration
      const boundaryFileName = realmConfig.mapBoundaries;
      const baseDataDir = storage.getDataDir();
      const boundariesPath = path.join(baseDataDir, 'gis', boundaryFileName);
      
      if (!await fs.pathExists(boundariesPath)) {
        return res.status(404).json({ error: `Boundary data file not found for realm: ${realmId} (${boundaryFileName})` });
      }
      
      const boundaries = await fs.readJson(boundariesPath);
      res.json(boundaries);
    } catch (error) {
      console.error('Error loading boundaries:', error);
      res.status(500).json({ error: 'Failed to load boundary data' });
    }
  });

  // Generic source data endpoint
  app.get(`${apiPrefix}/sourcedata`, async (req, res) => {
    try {
      const { source } = req.query;
      
      if (!source) {
        return res.status(400).json({ error: 'Source parameter is required' });
      }
      
      // Load datasources configuration
      const baseDataDir = storage.getDataDir();
      const datasourcesPath = path.join(baseDataDir, 'datasources.json');
      if (!await fs.pathExists(datasourcesPath)) {
        return res.status(404).json({ error: 'Datasources configuration not found' });
      }
      
      const datasources = await fs.readJson(datasourcesPath);
      const sourceConfig = datasources.sources.find((s: any) => s.id === source);
      
      if (!sourceConfig) {
        return res.status(404).json({ error: `Source '${source}' not found` });
      }
      
      // Load the actual data file
      const dataPath = path.join(baseDataDir, sourceConfig.dataFile);
      if (!await fs.pathExists(dataPath)) {
        return res.status(404).json({ error: `Data file not found for source '${source}'` });
      }
      
      const sourceData = await fs.readJson(dataPath);
      res.json({
        source: sourceConfig,
        data: sourceData
      });
    } catch (error) {
      console.error('Error loading source data:', error);
      res.status(500).json({ error: 'Failed to load source data' });
    }
  });

  // Get combined matrix data for all domains and municipalities (realm-specific)
  app.get(`${apiPrefix}/realms/:realmId/combined-matrix`, async (req, res) => {
    try {
      const { realmId } = req.params;
      
      // Get realm-specific data path using storage
      const realm = await storage.getRealm(realmId);
      if (!realm) {
        return res.status(404).json({ error: 'Realm not found' });
      }
      const realmDataPath = getRealmDataPath(realm);
      
      // Get realm-specific domains and entities
      const domains = await storage.getDomainsByRealm(realmId);
      const visibleDomains = domains.filter((d: any) => d.show !== false);
      const municipalities = await storage.getEntitiesByRealm(realmId);
      
      // Filter out test municipalities and sort alphabetically
      const validMunicipalities = municipalities
        .filter((m: any) => !(m as any).test)
        .sort((a: any, b: any) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
      
      // Build matrix data
      const matrixData: Array<{
        municipality: {
          id: string;
          displayName: string;
        };
        domains: Record<string, {
          statuteNumber?: string;
          statuteTitle?: string;
          sourceUrl?: string;
          score?: number;
          scoreColor?: string;
          referencesStateCode?: boolean;
          hasStatute: boolean;
        }>;
      }> = [];
      
      for (const municipality of validMunicipalities) {
        const municipalityData = {
          municipality: {
            id: municipality.id,
            displayName: municipality.displayName || municipality.name
          },
          domains: {} as Record<string, any>
        };
        
        for (const domain of visibleDomains) {
          const domainDir = path.join(realmDataPath, domain.id);
          const municipalityDir = path.join(domainDir, municipality.id);
          const analysisPath = path.join(municipalityDir, 'analysis.json');
          const metadataPath = path.join(municipalityDir, 'metadata.json');
          
          let domainData: {
            hasStatute: boolean;
            referencesStateCode: boolean;
            statuteNumber?: string;
            statuteTitle?: string;
            sourceUrl?: string;
            score?: number;
            scoreColor?: string;
          } = {
            hasStatute: false,
            referencesStateCode: false
          };
          
          // Check if municipality references state code
          if (await fs.pathExists(metadataPath)) {
            try {
              const metadata = await fs.readJson(metadataPath);
              if (metadata.referencesStateCode === true) {
                domainData.referencesStateCode = true;
                domainData.hasStatute = true;
              }
            } catch (error: any) {
              console.error(`Error reading metadata for ${municipality.id}/${domain.id}:`, error);
            }
          }
          
          // Check for analysis and statute data
          if (await fs.pathExists(analysisPath) && !domainData.referencesStateCode) {
            try {
              const analysisData = await fs.readJson(analysisPath);
              domainData.hasStatute = true;
              
              // Calculate overall score
              if (analysisData.questions && Array.isArray(analysisData.questions)) {
                let totalScore = 0;
                let totalQuestions = 0;
                
                analysisData.questions.forEach((q: any) => {
                  if (q.id && typeof q.score === 'number') {
                    totalScore += q.score;
                    totalQuestions++;
                  }
                });
                
                if (totalQuestions > 0) {
                  domainData.score = totalScore / totalQuestions;
                  
                  // Get score color using centralized utility
                  const normalizedScore = domainData.score * 10; // Convert to 0-10 scale for display
                  domainData.scoreColor = getEnvironmentalScoreColor(normalizedScore, true);
                }
              }
              
              // Get statute information (prefer id over number, title over name)
              if (analysisData.statute) {
                domainData.statuteNumber = analysisData.statute.id || analysisData.statute.number || '';
                domainData.statuteTitle = analysisData.statute.title || analysisData.statute.name || '';
              }
            } catch (error: any) {
              console.error(`Error reading analysis for ${municipality.id}/${domain.id}:`, error);
            }
          }
          
          // Always check metadata for statute information (whether analysis exists or not)
          if (await fs.pathExists(metadataPath)) {
            try {
              const metadata = await fs.readJson(metadataPath);
              
              // Always get sourceUrl from metadata
              domainData.sourceUrl = metadata.sourceUrl;
              
              // If we don't have statute info yet, get it from metadata
              if (!domainData.statuteNumber) {
                domainData.statuteNumber = metadata.statuteId || metadata.id || metadata.statuteNumber || metadata.number || '';
              }
              if (!domainData.statuteTitle) {
                domainData.statuteTitle = metadata.statuteTitle || metadata.title || metadata.name || '';
              }
              
              // Mark as having statute if we found statute info in metadata
              if ((metadata.statuteNumber || metadata.number || metadata.statuteId || metadata.id) && !domainData.referencesStateCode) {
                domainData.hasStatute = true;
              }
            } catch (error: any) {
              console.error(`Error reading metadata for statute info ${municipality.id}/${domain.id}:`, error);
            }
          }
          
            // This section is now handled above in the consolidated metadata check
          
          municipalityData.domains[domain.id] = domainData;
        }
        
        matrixData.push(municipalityData);
      }
      
      res.json({
        domains: visibleDomains.map((d: any) => ({
          id: d.id,
          displayName: d.displayName || d.name,
          description: d.description
        })),
        municipalities: matrixData
      });
    } catch (error) {
      console.error('Error generating combined matrix:', error);
      res.status(500).json({ error: 'Failed to generate combined matrix' });
    }
  });

  // Get available data sources
  app.get(`${apiPrefix}/datasources`, async (req, res) => {
    try {
      const baseDataDir = storage.getDataDir();
      const datasourcesPath = path.join(baseDataDir, 'datasources.json');
      if (!await fs.pathExists(datasourcesPath)) {
        return res.status(404).json({ error: 'Datasources configuration not found' });
      }
      
      const datasources = await fs.readJson(datasourcesPath);
      res.json(datasources);
    } catch (error) {
      console.error('Error loading datasources:', error);
      res.status(500).json({ error: 'Failed to load datasources' });
    }
  });

  // Serve statute files
  app.get(`${apiPrefix}/statute/:domainId/:municipalityId`, async (req, res) => {
    try {
      const { domainId, municipalityId } = req.params;
      const { realm: realmId } = req.query;
      
      const targetRealmId = typeof realmId === 'string' ? realmId : 'westchester-municipal-environmental';
      const ordinizer = await getOrdinizer(targetRealmId);
      const adapter = ordinizer.getConfig().getAdapter();
      
      // Use adapter's safe path resolution
      const statutePath = adapter.safeResolve(`${domainId}/${adapter.normalizeEntityId(municipalityId)}/statute.txt`);
      
      if (!await fs.pathExists(statutePath)) {
        return res.status(404).json({ error: 'Statute file not found' });
      }
      
      const statuteContent = await fs.readFile(statutePath, 'utf-8');
      res.setHeader('Content-Type', 'text/plain');
      res.send(statuteContent);
    } catch (error) {
      console.error('Error serving statute:', error);
      res.status(500).json({ error: 'Failed to serve statute file' });
    }
  });

  // Get municipalities that have specified a particular question
  app.get(`${apiPrefix}/question-municipalities/:domainId/:questionId`, async (req, res) => {
    try {
      const { domainId, questionId } = req.params;
      const { realm: realmId } = req.query;
      const municipalitiesWithAnswer: { id: string; name: string; answer: string }[] = [];
      
      const targetRealmId = typeof realmId === 'string' ? realmId : 'westchester-municipal-environmental';
      const ordinizer = await getOrdinizer(targetRealmId);
      
      // Get all entities from the ordinizer
      const entities = await ordinizer.getEntities();
      
      // Check each entity for this domain and question
      for (const entity of entities) {
        try {
          const analysis = await ordinizer.getAnalysis(domainId, entity.id);
          if (analysis) {
            const question = analysis.questions?.find((q: any) => 
              String(q.id) === String(questionId) || String(q.questionId) === String(questionId)
            );
            if (question && question.answer && 
                !question.answer.toLowerCase().includes('not specified') &&
                !question.answer.toLowerCase().includes('no specific') &&
                !question.answer.toLowerCase().includes('does not specify')) {
              municipalitiesWithAnswer.push({
                id: entity.id,
                name: entity.displayName || entity.name,
                answer: question.answer
              });
            }
          }
        } catch (error) {
          // Skip entities with missing or invalid analysis files
          continue;
        }
      }
      
      res.json(municipalitiesWithAnswer);
    } catch (error) {
      console.error('Error finding municipalities with answers:', error);
      res.status(500).json({ error: 'Failed to find municipalities with answers' });
    }
  });

  // Get statute metadata including source URL
  app.get(`${apiPrefix}/statute-metadata/:domainId/:municipalityId`, async (req, res) => {
    try {
      const { domainId, municipalityId } = req.params;
      const { realm: realmId } = req.query;
      
      const targetRealmId = typeof realmId === 'string' ? realmId : 'westchester-municipal-environmental';
      const ordinizer = await getOrdinizer(targetRealmId);
      
      const metadata = await ordinizer.getFormattedMetadata(domainId, municipalityId);
      
      if (!metadata) {
        return res.status(404).json({ error: 'Statute metadata not found' });
      }
      
      res.json(metadata);
    } catch (error) {
      console.error('Error serving statute metadata:', error);
      res.status(500).json({ error: 'Failed to serve statute metadata' });
    }
  });

  // Get section-specific URL for a statute section
  app.get(`${apiPrefix}/section-url/:domainId/:municipalityId/:sectionNumber`, async (req, res) => {
    try {
      const { domainId, municipalityId, sectionNumber } = req.params;
      const { realm: realmId } = req.query;
      
      // Use storage's data directory for the global section index
      const baseDataDir = storage.getDataDir();
      const sectionIndexPath = path.join(baseDataDir, 'statuteSectionIndex.csv');
      
      if (!await fs.pathExists(sectionIndexPath)) {
        return res.status(404).json({ error: 'Section index not found' });
      }
      
      const csvContent = await fs.readFile(sectionIndexPath, 'utf-8');
      const lines = csvContent.split('\n');
      
      // Collect all matching sections
      const matches: any[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const [csvMunicipalityId, csvDomain, csvSourceUrl, csvSectionNumber, csvAnchorId, csvSectionUrl] = line.split(',');
        
        if (csvMunicipalityId === municipalityId && 
            csvDomain === domainId && 
            csvSectionNumber === sectionNumber) {
          matches.push({
            municipalityId: csvMunicipalityId,
            domain: csvDomain,
            sourceUrl: csvSourceUrl,
            sectionNumber: csvSectionNumber,
            anchorId: csvAnchorId,
            sectionUrl: csvSectionUrl
          });
        }
      }
      
      if (matches.length > 0) {
        // If multiple matches exist, prefer the second one (actual section text over ToC)
        const selectedMatch = matches.length > 1 ? matches[1] : matches[0];
        return res.json(selectedMatch);
      }
      
      // If not found in index, fall back to general statute URL using ordinizer
      const targetRealmId = typeof realmId === 'string' ? realmId : 'westchester-municipal-environmental';
      const ordinizer = await getOrdinizer(targetRealmId);
      const metadata = await ordinizer.getFormattedMetadata(domainId, municipalityId);
      
      if (metadata) {
        return res.json({
          municipalityId,
          domain: domainId,
          sourceUrl: metadata.sourceUrl || `/api/statute/${domainId}/${municipalityId}`,
          sectionNumber,
          anchorId: null,
          sectionUrl: metadata.sourceUrl || `/api/statute/${domainId}/${municipalityId}`
        });
      }
      
      res.status(404).json({ error: 'Section not found' });
    } catch (error) {
      console.error('Error finding section URL:', error);
      res.status(500).json({ error: 'Failed to find section URL' });
    }
  });

  // Get available analysis versions (backups) for a municipality and domain
  app.get(`${apiPrefix}/analyses/:realmId/:municipalityId/:domainId/versions`, async (req, res) => {
    try {
      const { realmId, municipalityId, domainId } = req.params;
      
      // Get realm-specific data path using storage
      const realm = await storage.getRealm(realmId);
      if (!realm) {
        return res.status(404).json({ error: 'Realm not found' });
      }
      const dataPath = getRealmDataPath(realm);
      
      const directoryPath = path.join(dataPath, domainId, municipalityId);
      
      if (!await fs.pathExists(directoryPath)) {
        return res.json({ versions: [] });
      }
      
      // Get all analysis files in the directory
      const files = await fs.readdir(directoryPath);
      const versions = [];
      
      // Add current analysis.json if it exists
      const currentAnalysisPath = path.join(directoryPath, 'analysis.json');
      // console.debug("looking at ", currentAnalysisPath);
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
      
      // Add backup files
      const backupFiles = files
        .filter(file => file.startsWith('analysis-backup-') && file.endsWith('.json'))
        .sort().reverse(); // Most recent first
        
      for (const backupFile of backupFiles) {
        // Extract timestamp from filename: analysis-backup-YYYY-MM-DDTHH-MM-SS.json
        const timestampMatch = backupFile.match(/analysis-backup-(.+)\.json$/);
        if (timestampMatch) {
          const timestampStr = timestampMatch[1];
          // Convert from YYYY-MM-DDTHH-MM-SS to ISO format YYYY-MM-DDTHH:MM:SS
          // Replace only the time portion hyphens (HH-MM-SS) with colons
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
      
      // Sort by timestamp, most recent first
      versions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      
      res.json({ versions });
    } catch (error) {
      console.error('Error listing analysis versions:', error);
      res.status(500).json({ error: 'Failed to list analysis versions' });
    }
  });

  // Get analyses for a municipality and domain
  app.get(`${apiPrefix}/analyses/:realmId/:municipalityId/:domainId`, async (req, res) => {
    try {
      const { realmId, municipalityId, domainId } = req.params;
      // Get municipality and domain info (realm-aware)
      const entities = await storage.getEntitiesByRealm(realmId);
      const municipality = entities.find(e => e.id === municipalityId);
      
      // Get realm-specific data path using storage
      const realm = await storage.getRealm(realmId);
      if (!realm) {
        return res.status(404).json({ error: 'Realm not found' });
      }
      const dataPath = getRealmDataPath(realm);
      
      // Get domain definitions (not just the domain IDs)
      const allDomains = await storage.getDomainsByRealm(realmId);
      const domain = allDomains.find(d => d.id === domainId);
      
      
      if (!municipality || !domain) {
        return res.status(404).json({ error: "Municipality or domain not found" });
      }

      // Get statute (realm-aware)
      const statute = await storage.getStatuteByMunicipalityAndDomain(municipalityId, domainId, realmId);
      
      //if (!statute) {
      //  return res.status(404).json({ error: "No statute found for this municipality and domain" });
      //}

      // Get questions and analyses - read directly from analysis file for titles
      // Support version parameter for backup files
      const version = req.query.version as string;
      let analysisFilename = 'analysis.json';
      
      if (version && version !== 'current') {
        // Convert version timestamp back to backup filename format
        const timestampForFile = version.replace(/:/g, '-').replace(/ /g, 'T');
        analysisFilename = `analysis-backup-${timestampForFile}.json`;
      }
      
      const analysisPath = path.join(dataPath, domainId, municipalityId, analysisFilename);
      console.debug("Looking for ", analysisPath);
      let questionsWithAnswers: any[] = [];
      let alignmentSuggestions: any = null;
      
      if (await fs.pathExists(analysisPath)) {
        let analysisData = {};
        let dataArray = [];
        
        try {
          analysisData = await fs.readJson(analysisPath);
          // Handle both old format (answers) and new format (questions)
          dataArray = analysisData.answers || analysisData.questions || [];
        } catch (error) {
          console.error(`❌ Error reading analysis file: ${error}`);
        }
        
        // Pre-resolve section URLs to reduce client HTTP calls
        const resolveSectionUrls = async (sections: string[]) => {
          const baseDataDir = storage.getDataDir();
          const sectionIndexPath = path.join(baseDataDir, 'statuteSectionIndex.csv');
          const resolvedSections = [];
          
          if (await fs.pathExists(sectionIndexPath)) {
            const csvContent = await fs.readFile(sectionIndexPath, 'utf-8');
            const lines = csvContent.split('\n');
            
            for (const sectionNumber of sections) {
              const matches: any[] = [];
              for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                const [csvMunicipalityId, csvDomain, csvSourceUrl, csvSectionNumber, csvAnchorId, csvSectionUrl] = line.split(',');
                
                if (csvMunicipalityId === municipalityId && 
                    csvDomain === domainId && 
                    csvSectionNumber === sectionNumber) {
                  matches.push({
                    sectionNumber: csvSectionNumber,
                    anchorId: csvAnchorId,
                    sectionUrl: csvSectionUrl
                  });
                }
              }
              
              if (matches.length > 0) {
                // If multiple matches exist, prefer the second one (actual section text over ToC)
                const selectedMatch = matches.length > 1 ? matches[1] : matches[0];
                resolvedSections.push(selectedMatch);
              } else {
                // Fall back to section number only if not found
                resolvedSections.push({ sectionNumber });
              }
            }
          }
          
          return resolvedSections;
        };
        
        questionsWithAnswers = await Promise.all(dataArray.map(async (item: any) => {
          const sections = item.relevantSections || item.sourceRefs || [];
          const resolvedSections = await resolveSectionUrls(sections);
          
          return {
            id: item.questionId || item.id,
            title: item.title || item.question || "Untitled",
            text: item.question || item.title || "No question text",
            order: item.questionId || item.id,
            answer: item.answer || "Analysis not available",
            score: item.score || 0,
            confidence: item.confidence || 0,
            sourceReference: sections.join(', ') || null,
            gap: item.gap || null,
            lastUpdated: item.lastUpdated ? new Date(item.lastUpdated) : null,
            relevantSections: sections,
            resolvedSectionUrls: resolvedSections // Pre-resolved URLs
          };
        })) || [];
        
        // Look for alignment suggestions in the analysis data
        alignmentSuggestions = analysisData.alignmentSuggestions || null;
      }

      res.json({
        municipality,
        domain,
        statute,
        questions: questionsWithAnswers,
        alignmentSuggestions
      });
    } catch (error) {
      console.error('Error fetching analysis:', error);
      res.status(500).json({ error: "Failed to fetch analysis" });
    }
  });

  // Vector database endpoints
  
  // Index a statute in the vector database
  app.post(`${apiPrefix}/vector/index/:municipalityId/:domainId`, async (req, res) => {
    try {
      const { municipalityId, domainId } = req.params;
      const { realm: realmId } = req.body;
      
      const targetRealmId = typeof realmId === 'string' ? realmId : 'westchester-municipal-environmental';
      const ordinizer = await getOrdinizer(targetRealmId);
      const adapter = ordinizer.getConfig().getAdapter();
      
      // Use adapter's safe path resolution for statute.txt
      const statutePath = adapter.safeResolve(`${domainId}/${adapter.normalizeEntityId(municipalityId)}/statute.txt`);
      
      if (!await fs.pathExists(statutePath)) {
        return res.status(404).json({ error: "Statute file not found" });
      }
      
      const statuteContent = await fs.readFile(statutePath, 'utf-8');
      
      // Index in vector database
      await vectorService.indexStatute(municipalityId, domainId, statuteContent);
      
      res.json({ 
        message: "Statute indexed successfully", 
        municipalityId, 
        domainId,
        contentLength: statuteContent.length
      });
    } catch (error) {
      console.error('Error indexing statute:', error);
      res.status(500).json({ error: "Failed to index statute" });
    }
  });

  // Search vector database for relevant sections
  app.post(`${apiPrefix}/vector/search/:municipalityId/:domainId`, async (req, res) => {
    try {
      const { municipalityId, domainId } = req.params;
      const { question, topK = 5 } = req.body;
      
      if (!question) {
        return res.status(400).json({ error: "Question is required" });
      }
      
      const results = await vectorService.searchRelevantSections(
        municipalityId, 
        domainId, 
        question, 
        Math.min(topK, 10) // Limit to max 10 results
      );
      
      res.json(results);
    } catch (error) {
      console.error('Error searching vector database:', error);
      res.status(500).json({ error: "Failed to search vector database" });
    }
  });

  // Get vector database statistics
  app.get(`${apiPrefix}/vector/stats`, async (req, res) => {
    try {
      const stats = await vectorService.getIndexStats();
      res.json(stats);
    } catch (error) {
      console.error('Error getting vector database stats:', error);
      res.status(500).json({ error: "Failed to get vector database stats" });
    }
  });

  // Get environmental protection scores for a municipality and domain
  app.get(`${apiPrefix}/scores/:realmId/:municipalityId/:domainId`, async (req, res) => {
    try {
      const { realmId, municipalityId, domainId } = req.params;
      
      const ordinizer = await getOrdinizer(realmId);
      const analysis = await ordinizer.getAnalysis(domainId, municipalityId);
      
      if (!analysis || !analysis.scores) {
        return res.status(404).json({ error: "Score not found or not calculated" });
      }
      
      // Extract pre-calculated scores from analysis.json
      const scoreBreakdown = analysis.scores.scoreBreakdown || {};
      const weightedScoreNormalized = scoreBreakdown.weightedScore ?? 0; // 0-1 scale
      const overallScore = analysis.overallScore ?? analysis.scores.overallScore ?? 0; // 0-10 scale
      const normalizedScore = analysis.normalizedScore ?? analysis.scores.normalizedScore ?? 0; // 0-10 scale
      
      res.json({
        entityId: municipalityId,
        domainId,
        questions: scoreBreakdown.questionsWithScores || [],
        totalWeightedScore: scoreBreakdown.totalWeightedScore || 0,
        totalPossibleWeight: scoreBreakdown.totalPossibleWeight || 0,
        overallScore: overallScore,
        normalizedScore: normalizedScore,
        scoreColor: ordinizer.getScoreColorHex(weightedScoreNormalized) // Use 0-1 scale for color
      });
    } catch (error) {
      console.error('Error getting municipality score:', error);
      res.status(500).json({ error: "Failed to get municipality score" });
    }
  });

  // Get all environmental protection scores for a domain (for map visualization)
  app.get(`${apiPrefix}/domain-scores/:realmId/:domainId`, async (req, res) => {
    try {
      const { realmId, domainId } = req.params;
      
      const ordinizer = await getOrdinizer(realmId);
      const scores = await ordinizer.getDomainScores(domainId);
      
      // Convert scores to include color information
      const scoresWithColors: { [municipalityId: string]: { score: number, color: string } } = {};
      
      for (const [municipalityId, score] of Object.entries(scores)) {
        if (typeof score === 'number') {
          scoresWithColors[municipalityId] = {
            score: score * 10, // Convert 0-1 to 0-10 for backward compatibility
            color: ordinizer.getScoreColorHex(score) // Use normalized score 0-1
          };
        }
      }
      
      res.json(scoresWithColors);
    } catch (error) {
      console.error('Error getting domain scores:', error);
      res.status(500).json({ error: "Failed to get domain scores" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
