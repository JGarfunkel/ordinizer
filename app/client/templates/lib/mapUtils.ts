/**
 * Map Utilities Template
 * Helper functions for styling and interacting with the map
 */

// Get color for score value (0-10 scale)
export function getScoreColor(score: number, maxScore: number = 10): string {
  const colorScale = [
    'hsl(0, 70%, 50%)',    // Red (0-1)
    'hsl(30, 70%, 50%)',   // Orange (1-2)
    'hsl(45, 70%, 50%)',   // Yellow (2-3)
    'hsl(60, 70%, 50%)',   // Yellow-green (3-4)
    'hsl(90, 60%, 45%)',   // Light green (4-5)
    'hsl(120, 60%, 40%)',  // Dark green (5+)
  ];
  
  const normalized = Math.min(score / maxScore, 1);
  const index = Math.min(Math.floor(normalized * 5), 5);
  return colorScale[index];
}

// Default map styling for entities
export function getDefaultEntityStyle(entityId: string, score?: number) {
  const baseStyle = {
    fillOpacity: 0.6,
    color: '#666',
    weight: 1,
  };

  if (score !== undefined) {
    return {
      ...baseStyle,
      fillColor: getScoreColor(score),
    };
  }

  return {
    ...baseStyle,
    fillColor: '#ccc',
  };
}
