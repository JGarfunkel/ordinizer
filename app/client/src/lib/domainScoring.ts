import type { DataDomainScoring } from "@civillyengaged/ordinizer-core";
import {
  resolveColor,
  getColorFromScoring,
  formatColumnValue,
  buildScoringLegend,
} from "@civillyengaged/ordinizer-core";

// Re-exported for existing consumers of this module
export { resolveColor, getColorFromScoring, formatColumnValue, buildScoringLegend };

/** Return the resolved color for an entity given its data row and a scoring rule */
export function getEntityScoreColor(
  row: Record<string, any> | undefined,
  scoring: DataDomainScoring
): string | null {
  if (!row) return null;
  return getColorFromScoring(row[scoring.scoreColumn], scoring.scoreMapping);
}
