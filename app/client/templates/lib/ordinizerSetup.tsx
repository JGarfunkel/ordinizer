/**
 * Ordinizer Setup Template
 * This file shows how to configure and use the OrdinizerProvider
 */
import { OrdinizerProvider, type OrdinizerConfig } from 'ordinizer/client';
import { queryClient } from './queryClient';

// Default fetcher for API requests
const defaultFetcher = async (url: string, options?: RequestInit) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
};

// Configure your ordinizer instance
export const ordinizerConfig: OrdinizerConfig = {
  baseUrl: '', // Leave empty to use same origin, or set to API URL
  fetcher: defaultFetcher,
  queryClient,
  theme: {
    colorScale: [
      'hsl(0, 70%, 50%)',    // Red (score 0-1)
      'hsl(30, 70%, 50%)',   // Orange
      'hsl(45, 70%, 50%)',   // Yellow
      'hsl(60, 70%, 50%)',   // Yellow-green
      'hsl(90, 60%, 45%)',   // Light green
      'hsl(120, 60%, 40%)',  // Dark green (score 5)
    ],
  },
};

// Wrapper component for your app
export function OrdinizerAppWrapper({ children }: { children: React.ReactNode }) {
  return (
    <OrdinizerProvider {...ordinizerConfig}>
      {children}
    </OrdinizerProvider>
  );
}
