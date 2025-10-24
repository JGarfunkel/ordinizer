/**
 * File-based data adapter for the Ordinizer library
 * Provides safe file system access with path validation
 */
import * as fs from 'fs/promises';
import * as path from 'path';
export class FileDataAdapter {
    basePath;
    options;
    constructor(basePath, options = {}) {
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
    safeResolve(relativePath) {
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
    normalizeEntityId(id) {
        // Remove any potentially dangerous characters and normalize
        return id.replace(/[^a-zA-Z0-9-_]/g, '');
    }
    /**
     * Load and parse JSON file safely
     */
    async loadJsonFile(filePath) {
        try {
            const fullPath = this.safeResolve(filePath);
            const content = await fs.readFile(fullPath, 'utf-8');
            return JSON.parse(content);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return null; // File not found
            }
            throw error;
        }
    }
    /**
     * Check if a file exists
     */
    async fileExists(filePath) {
        try {
            const fullPath = this.safeResolve(filePath);
            await fs.access(fullPath);
            return true;
        }
        catch {
            return false;
        }
    }
    async getQuestions(domainId) {
        // Validate domain ID
        if (!/^[a-zA-Z0-9-_]+$/.test(domainId)) {
            throw new Error(`Invalid domain ID: ${domainId}`);
        }
        const questionsPath = this.options.questionsPattern.replace('{domainId}', domainId);
        const questionsData = await this.loadJsonFile(questionsPath);
        // Handle both direct array format and wrapped format
        if (Array.isArray(questionsData)) {
            return questionsData;
        }
        else if (questionsData?.questions) {
            return questionsData.questions;
        }
        return [];
    }
    async getAnalysis(domainId, entityId) {
        // Validate inputs
        if (!/^[a-zA-Z0-9-_]+$/.test(domainId)) {
            throw new Error(`Invalid domain ID: ${domainId}`);
        }
        const normalizedEntityId = this.normalizeEntityId(entityId);
        console.debug("Looking for " + domainId, "/", normalizedEntityId);
        const analysisPath = this.options.analysisPattern
            .replace('{domainId}', domainId)
            .replace('{entityId}', normalizedEntityId);
        console.debug("Looking up analysis file at:", analysisPath);
        return await this.loadJsonFile(analysisPath);
    }
    async listEntities() {
        const entitiesData = await this.loadJsonFile(this.options.entitiesFile);
        // Handle both direct array format and wrapped format
        if (Array.isArray(entitiesData)) {
            return entitiesData;
        }
        else if (entitiesData?.municipalities) {
            return entitiesData.municipalities;
        }
        else if (entitiesData?.['school-districts']) {
            return entitiesData['school-districts'];
        }
        return [];
    }
    async loadMetadata(domainId, entityId) {
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
    async getDomains() {
        const domains = await this.loadJsonFile(this.options.domainsFile);
        return domains || [];
    }
}
