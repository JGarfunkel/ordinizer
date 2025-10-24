/**
 * MapView - Headless map component for visualizing entities on a Leaflet map
 * This component is dependency-light and can be styled/customized by the consumer
 */
import { MapContainer, TileLayer, GeoJSON, Popup } from 'react-leaflet';
import type { GeoJsonObject, FeatureCollection } from 'geojson';
import 'leaflet/dist/leaflet.css';

export interface MapViewProps {
  boundaries?: FeatureCollection;
  center?: [number, number];
  zoom?: number;
  onEntityClick?: (entityId: string, entityName: string) => void;
  getEntityStyle?: (entityId: string, properties: any) => {
    fillColor?: string;
    fillOpacity?: number;
    color?: string;
    weight?: number;
  };
  getEntityPopup?: (entityId: string, properties: any) => React.ReactNode;
  className?: string;
}

export function MapView({
  boundaries,
  center = [41.1, -73.8],
  zoom = 10,
  onEntityClick,
  getEntityStyle,
  getEntityPopup,
  className = 'h-[600px] w-full',
}: MapViewProps) {
  if (!boundaries) {
    return (
      <div className={className} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f0f0' }}>
        <p>Loading map...</p>
      </div>
    );
  }

  const onEachFeature = (feature: any, layer: any) => {
    const entityId = feature.properties?.id || feature.properties?.NAME;
    const entityName = feature.properties?.displayName || feature.properties?.NAME;

    // Apply styling if provided
    if (getEntityStyle && entityId) {
      const style = getEntityStyle(entityId, feature.properties);
      layer.setStyle(style);
    }

    // Add click handler
    if (onEntityClick && entityId) {
      layer.on('click', () => {
        onEntityClick(entityId, entityName);
      });
    }

    // Add popup if provided
    if (getEntityPopup && entityId) {
      const popupContent = getEntityPopup(entityId, feature.properties);
      if (popupContent) {
        layer.bindPopup(popupContent);
      }
    }
  };

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      className={className}
      style={{ height: '100%', width: '100%' }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <GeoJSON 
        data={boundaries as GeoJsonObject} 
        onEachFeature={onEachFeature}
      />
    </MapContainer>
  );
}
