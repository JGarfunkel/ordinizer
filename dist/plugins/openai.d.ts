/**
 * OpenAI plugin for the Ordinizer library
 * Provides LLM and embeddings capabilities using OpenAI's API
 */
import { LLMProvider, EmbeddingsProvider } from '../types.js';
export interface OpenAIConfig {
    apiKey: string;
    model?: string;
    embeddingModel?: string;
    baseURL?: string;
}
export declare class OpenAILLMProvider implements LLMProvider {
    private config;
    constructor(config: OpenAIConfig);
    analyze(prompt: string, context?: any): Promise<any>;
}
export declare class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
    private config;
    constructor(config: OpenAIConfig);
    createEmbedding(text: string): Promise<number[]>;
    search(query: string, options?: any): Promise<any[]>;
}
/**
 * Factory function to create OpenAI providers
 */
export declare function createOpenAIProviders(config: OpenAIConfig): {
    llm: OpenAILLMProvider;
    embeddings: OpenAIEmbeddingsProvider;
};
