/**
 * Configuration management for the Ordinizer library
 */

import type { Realm } from '@ordinizer/core';

export class OrdinizerConfig {
  private realm: Realm;

  constructor(realm: Realm) {
    this.realm = realm;
  }

  getRealm(): Realm {
    return this.realm;
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
    return this.realm.ruleType;
  }

  getDataPath(): string {
    return this.realm.dataPath;
  }
}