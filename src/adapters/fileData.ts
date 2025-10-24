/**
 * File-based data adapter for the Ordinizer library
 * Provides safe file system access with path validation
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { DataAdapter, Entity, Question, Analysis, Domain } from '../types.js';

export interface FileDataAdapterOptions {
  entitiesFile?: string;
  domainsFile?: string;
  questionsPattern?: string;
  analysisPattern?: string;
  metadataPattern?: string;
}

export class FileDataAdapter implements DataAdapter {
  private basePath: string;
  private options: Required<FileDataAdapterOptions>;

  constructor(basePath: string, options: FileDataAdapterOptions = {}) {
    this.basePath = path.resolve(basePath);
    this.options = {
      entitiesFile: options.entitiesFile ?? 'entities.json',
      domainsFile: options.domainsFile ?? 'domains.json',
      questionsPattern: options.questionsPattern ?? 'questions/{domainId}.json',
      analysisPattern: options.analysisPattern ?? '{domainId}/{entityId}/analysis.json',
      metadataPattern: options.metadataPattern ?? '{domainId}/{entityId}/metadata.json'
    };
  }

  /**
   * Safely resolve a path within the base data directory
   */
  safeResolve(relativePath: string): string {
    const resolved = path.resolve(this.basePath, relativePath);
    const relative = path.relative(this.basePath, resolved);
    
    // Ensure the resolved path is within the base path (no traversal)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    
    return resolved;
  }

  /**
   * Normalize entity ID for consistent lookups
   */
  normalizeEntityId(id: string): string {
    // Remove any potentially dangerous characters and normalize
    return id.replace(/[^a-zA-Z0-9-_]/g, '');
  }

  /**
   * Load and parse JSON file safely
   */
  private async loadJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      const fullPath = this.safeResolve(filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return null; // File not found
      }
      throw error;
    }
  }

  /**
   * Check if a file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const fullPath = this.safeResolve(filePath);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async getQuestions(domainId: string): Promise<Question[]> {
    // Validate domain ID
    if (!/^[a-zA-Z0-9-_]+$/.test(domainId)) {
      throw new Error(`Invalid domain ID: ${domainId}`);
    }

    const questionsPath = this.options.questionsPattern.replace('{domainId}', domainId);
    const questionsData = await this.loadJsonFile<any>(questionsPath);
    
    // Handle both direct array format and wrapped format
    if (Array.isArray(questionsData)) {
      return questionsData;
    } else if (questionsData?.questions) {
      return questionsData.questions;
    }
    
    return [];
  }

  async getAnalysis(domainId: string, entityId: string): Promise<Analysis | null> {
    // Validate inputs
    if (!/^[a-zA-Z0-9-_]+$/.test(domainId)) {
      throw new Error(`Invalid domain ID: ${domainId}`);
    }
    
    const normalizedEntityId = this.normalizeEntityId(entityId);
    // console.debug("Looking for " + domainId, "/", normalizedEntityId);
    const analysisPath = this.options.analysisPattern
      .replace('{domainId}', domainId)
      .replace('{entityId}', normalizedEntityId);

    //console.debug("Looking up analysis file at:", analysisPath);
    return await this.loadJsonFile<Analysis>(analysisPath);
  }

  async listEntities(): Promise<Entity[]> {
    const entitiesData = await this.loadJsonFile<any>(this.options.entitiesFile);
    
    // Handle both direct array format and wrapped format
    if (Array.isArray(entitiesData)) {
      return entitiesData;
    } else if (entitiesData?.municipalities) {
      return entitiesData.municipalities;
    } else if (entitiesData?.['school-districts']) {
      return entitiesData['school-districts'];
    }
    
    return [];
  }

  async loadMetadata(domainId: string, entityId: string): Promise<any> {
    // Validate inputs
    if (!/^[a-zA-Z0-9-_]+$/.test(domainId)) {
      throw new Error(`Invalid domain ID: ${domainId}`);
    }
    
    const normalizedEntityId = this.normalizeEntityId(entityId);
    const metadataPath = this.options.metadataPattern
      .replace('{domainId}', domainId)
      .replace('{entityId}', normalizedEntityId);
    
    return await this.loadJsonFile(metadataPath);
  }

  async getDomains(): Promise<Domain[]> {
    const domains = await this.loadJsonFile<Domain[]>(this.options.domainsFile);
    return domains || [];
  }
}