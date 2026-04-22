/**
 * ScoreVisualization - Headless score display component
 * Renders score with customizable styling and grade display
 */

export interface ScoreVisualizationProps {
  score?: number;
  maxScore?: number;
  grade?: string | number;
  label?: string;
  showGrade?: boolean;
  className?: string;
  getScoreColor?: (score: number, maxScore: number) => string;
}

export function ScoreVisualization({
  score,
  maxScore = 10,
  grade,
  label,
  showGrade = true,
  className = '',
  getScoreColor,
}: ScoreVisualizationProps) {
  if (score === undefined && !grade) {
    return null;
  }

  const displayScore = score !== undefined ? score.toFixed(1) : null;
  const scoreColor = score !== undefined && getScoreColor 
    ? getScoreColor(score, maxScore)
    : 'currentColor';

  return (
    <div className={className}>
      {label && <div className="score-label">{label}</div>}
      <div className="score-display" style={{ color: scoreColor }}>
        {displayScore !== null && (
          <span className="score-value">
            {displayScore}
            {maxScore && <span className="score-max">/{maxScore}</span>}
          </span>
        )}
        {showGrade && grade && (
          <span className="score-grade"> ({grade})</span>
        )}
      </div>
    </div>
  );
}
