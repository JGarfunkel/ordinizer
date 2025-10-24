/**
 * Centralized score-to-color mapping utilities
 * Single source of truth for all score-based color calculations
 */

// Environmental Protection Score Colors (0-10 scale display, 0.0-1.0 internal)
export const ENVIRONMENTAL_SCORE_COLORS = {
  STRONG: '#22c55e',     // Strong green (8.0-10.0)
  MODERATE: '#65d47f',   // Moderate green (5.0-7.9)  
  WEAK: '#a7e6b7',       // Weak green (2.0-4.9)
  VERY_WEAK: '#bbf7d0',  // Very weak green (0.0-1.9)
} as const;

// Grade-based colors for letter grades
export const GRADE_COLORS = {
  A: 'bg-green-500 text-white hover:bg-green-600',
  B: 'bg-blue-500 text-white hover:bg-blue-600', 
  C: 'bg-yellow-500 text-white hover:bg-yellow-600',
  D: 'bg-orange-500 text-white hover:bg-orange-600',
  F: 'bg-red-500 text-white hover:bg-red-600',
  DEFAULT: 'bg-civic-blue text-white hover:bg-civic-blue-dark',
  UNAVAILABLE: 'bg-gray-200 text-gray-500 cursor-not-allowed',
} as const;

// Matrix cell colors (Tailwind classes for score ranges)
export const MATRIX_SCORE_COLORS = {
  EXCELLENT: 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 border-green-300', // >= 0.8
  GOOD: 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 border-yellow-300',     // >= 0.6
  FAIR: 'bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 border-orange-300',     // >= 0.4
  POOR: 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 border-red-300',                   // > 0
  NO_DATA: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-300',           // = 0
} as const;

// Map state colors
export const MAP_STATE_COLORS = {
  STATE_CODE: '#3b82f6',    // Blue for state code applies
  AVAILABLE: '#8b5cf6',     // Purple for available data  
  UNMATCHED: '#94a3b8',     // Gray for unmatched/default
  LIGHT_GRAY: '#e2e8f0',    // Light gray fallback
} as const;

/**
 * Get environmental protection score color based on normalized score (0-10 scale)
 * @param score - Score from 0.0 to 1.0 (internal) or 0-10 (display)
 * @param isDisplayScale - Whether score is already on 0-10 scale
 * @returns Hex color string
 */
export function getEnvironmentalScoreColor(score: number, isDisplayScale = false): string {
  const normalizedScore = isDisplayScale ? score : score * 10;
  
  if (normalizedScore >= 8.0) return ENVIRONMENTAL_SCORE_COLORS.STRONG;
  if (normalizedScore >= 5.0) return ENVIRONMENTAL_SCORE_COLORS.MODERATE;
  if (normalizedScore >= 2.0) return ENVIRONMENTAL_SCORE_COLORS.WEAK;
  return ENVIRONMENTAL_SCORE_COLORS.VERY_WEAK;
}

/**
 * Get dynamic environmental score color with gradient calculation
 * @param score - Score from 0.0 to 1.0
 * @returns Object with backgroundColor and textColor
 */
export function getEnvironmentalScoreGradient(score: number): { backgroundColor: string, textColor: string } {
  const intensity = Math.max(0, Math.min(1, score));
  
  // Convert hex colors to RGB for interpolation
  const darkGreen = { r: 34, g: 197, b: 94 };   // #22c55e
  const lightGreen = { r: 187, g: 247, b: 208 }; // #bbf7d0
  
  const r = Math.round(lightGreen.r + (darkGreen.r - lightGreen.r) * intensity);
  const g = Math.round(lightGreen.g + (darkGreen.g - lightGreen.g) * intensity);
  const b = Math.round(lightGreen.b + (darkGreen.b - lightGreen.b) * intensity);
  
  const backgroundColor = `rgb(${r}, ${g}, ${b})`;
  const textColor = intensity > 0.5 ? 'text-white' : 'text-green-900';
  
  return { backgroundColor, textColor };
}

/**
 * Get matrix cell color classes based on score
 * @param score - Score from 0.0 to 1.0
 * @returns Tailwind CSS classes for styling
 */
export function getMatrixScoreColor(score: number): string {
  if (score >= 0.8) return MATRIX_SCORE_COLORS.EXCELLENT;
  if (score >= 0.6) return MATRIX_SCORE_COLORS.GOOD;
  if (score >= 0.4) return MATRIX_SCORE_COLORS.FAIR;
  if (score > 0) return MATRIX_SCORE_COLORS.POOR;
  return MATRIX_SCORE_COLORS.NO_DATA;
}

/**
 * Get grade-based color classes
 * @param grade - Letter grade (A-F) or null/undefined
 * @param available - Whether the grade is available/clickable
 * @returns Tailwind CSS classes for styling
 */
export function getGradeColor(grade: string | null | undefined, available: boolean): string {
  if (!available) return GRADE_COLORS.UNAVAILABLE;
  
  const upperGrade = grade?.toUpperCase() as keyof typeof GRADE_COLORS;
  return GRADE_COLORS[upperGrade] || GRADE_COLORS.DEFAULT;
}

/**
 * Get legend items for environmental protection scores
 * @returns Array of legend items with color and label
 */
export function getEnvironmentalScoreLegend() {
  return [
    { color: ENVIRONMENTAL_SCORE_COLORS.STRONG, label: 'Strong (8.0-10.0)' },
    { color: ENVIRONMENTAL_SCORE_COLORS.MODERATE, label: 'Moderate (5.0-7.9)' },
    { color: ENVIRONMENTAL_SCORE_COLORS.WEAK, label: 'Weak (2.0-4.9)' },
    { color: ENVIRONMENTAL_SCORE_COLORS.VERY_WEAK, label: 'Very Weak (0.0-1.9)' },
  ];
}