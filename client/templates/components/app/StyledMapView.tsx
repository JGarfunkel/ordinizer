/**
 * Styled MapView Template
 * Example of using the core MapView with custom styling
 */
import { MapView } from 'ordinizer/client';
import { getDefaultEntityStyle } from '../../lib/mapUtils';
import type { FeatureCollection } from 'geojson';

interface StyledMapViewProps {
  boundaries?: FeatureCollection;
  entityScores?: Record<string, number>;
  onEntityClick?: (entityId: string, entityName: string) => void;
  className?: string;
}

export function StyledMapView({
  boundaries,
  entityScores = {},
  onEntityClick,
  className = 'h-[600px] w-full rounded-lg border',
}: StyledMapViewProps) {
  const getEntityStyle = (entityId: string, properties: any) => {
    const score = entityScores[entityId];
    return getDefaultEntityStyle(entityId, score);
  };

  const getEntityPopup = (entityId: string, properties: any) => {
    const score = entityScores[entityId];
    const displayName = properties.displayName || properties.NAME;
    
    return (
      <div className="p-2">
        <h3 className="font-semibold">{displayName}</h3>
        {score !== undefined && (
          <p className="text-sm text-gray-600">Score: {score.toFixed(1)}/10</p>
        )}
      </div>
    );
  };

  return (
    <MapView
      boundaries={boundaries}
      onEntityClick={onEntityClick}
      getEntityStyle={getEntityStyle}
      getEntityPopup={getEntityPopup}
      className={className}
    />
  );
}
