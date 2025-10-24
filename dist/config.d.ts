/**
 * Configuration management for the Ordinizer library
 */
import { RealmConfig, PluginConfig, DataAdapter } from './types.js';
export declare class OrdinizerConfig {
    private realm;
    private plugins;
    private adapter;
    constructor(realm: RealmConfig, adapter: DataAdapter, plugins?: PluginConfig);
    getRealm(): RealmConfig;
    getAdapter(): DataAdapter;
    getPlugins(): PluginConfig;
    getTerminology(): {
        documentSingular: string;
        documentPlural: string;
        entitySingular: string;
        entityPlural: string;
    };
    getEntityType(): 'municipalities' | 'school-districts';
    getRealmType(): 'statute' | 'policy';
    getDataPath(): string;
}
