/**
 * Ordinizer Client Library
 * Dual-delivery pattern: Import as library or copy with CLI
 */

// Core Components (headless, minimal dependencies)
export { MapView } from './components/MapView';
export { ScoreVisualization } from './components/ScoreVisualization';

// Hooks (data fetching and state management)
export { useEntities } from './hooks/useEntities';
export { useRealms } from './hooks/useRealms';

// Providers (configuration and context)
export { OrdinizerProvider, useOrdinizer } from './providers/OrdinizerProvider';

// Main App component
export { OrdinizerApp } from './App';
export { Toaster, TooltipProvider } from './ui';

// Types
export type { OrdinizerConfig, DataFetcher } from './providers/OrdinizerProvider';
export type { 
  Entity, 
  Domain, 
  Analysis, 
  Question,
  Realm 
} from '@civillyengaged/ordinizer-core';
