/**
 * storage.ts — Server-side storage shim.
 *
 * JsonFileStorage now lives in @ordinizer/servercore so it can be shared with
 * the analyzer CLI. This file re-exports everything callers need.
 *
 * Routes should migrate to getDefaultStorage(realmId) for realm-aware access.
 * The `storage` singleton below is a legacy bridge for routes not yet migrated.
 */
export {
  JsonFileStorage,
  getDefaultStorage,
  getReadOnlyStorage,
  getRealmsFromStorage,
  type IStorage,
  type IStorageReadOnly,
} from "@ordinizer/servercore";

