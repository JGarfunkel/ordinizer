/**
 * Configuration management for the Ordinizer library
 */
export class OrdinizerConfig {
    realm;
    plugins;
    adapter;
    constructor(realm, adapter, plugins = {}) {
        this.realm = realm;
        this.adapter = adapter;
        this.plugins = plugins;
    }
    getRealm() {
        return this.realm;
    }
    getAdapter() {
        return this.adapter;
    }
    getPlugins() {
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
    getEntityType() {
        return this.realm.entityType;
    }
    getRealmType() {
        return this.realm.type;
    }
    getDataPath() {
        return this.realm.dataPath;
    }
}
