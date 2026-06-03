import type { DataDomainScoring } from "@civillyengaged/ordinizer-core";

/** Named CSS colors → nicer hex equivalents for map rendering */
const COLOR_MAP: Record<string, string> = {
  green:  "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  red:    "#d21404",
  blue:   "#3b82f6",
  purple: "#8b5cf6",
  gray:   "#94a3b8",
};

/**
 * Parse a range-token string to a number.
 * Leading-zero tokens encode decimal fractions: "01" → 0.1, "05" → 0.5
 */
function parseToken(token: string): number {
  if (/^0\d+$/.test(token)) {
    return parseFloat("0." + token.slice(1));
  }
  return parseFloat(token);
}

/** Resolve a color name or hex string to a CSS-safe hex string */
export function resolveColor(color: string): string {
  return COLOR_MAP[color.toLowerCase()] ?? color;
}

/**
 * Given a numeric value and a scoreMapping, return the resolved hex color
 * for the first matching range, or null if no range matches.
 */
export function getColorFromScoring(
  value: number | string | null | undefined,
  scoreMapping: Record<string, string>
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  if (isNaN(num)) return null;

  for (const [range, color] of Object.entries(scoreMapping)) {
    const trimmed = range.trim();
    if (trimmed.startsWith(">=")) {
      if (num >= parseToken(trimmed.slice(2))) return resolveColor(color);
    } else if (trimmed.startsWith(">")) {
      if (num > parseToken(trimmed.slice(1))) return resolveColor(color);
    } else if (trimmed.startsWith("<=")) {
      if (num <= parseToken(trimmed.slice(2))) return resolveColor(color);
    } else if (trimmed.startsWith("<")) {
      if (num < parseToken(trimmed.slice(1))) return resolveColor(color);
    } else if (trimmed.includes("-")) {
      const dashIdx = trimmed.indexOf("-");
      const lo = parseToken(trimmed.slice(0, dashIdx));
      const hi = parseToken(trimmed.slice(dashIdx + 1));
      if (num >= lo && num <= hi) return resolveColor(color);
    }
  }
  return null;
}

/** Format a raw data value for display, respecting column type */
export function formatColumnValue(value: any, type: string | undefined): string {
  if (value == null) return "—";
  if (type === "percentage") return `${value}%`;
  return String(value);
}

/** Build a human-readable legend from a scoreMapping */
export function buildScoringLegend(
  scoreMapping: Record<string, string>,
  format?: 'percentage' | 'number' | 'string'
): Array<{ label: string; color: string }> {
  return Object.entries(scoreMapping).map(([range, color]) => ({
    label: formatRangeLabel(range, format),
    color: resolveColor(color),
  }));
}

function formatRangeLabel(range: string, format?: 'percentage' | 'number' | 'string'): string {
  const suffix = format === 'percentage' ? '%' : '';
  const trimmed = range.trim();
  if (trimmed.startsWith(">=")) return `≥ ${trimmed.slice(2)}${suffix}`;
  if (trimmed.startsWith(">"))  return `> ${trimmed.slice(1)}${suffix}`;
  if (trimmed.startsWith("<=")) return `≤ ${trimmed.slice(2)}${suffix}`;
  if (trimmed.startsWith("<"))  return `< ${trimmed.slice(1)}${suffix}`;
  if (trimmed.includes("-")) {
    const dashIdx = trimmed.indexOf("-");
    const lo = parseToken(trimmed.slice(0, dashIdx));
    const hi = parseToken(trimmed.slice(dashIdx + 1));
    return `${lo}${suffix} – ${hi}${suffix}`;
  }
  return `${trimmed}${suffix}`;
}

/** Return the resolved color for an entity given its data row and a scoring rule */
export function getEntityScoreColor(
  row: Record<string, any> | undefined,
  scoring: DataDomainScoring
): string | null {
  if (!row) return null;
  return getColorFromScoring(row[scoring.scoreColumn], scoring.scoreMapping);
}
