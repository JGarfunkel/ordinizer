/**
 * Configuration management for the Ordinizer library
 */

import { RealmConfig, PluginConfig, DataAdapter } from './types.js';

export class OrdinizerConfig {
  private realm: RealmConfig;
  private plugins: PluginConfig;
  private adapter: DataAdapter;

  constructor(realm: RealmConfig, adapter: DataAdapter, plugins: PluginConfig = {}) {
    this.realm = realm;
    this.adapter = adapter;
    this.plugins = plugins;
  }

  getRealm(): RealmConfig {
    return this.realm;
  }

  getAdapter(): DataAdapter {
    return this.adapter;
  }

  getPlugins(): PluginConfig {
    return this.plugins;
  }

  getTerminology() {
    return {
      documentSingular: this.realm.terminology?.documentSingular || 'statute',
      documentPlural: this.realm.terminology?.documentPlural || 'statutes',
      entitySingular: this.realm.terminology?.entitySingular || 'municipality',
      entityPlural: this.realm.terminology?.entityPlural || 'municipalities'
    };
  }

  getEntityType(): 'municipalities' | 'school-districts' {
    return this.realm.entityType;
  }

  getRealmType(): 'statute' | 'policy' {
    return this.realm.type;
  }

  getDataPath(): string {
    return this.realm.dataPath;
  }
}