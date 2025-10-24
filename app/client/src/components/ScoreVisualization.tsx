import React from 'react';

interface ScoreVisualizationProps {
  score: number; // Score value (0-1 scale or 0-10 scale, will be normalized)
  weight?: number; // Weight multiplier (e.g., 2 for 2x weight)
  showWeight?: boolean; // Whether to show weight indicator
  maxScore?: number; // Maximum score value (1 for 0-1 scale, 10 for 0-10 scale)
  className?: string;
}

export default function ScoreVisualization({ 
  score, 
  weight, 
  showWeight = false, 
  maxScore = 1, 
  className = "" 
}: ScoreVisualizationProps) {
  // Normalize score to 0-1 range
  const normalizedScore = Math.max(0, Math.min(1, score / maxScore));
  
  // Calculate how many full squares to fill (out of 5)
  const filledSquares = normalizedScore * 5;
  
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* Weight indicator */}
      {showWeight && weight && weight !== 1 && (
        <span className="text-xs text-gray-500 font-medium">
          x{weight}
        </span>
      )}
      
      {/* Score squares */}
      <div className="flex items-center gap-px">
        {Array.from({ length: 5 }, (_, index) => {
          const squareValue = index + 1;
          let fillLevel = 0;
          
          if (filledSquares >= squareValue) {
            // Fully filled
            fillLevel = 1;
          } else if (filledSquares > index) {
            // Partially filled
            fillLevel = filledSquares - index;
          }
          
          return (
            <div
              key={index}
              className="w-[10px] h-[10px] border border-gray-300 relative bg-gray-100"
              style={{
                background: fillLevel > 0 
                  ? `linear-gradient(to right, darkgreen ${fillLevel * 100}%, #f3f4f6 ${fillLevel * 100}%)`
                  : '#f3f4f6'
              }}
            />
          );
        })}
      </div>
    </div>
  );
}