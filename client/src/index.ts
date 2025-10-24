/**
 * Ordinizer Client Library
 * Dual-delivery pattern: Import as library or copy with CLI
 */

// Core Components (headless, minimal dependencies)
export { MapView } from './components/core/MapView';
export { ScoreVisualization } from './components/core/ScoreVisualization';

// Hooks (data fetching and state management)
export { useEntities } from './hooks/useEntities';
export { useAnalysis } from './hooks/useAnalysis';
export { useDomainSummary } from './hooks/useDomainSummary';
export { useRealms } from './hooks/useRealms';

// Providers (configuration and context)
export { OrdinizerProvider, useOrdinizer } from './providers/OrdinizerProvider';

// Types
export type { OrdinizerConfig, DataFetcher } from './providers/OrdinizerProvider';
export type { 
  Entity, 
  Domain, 
  Analysis, 
  Question,
  RealmConfig 
} from 'ordinizer';
