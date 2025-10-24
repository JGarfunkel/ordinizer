import { useState, useRef, useEffect } from "react";
import { MapContainer, TileLayer, GeoJSON, Popup } from "react-leaflet";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ChevronUp, ChevronDown, X, Map, MapPin } from "lucide-react";
import type { Municipality, MunicipalityDomain } from "@ordinizer/core";
import { getEnvironmentalScoreLegend } from '../lib/scoreColors';
import { apiPath } from '../lib/apiConfig';

interface MunicipalityMapProps {
  selectedDomain?: string;
  onMunicipalityClick?: (municipalityId: string) => void;
  className?: string;
  allowCollapse?: boolean;
  selectedMunicipalityId?: string; // Pass the exact selected municipality ID from dropdown
  realmId?: string; // Realm ID for determining which boundary data to fetch
  entities?: Municipality[]; // Pass entities data from parent to avoid duplicate fetches
}

interface WestchesterGeoFeature {
  type: "Feature";
  properties: {
    NAME: string;
    MUNICIPAL?: string;
    TYPE?: string;
    MUNICIPALITY_ID?: string;
    [key: string]: any;
  };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

interface WestchesterGeoJSON {
  type: "FeatureCollection";
  features: WestchesterGeoFeature[];
}

type MapStyle = "roads" | "outline";

export default function MunicipalityMap({ 
  selectedDomain, 
  onMunicipalityClick,
  className = "",
  allowCollapse = false,
  selectedMunicipalityId,
  realmId = "westchester-environmental",
  entities
}: MunicipalityMapProps) {
  const [selectedFeature, setSelectedFeature] = useState<WestchesterGeoFeature | null>(null);
  const [mapStyle, setMapStyle] = useState<MapStyle>("roads");
  const [isMapCollapsed, setIsMapCollapsed] = useState(false);
  const [showMobilePopup, setShowMobilePopup] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    jurisdictionName: string;
    score?: number;
  }>({ visible: false, x: 0, y: 0, jurisdictionName: '' });
  const geoJsonRef = useRef<any>();

  // Client-side cache for jurisdiction data (realm -> jurisdiction ID -> {name, score})
  const jurisdictionCacheRef = useRef<{
    [realmId: string]: {
      [jurisdictionId: string]: { name: string; score?: number }
    }
  }>({});

  // Fetch boundary data for the current realm
  const { data: rawGeoData, isLoading: geoLoading } = useQuery<WestchesterGeoJSON>({
    queryKey: [apiPath(`map-boundaries?realm=${realmId}`)],
    enabled: !!realmId, // Only fetch when realm is available
    staleTime: 1000 * 60 * 60 * 24, // Cache for 24 hours
  });

  // Sort GeoJSON features to render villages last (on top of towns)
  const geoData = rawGeoData ? {
    ...rawGeoData,
    features: [...rawGeoData.features].sort((a, b) => {
      const typeA = a.properties.TYPE || '';
      const typeB = b.properties.TYPE || '';
      
      // Villages should come last (higher sort order) to render on top
      if (typeA.includes('Village') && !typeB.includes('Village')) return 1;
      if (!typeA.includes('Village') && typeB.includes('Village')) return -1;
      
      // Cities come second
      if (typeA.includes('City') && typeB.includes('Town')) return 1;
      if (typeA.includes('Town') && typeB.includes('City')) return -1;
      
      return 0; // Keep original order for same types
    })
  } : null;

  // Use entities passed from parent, or fetch municipalities as fallback for backward compatibility
  // When realmId is provided, we should ONLY use realm-specific entities (no fallback to all municipalities)
  const { data: fetchedMunicipalities, isLoading: municipalitiesLoading } = useQuery<Municipality[]>({
    queryKey: [apiPath('municipalities')],
    staleTime: 1000 * 60 * 60, // Cache for 1 hour
    enabled: !entities && realmId === "westchester-environmental" // Only fetch fallback for legacy usage without realm
  });

  const municipalities = entities || fetchedMunicipalities;
  
  // Debug logging to help troubleshoot
  if (!municipalities) {
    console.log('🗺️ Map Debug - No municipalities data available. entities:', !!entities, 'fetchedMunicipalities:', !!fetchedMunicipalities, 'realmId:', realmId);
  }



  // Get consolidated domain data (summary + scores) - different endpoints for different realms
  const { data: domainSummary } = useQuery<Array<{municipalityId?: string, entityId?: string, entityName?: string, grade?: string | null, gradeColor?: string | null, available: boolean, stateCodeApplies?: boolean, hasData?: boolean, color?: string, score?: number, scoreColor?: string}>>({
    queryKey: [apiPath('domains'), realmId, selectedDomain, 'summary'],
    queryFn: async () => {
      if (!selectedDomain || !realmId) return [];
      
      // Use different endpoints based on realm
      let endpoint = apiPath(`domains/${realmId}/${selectedDomain}/summary`);
      
      const response = await fetch(endpoint);
      if (response.ok) {
        return await response.json();
      }
      return [];
    },
    enabled: !!selectedDomain && !!realmId,
    staleTime: 1000 * 60 * 10, // Cache for 10 minutes
  });

  // Environmental scores are now included in domainSummary (consolidated API)

  // Build jurisdiction cache when data changes
  useEffect(() => {
    if (municipalities && realmId) {
      if (!jurisdictionCacheRef.current[realmId]) {
        jurisdictionCacheRef.current[realmId] = {};
      }

      // Always cache jurisdiction names (even when no domain selected)
      municipalities.forEach(municipality => {
        if (!jurisdictionCacheRef.current[realmId][municipality.id]) {
          jurisdictionCacheRef.current[realmId][municipality.id] = {
            name: municipality.displayName || municipality.name
          };
        }
      });

      // Cache scores and availability when a domain is selected (now consolidated in domainSummary)
      if (selectedDomain) {
        domainSummary?.forEach(summary => {
          const jurisdictionId = summary.municipalityId || summary.entityId;
          if (jurisdictionId && jurisdictionCacheRef.current[realmId][jurisdictionId]) {
            // Cache the score from consolidated data
            if (summary.score !== undefined) {
              jurisdictionCacheRef.current[realmId][jurisdictionId].score = summary.score;
            } else if (summary.available) {
              jurisdictionCacheRef.current[realmId][jurisdictionId].score = 0; // Data exists but no score
            }
          }
        });
      }
    }
  }, [municipalities, domainSummary, realmId, selectedDomain]);

  // Helper function to find municipality by geo feature using municipality ID
  const findMunicipalityByGeoFeature = (feature: WestchesterGeoFeature): Municipality | undefined => {
    const suppressLogging = feature.properties._suppressLogging === true;
    
    if (!municipalities) {
      if (!suppressLogging) console.log('No municipalities data available');
      return undefined;
    }
    
    if (municipalities.length === 0) {
      if (!suppressLogging) console.log('Municipalities data is empty array');
      return undefined;
    }
    
    // Use the municipality ID from GeoJSON if available (for municipal boundaries)
    const municipalityId = feature.properties.MUNICIPALITY_ID;
    if (!suppressLogging) console.log('Looking for municipality ID:', municipalityId);
    if (municipalityId) {
      const municipality = municipalities.find(m => m.id === municipalityId);
      if (municipality) {
        if (!suppressLogging) console.log('Found municipality by ID:', municipality.id);
        return municipality;
      } else {
        if (!suppressLogging) console.log('Municipality ID not found in database:', municipalityId);
      }
    }
    
    // Check for school district ID properties (common in school district GeoJSON)
    const districtId = feature.properties.DISTRICT_ID || feature.properties.ID || feature.properties.DistrictID;
    if (districtId && !suppressLogging) console.log('Looking for district ID:', districtId);
    if (districtId) {
      // Use EXACT ID matching only - no fuzzy matching to avoid wrong matches
      const municipality = municipalities.find(m => m.id === districtId);
      if (municipality) {
        if (!suppressLogging) console.log('Found school district by ID:', municipality.id);
        return municipality;
      } else {
        if (!suppressLogging) console.log('District ID not found in database:', districtId);
      }
    }
    
    // For school districts, try matching by DISTRICT_NAME or DISTNAME
    const districtName = feature.properties.DISTRICT_NAME || feature.properties.DISTNAME;
    if (districtName) {
      if (!suppressLogging) console.log('Looking for school district:', districtName);
      
      // Enhanced school district matching with more variations
      const normalizedDistrictName = districtName.toLowerCase().trim();
      const municipality = municipalities.find(m => {
        const normalizedEntityName = m.name.toLowerCase().trim();
        const displayName = (m.displayName || '').toLowerCase().trim();
        
        // Try exact matches first
        if (normalizedEntityName === normalizedDistrictName || displayName === normalizedDistrictName) {
          return true;
        }
        
        // Try common district name variations
        const districtVariations = [
          districtName,
          `${districtName} CSD`,
          `${districtName} UFSD`, 
          `${districtName} Central School District`,
          `${districtName} Union Free School District`,
          districtName.replace(/\s+/g, ''), // Remove spaces
          districtName.replace(/-/g, ' '), // Replace hyphens with spaces
          districtName.replace(/-/g, ''), // Remove hyphens
        ];
        
        // Check if any variation matches
        return districtVariations.some(variation => {
          const normalizedVariation = variation.toLowerCase().trim();
          return normalizedEntityName === normalizedVariation || 
                 displayName === normalizedVariation ||
                 normalizedEntityName.includes(normalizedVariation) ||
                 displayName.includes(normalizedVariation);
        });
      });
      
      if (municipality) {
        if (!suppressLogging) console.log('Found school district by name:', municipality.id);
        return municipality;
      } else {
        if (!suppressLogging) console.log('School district not found in database:', districtName, 'Available entities:', municipalities?.map(m => m.name).slice(0, 5));
      }
    }
    
    // Enhanced fallback to name matching for any features that weren't updated
    const nameProperty = feature.properties.NAME || feature.properties.DISTRICT_NAME || feature.properties.DISTNAME || feature.properties.DistrictName;
    if (!nameProperty) {
      if (!suppressLogging) console.log('No NAME, DISTRICT_NAME, DISTNAME, or DistrictName property found in feature. Available properties:', Object.keys(feature.properties));
      return undefined;
    }
    const geoName = nameProperty.toLowerCase().trim();
    if (!suppressLogging) console.log('Falling back to name matching for:', geoName);
    
    // Extract base name without type suffix (e.g., "mamaroneck village" -> "mamaroneck")
    const baseName = geoName
      .replace(/\s+(village|town|city)$/, '') // Remove type suffixes
      .trim();
    
    // Handle special cases with hyphen mismatches
    const nameVariations = [
      geoName, // Full name with type
      baseName, // Base name without type
      geoName.replace(/-/g, ''), // Remove hyphens (croton-on-hudson -> crotononhudson)
      baseName.replace(/-/g, ''), // Base name without hyphens
      geoName.replace(/\s/g, ''), // Remove spaces
      baseName.replace(/\s/g, ''), // Base name without spaces
      geoName.replace(/-/g, ' '), // Replace hyphens with spaces
      baseName.replace(/-/g, ' '), // Base name with hyphens as spaces
    ];
    
    if (!suppressLogging) console.log('Name variations for', geoName, '(base:', baseName, '):', nameVariations);
    
    const fallbackResult = municipalities.find(municipality => {
      const munName = municipality.name.toLowerCase().trim();
      const displayName = (municipality.displayName || '').toLowerCase().trim();
      const municipalityType = municipality.id.split('-')[2]?.toLowerCase() || ''; // Extract type from ID (Village, Town, City)
      
      // For school districts, try more aggressive matching
      if (municipality.type === 'School District' || municipality.id.includes('CSD') || municipality.id.includes('UFSD')) {
        // Try exact name matches and partial matches for school districts
        const districtBaseName = geoName.replace(/\s+(central\s+school\s+district|union\s+free\s+school\s+district|school\s+district|csd|ufsd)$/i, '').trim();
        const entityBaseName = munName.replace(/\s+(central\s+school\s+district|union\s+free\s+school\s+district|school\s+district|csd|ufsd)$/i, '').trim();
        
        if (munName === geoName || displayName === geoName || 
            entityBaseName === districtBaseName ||
            munName.includes(districtBaseName) || displayName.includes(districtBaseName) ||
            districtBaseName.includes(entityBaseName)) {
          if (!suppressLogging) console.log('School district name match:', municipality.id, 'matched with:', geoName);
          return true;
        }
      }
      
      // For problematic duplicates, match both name AND type to avoid conflicts
      const problematicNames = ['mamaroneck', 'pelham', 'ossining', 'rye'];
      const isProblematic = problematicNames.some(name => geoName.includes(name));
      
      if (isProblematic) {
        // For problematic names, require both name AND type to match
        const geoType = feature.properties.TYPE?.toLowerCase() || '';
        const typeMatches = (
          (geoType.includes('village') && municipalityType === 'village') ||
          (geoType.includes('town') && municipalityType === 'town') ||
          (geoType.includes('city') && municipalityType === 'city')
        );
        
        // Check name variations only if type matches
        if (typeMatches) {
          for (const variation of nameVariations) {
            if (munName === variation) {
              if (!suppressLogging) console.log('✓ Problematic name match (with type verification):', variation, '=', munName, 'Type:', municipalityType);
              return true;
            }
          }
        }
        return false;
      }
      
      // For non-problematic names, use standard matching
      // Direct comparison first
      if (munName === geoName) {
        if (!suppressLogging) console.log('✓ Direct match found:', geoName, '=', munName);
        return true;
      }
      
      // Check all variations
      for (const variation of nameVariations) {
        if (munName === variation) {
          if (!suppressLogging) console.log('✓ Variation match found:', variation, '=', munName);
          return true;
        }
      }
      
      return false;
    });
    
    if (!suppressLogging) console.log('Fallback result:', fallbackResult?.id);
    return fallbackResult;
  };

  // Get the selected municipality - prefer direct ID from props over geo feature matching
  const selectedMunicipality = selectedMunicipalityId 
    ? municipalities?.find(m => m.id === selectedMunicipalityId)
    : (selectedFeature ? findMunicipalityByGeoFeature(selectedFeature) : null);
    
  // Debug logging for municipality selection
  if (selectedMunicipalityId) {
    console.log('🗺️ Map component - Direct municipality ID:', selectedMunicipalityId);
    console.log('🗺️ Map component - Found municipality:', selectedMunicipality?.displayName);
  }
    
  const { data: analysisData, isLoading: analysisLoading } = useQuery({
    queryKey: [apiPath('analyses'), realmId, selectedMunicipality?.id, selectedDomain],
    queryFn: async () => {
      if (!selectedMunicipality || !selectedDomain || !realmId) return null;
      const response = await fetch(`/api/analyses/${realmId}/${selectedMunicipality.id}/${selectedDomain}`);
      if (!response.ok) throw new Error('Analysis not found');
      return response.json();
    },
    enabled: !!(selectedMunicipality && selectedDomain && realmId),
  });

  // Color coding function based on environmental protection scores
  const getFeatureColor = (feature: WestchesterGeoFeature): string => {
    if (!selectedDomain) {
      return '#94a3b8'; // Default gray
    }

    // For school districts realm, use policy-based coloring with new DISTRICT_ID
    if (realmId === 'westchester-schools-sustainability') {
      // First try to match by DISTRICT_ID (most reliable)
      const districtId = feature.properties.DISTRICT_ID;
      if (districtId) {
        // Priority 1: Environmental protection scores (green gradient) from consolidated data
        const districtSummary = domainSummary?.find(s => s.entityId === districtId || s.municipalityId === districtId);
        if (districtSummary && districtSummary.scoreColor) {
          return districtSummary.scoreColor;
        }
        
        // Priority 2: Domain summary data
        const summary = domainSummary?.find(s => s.entityId === districtId);
        if (summary?.color) {
          return summary.color;
        }
        
        // Priority 3: Available data flag
        if (summary?.available) {
          return '#8b5cf6'; // Purple for available data
        }
      }
      
      // Fallback to name-based matching if no DISTRICT_ID
      const featureName = feature.properties.DISTNAME || feature.properties.NAME;
      if (featureName) {
        const summary = domainSummary?.find(s => 
          s.entityName === featureName || 
          s.entityId === featureName?.replace(/\s+/g, '-')
        );
        return summary?.color || '#e2e8f0'; // Use color from summary or light gray
      }
      
      return '#94a3b8'; // Gray if no identifier found
    }

    // For municipalities, use the existing logic
    if (!municipalities) {
      return '#94a3b8'; // Default gray
    }

    // Try to find municipality by exact ID match first (for dropdown selections)
    let municipality: Municipality | undefined;
    const municipalityId = feature.properties.MUNICIPALITY_ID;
    if (municipalityId) {
      municipality = municipalities.find(m => m.id === municipalityId);
    }
    
    // Only fall back to fuzzy matching if no exact ID match found (for map clicks)
    // Suppress console logs during color calculation to avoid noise
    if (!municipality) {
      // Create a modified feature with a flag to suppress logging
      const modifiedFeature = { ...feature, properties: { ...feature.properties, _suppressLogging: true } };
      municipality = findMunicipalityByGeoFeature(modifiedFeature);
    }
    
    if (!municipality) {
      return '#94a3b8'; // Gray for unmatched
    }

    // Priority 1: Environmental protection scores (green gradient) from consolidated data
    const municipalitySummary = domainSummary?.find(s => s.municipalityId === municipality.id);
    if (municipalitySummary && municipalitySummary.scoreColor) {
      return municipalitySummary.scoreColor;
    }

    // Priority 2: Check if municipality uses state code (blue)
    const summary = domainSummary?.find(s => s.municipalityId === municipality.id);
    if (summary?.stateCodeApplies) {
      return '#3b82f6'; // Blue for state code municipalities
    }

    // Priority 3: Default colors based on data availability (removed WEN grade coloring)
    if (summary?.available) {
      return '#8b5cf6'; // Purple for available data without scores
    }

    return '#e2e8f0'; // Light gray for unavailable/no data
  };

  // Style function for each feature
  const getFeatureStyle = (feature: any) => ({
    fillColor: getFeatureColor(feature),
    weight: 2,
    opacity: 1,
    color: '#ffffff',
    dashArray: '',
    fillOpacity: 0.7
  });

  // Event handlers
  const highlightFeature = (e: any) => {
    const layer = e.target;
    layer.setStyle({
      weight: 3,
      color: '#333',
      dashArray: '',
      fillOpacity: 0.8
    });
    layer.bringToFront();
    // Note: Don't set selectedFeature on hover - only on click
  };

  const resetHighlight = (e: any) => {
    if (geoJsonRef.current) {
      geoJsonRef.current.resetStyle(e.target);
    }
    // Note: Don't clear selectedFeature on mouseout - only on click
  };

  const showTooltip = (e: any) => {
    const feature = e.target.feature as WestchesterGeoFeature;
    const municipality = findMunicipalityByGeoFeature({ ...feature, properties: { ...feature.properties, _suppressLogging: true } });
    
    if (municipality && jurisdictionCacheRef.current[realmId]?.[municipality.id]) {
      const cachedData = jurisdictionCacheRef.current[realmId][municipality.id];
      const container = e.target._map.getContainer();
      const containerRect = container.getBoundingClientRect();
      
      // Ensure tooltip positioning works correctly in both map styles
      const x = e.originalEvent.clientX - containerRect.left + 10;
      const y = e.originalEvent.clientY - containerRect.top - 10;
      
      setHoverTooltip({
        visible: true,
        x: Math.max(0, Math.min(x, container.offsetWidth - 200)), // Keep within bounds
        y: Math.max(0, Math.min(y, container.offsetHeight - 80)), // Keep within bounds
        jurisdictionName: cachedData.name,
        score: cachedData.score
      });
    }
  };

  const hideTooltip = () => {
    setHoverTooltip(prev => ({ ...prev, visible: false }));
  };

  const clickFeature = (e: any) => {
    const feature = e.target.feature as WestchesterGeoFeature;
    const municipality = findMunicipalityByGeoFeature(feature);
    
    if (municipality) {
      setSelectedFeature(feature);
      
      // Always call onMunicipalityClick to update parent state
      if (onMunicipalityClick) {
        console.log('Calling onMunicipalityClick with:', municipality.id);
        onMunicipalityClick(municipality.id);
      } else {
        console.log('No onMunicipalityClick callback provided');
      }
      
      // Additionally, on mobile, show popup overlay
      if (window.innerWidth < 768) {
        setShowMobilePopup(true);
      }
    } else {
      console.log('🗺️ Map Debug - No municipality found for feature:', feature?.properties?.NAME || feature?.properties?.DISTRICT_NAME || feature?.properties?.DISTNAME, 'Available properties:', Object.keys(feature?.properties || {}));
    }
  };

  const onEachFeature = (feature: any, layer: any) => {
    console.log('🔧 DEBUG: onEachFeature called for:', feature.properties?.NAME || 'Unknown');
    layer.on({
      click: (e: any) => {
        console.log('🔥 DEBUG: CLICK EVENT FIRED for:', e.target.feature?.properties?.NAME || 'Unknown');
        clickFeature(e);
      },
      mouseover: (e: any) => {
        highlightFeature(e);
        showTooltip(e);
      },
      mouseout: (e: any) => {
        resetHighlight(e);
        hideTooltip();
      }
    });
  };

  // Westchester County center coordinates
  const westchesterCenter: [number, number] = [41.1220, -73.7949];

  // Map style configurations
  const mapConfigs = {
    roads: {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors'
    },
    outline: {
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP////hDwAFAAECWb5nHwAAAABJRU5ErkJggg==",
      attribution: 'Community Boundaries'
    }
  };

  if (geoLoading || municipalitiesLoading) {
    return (
      <div className={`flex items-center justify-center h-96 bg-gray-100 rounded-lg ${className}`}>
        <div className="text-gray-500">Loading map...</div>
      </div>
    );
  }

  // Handle mobile popup close
  const closeMobilePopup = () => {
    setShowMobilePopup(false);
    setSelectedFeature(null);
  };

  if (isMapCollapsed) {
    return (
      <div className={`${className}`}>
        <div className="flex items-center justify-between p-4 bg-gray-50 border rounded-lg">
          <span className="text-sm font-medium text-gray-700">Map Hidden</span>
          <button
            onClick={() => setIsMapCollapsed(false)}
            className="flex items-center gap-2 px-3 py-1 text-sm bg-civic-blue text-white rounded-lg hover:bg-civic-blue-dark transition-colors"
          >
            <ChevronDown className="w-4 h-4" />
            Show Map
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      {/* Hover tooltip */}
      {hoverTooltip.visible && (
        <div
          className="absolute z-[1000] bg-gray-900 text-white text-sm px-3 py-2 rounded-lg shadow-lg pointer-events-none whitespace-nowrap"
          style={{
            left: hoverTooltip.x,
            top: hoverTooltip.y,
            transform: 'translateY(-100%)'
          }}
        >
          <div className="font-medium">{hoverTooltip.jurisdictionName}</div>
          {selectedDomain && hoverTooltip.score !== undefined && (
            <div className="text-xs text-gray-300 mt-1">
              {hoverTooltip.score > 0 ? `Score: ${hoverTooltip.score.toFixed(1)}` : 'Data available'}
            </div>
          )}
        </div>
      )}
      <div className="h-full w-full">
        <MapContainer
          center={westchesterCenter}
          zoom={10}
          style={{ 
            height: '100%', 
            width: '100%',
            backgroundColor: mapStyle === 'outline' ? '#ffffff' : 'inherit'
          }}
          className="rounded-lg"
        >
          <TileLayer
            url={mapConfigs[mapStyle].url}
            attribution={mapConfigs[mapStyle].attribution}
            opacity={mapStyle === "outline" ? 0 : 1}
          />
          
          {geoData && (
            <GeoJSON
              key={`geojson-${realmId}-${geoData.features.length}`}
              ref={geoJsonRef}
              data={geoData}
              style={getFeatureStyle}
              onEachFeature={onEachFeature}
            />
          )}
        </MapContainer>
      </div>

      {/* Environmental Protection Legend - Only show when roads are displayed */}
      {selectedDomain && mapStyle === "roads" && (
        <div className="absolute bottom-4 right-4 bg-white p-3 rounded-lg shadow-lg border max-w-xs">
          <h4 className="font-medium mb-2 text-sm">Environmental Protection</h4>
          
          {/* Environmental Scores (Green Gradient) */}
          {domainSummary && domainSummary.some(s => s.score && s.score > 0) && (
            <div className="mb-3">
              <h5 className="text-xs font-medium text-gray-600 mb-1">Strength Scores</h5>
              <div className="space-y-1 text-xs">
                {getEnvironmentalScoreLegend().map((item, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded" style={{backgroundColor: item.color}}></div>
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* Other indicators */}
          <div className="space-y-1 text-xs">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded" style={{backgroundColor: '#3b82f6'}}></div>
              <span>Uses NY State Code</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded" style={{backgroundColor: '#8b5cf6'}}></div>
              <span>WEN Graded (No Score)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded" style={{backgroundColor: '#e2e8f0'}}></div>
              <span>No Data Available</span>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Small Dialog Popup */}
      {showMobilePopup && selectedFeature && selectedDomain && (
        <div className="fixed inset-0 bg-black bg-opacity-30 z-[9999] md:hidden flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full mx-4">
            <div className="p-4">
              {/* Header */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 pr-2">
                  <h4 className="font-semibold text-gray-900 text-base mb-1">
                    {selectedFeature.properties.NAME}
                  </h4>
                  <p className="text-xs text-gray-600">
                    {selectedFeature.properties.TYPE}
                  </p>
                </div>
                <button 
                  onClick={closeMobilePopup}
                  className="text-gray-400 hover:text-gray-600 p-1 -mr-1"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Domain & Environmental Protection Summary */}
              {(() => {
                const municipality = findMunicipalityByGeoFeature(selectedFeature);
                if (!municipality || !domainSummary) return null;
                
                const summary = domainSummary.find(s => s.municipalityId === municipality.id);
                const municipalitySummaryData = domainSummary?.find(s => s.municipalityId === municipality.id);
                const environmentalScore = municipalitySummaryData?.score ? { score: municipalitySummaryData.score, color: municipalitySummaryData.scoreColor } : null;
                const domainName = selectedDomain?.charAt(0).toUpperCase() + selectedDomain?.slice(1).replace(/-/g, ' ');
                
                // Priority 1: Environmental protection score
                if (environmentalScore) {
                  const scoreCategory = environmentalScore.score >= 8.0 ? 'Strong' :
                                       environmentalScore.score >= 5.0 ? 'Moderate' :
                                       environmentalScore.score >= 2.0 ? 'Weak' : 'Very Weak';
                  
                  return (
                    <div className="mb-3 text-center">
                      <p className="text-sm text-gray-600 mb-2">{domainName} Protection</p>
                      <div className="space-y-2">
                        <span 
                          className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium text-gray-900"
                          style={{backgroundColor: environmentalScore.color}}
                        >
                          Score: {environmentalScore.score.toFixed(1)}/10.0 ({scoreCategory})
                        </span>
                        {summary?.grade && (
                          <div className="text-xs text-gray-500">
                            WEN Grade: {summary.grade}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }
                
                // Priority 2: State code
                if (summary?.stateCodeApplies) {
                  return (
                    <div className="mb-3 text-center">
                      <p className="text-sm text-gray-600 mb-2">{domainName} Regulations</p>
                      <span 
                        className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium text-white"
                        style={{backgroundColor: '#3b82f6'}}
                      >
                        Uses NY State Code
                      </span>
                    </div>
                  );
                }
                
                // Priority 3: WEN grade without score
                if (summary?.grade && summary?.available) {
                  return (
                    <div className="mb-3 text-center">
                      <p className="text-sm text-gray-600 mb-2">{domainName} Regulations</p>
                      <span 
                        className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium text-white"
                        style={{backgroundColor: summary.gradeColor || '#8b5cf6'}}
                      >
                        WEN Grade: {summary.grade}
                      </span>
                    </div>
                  );
                }
                
                // Priority 4: Available data without grade/score
                if (summary?.available) {
                  return (
                    <div className="mb-3 text-center">
                      <p className="text-sm text-gray-600 mb-2">{domainName} Regulations</p>
                      <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                        Data Available
                      </span>
                    </div>
                  );
                }
                
                // Default: No data
                return (
                  <div className="mb-3 text-center">
                    <p className="text-sm text-gray-600 mb-2">{domainName} Regulations</p>
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                      No Data Available
                    </span>
                  </div>
                );
              })()}

              {/* Simple Analysis Summary */}
              {analysisLoading ? (
                <div className="mb-4 text-center">
                  <div className="animate-pulse">
                    <div className="h-3 bg-gray-200 rounded mb-2"></div>
                    <div className="h-3 bg-gray-200 rounded w-2/3 mx-auto"></div>
                  </div>
                </div>
              ) : analysisData && analysisData.questions?.length > 0 ? (
                <div className="mb-4 text-center">
                  <p className="text-sm text-gray-600 mb-1">
                    {analysisData.questions.length} questions analyzed
                  </p>
                  <p className="text-xs text-gray-500">
                    Tap below to view detailed regulations and answers
                  </p>
                </div>
              ) : (
                <div className="mb-4 text-center">
                  <p className="text-sm text-gray-500">No analysis available</p>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-2">
                {(() => {
                  const municipality = findMunicipalityByGeoFeature(selectedFeature);
                  if (!municipality) return null;
                  
                  const municipalitySlug = !municipality.singular 
                    ? `NY-${municipality.name}-${municipality.type}`.replace(/\s+/g, '-')
                    : `NY-${municipality.name}`.replace(/\s+/g, '-');
                  
                  return (
                    <>
                      <button
                        onClick={() => {
                          closeMobilePopup();
                          if (onMunicipalityClick) {
                            onMunicipalityClick(municipality.id);
                          }
                          // In mobile mode, show analysis in right pane instead of navigating
                          // The onMunicipalityClick callback will handle showing the analysis
                        }}
                        className="flex-1 bg-civic-blue text-white font-medium py-2 px-3 rounded-md hover:bg-civic-blue-dark transition-colors text-sm"
                      >
                        View Analysis
                      </button>
                      <button
                        onClick={closeMobilePopup}
                        className="px-3 py-2 font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors text-sm"
                      >
                        Close
                      </button>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Desktop Analysis Popup */}
      {selectedFeature && selectedDomain && !showMobilePopup && (
        <div className="absolute top-4 right-4 bg-white rounded-lg shadow-xl border max-w-sm z-50 hidden md:block">
          <div className="p-4">
            {/* Header */}
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1">
                <h4 className="font-semibold text-gray-900 text-lg mb-1">
                  {selectedFeature.properties.NAME}
                </h4>
                <p className="text-sm text-gray-600">
                  {selectedFeature.properties.TYPE} • {selectedDomain?.charAt(0).toUpperCase() + selectedDomain?.slice(1)}
                </p>
              </div>
              <button 
                onClick={() => setSelectedFeature(null)}
                className="text-gray-400 hover:text-gray-600 ml-2"
              >
                ✕
              </button>
            </div>

            {/* Grade Badge */}
            {(() => {
              const municipality = findMunicipalityByGeoFeature(selectedFeature);
              if (!municipality || !domainSummary) return null;
              
              const summary = domainSummary.find(s => s.municipalityId === municipality.id);
              
              if (!summary || !summary.available) {
                return (
                  <div className="mb-3">
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                      No Data Available
                    </span>
                  </div>
                );
              }

              if (summary.grade) {
                return (
                  <div className="mb-3">
                    <span 
                      className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium text-white"
                      style={{backgroundColor: summary.gradeColor || '#8b5cf6'}}
                    >
                      WEN Grade: {summary.grade}
                    </span>
                  </div>
                );
              }
              
              return (
                <div className="mb-3">
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-purple-100 text-purple-800">
                    Data Available
                  </span>
                </div>
              );
            })()}

            {/* Analysis Preview */}
            {analysisLoading ? (
              <div className="mb-4">
                <div className="animate-pulse">
                  <div className="h-4 bg-gray-200 rounded mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded mb-2 w-3/4"></div>
                  <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                </div>
              </div>
            ) : analysisData && analysisData.questions?.length > 0 ? (
              <div className="mb-4">
                <h5 className="font-medium text-gray-900 mb-2">Key Questions:</h5>
                <div className="space-y-2">
                  {analysisData.questions.slice(0, 2).map((question: any, idx: number) => (
                    <div key={idx} className="text-sm">
                      <p className="font-medium text-gray-800 mb-1">
                        {question.title}
                      </p>
                      <p className="text-gray-600 text-xs leading-relaxed">
                        {question.answer.length > 120 
                          ? `${question.answer.substring(0, 120)}...` 
                          : question.answer
                        }
                      </p>
                    </div>
                  ))}
                  {analysisData.questions.length > 2 && (
                    <p className="text-xs text-gray-500 italic">
                      +{analysisData.questions.length - 2} more questions
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="mb-4">
                <p className="text-sm text-gray-500">No analysis available for this domain.</p>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-2">
              {(() => {
                const municipality = findMunicipalityByGeoFeature(selectedFeature);
                if (!municipality) return null;
                
                const municipalitySlug = !municipality.singular 
                  ? `NY-${municipality.name}-${municipality.type}`.replace(/\s+/g, '-')
                  : `NY-${municipality.name}`.replace(/\s+/g, '-');
                
                return (
                  <>
                    <button
                      onClick={() => {
                        if (onMunicipalityClick) {
                          onMunicipalityClick(municipality.id);
                        }
                        // Navigate to full analysis
                        const url = `/${selectedDomain}/${municipalitySlug}`;
                        window.location.href = url;
                      }}
                      className="flex-1 bg-civic-blue text-white text-sm font-medium py-2 px-3 rounded-lg hover:bg-civic-blue-dark transition-colors"
                    >
                      View Full Analysis
                    </button>
                    <button
                      onClick={() => setSelectedFeature(null)}
                      className="px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                    >
                      Close
                    </button>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Map Style Toggle - Below the map */}
      {!isMapCollapsed && (
        <div className="flex items-center justify-center mt-3" data-testid="map-toggle-container">
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={mapStyle === "roads"}
              onChange={(e) => setMapStyle(e.target.checked ? "roads" : "outline")}
              className="rounded border-gray-300 dark:border-gray-600 text-civic-blue focus:ring-civic-blue focus:ring-2"
              data-testid="checkbox-show-roads"
            />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Show roads
            </span>
          </label>
        </div>
      )}
    </div>
  );
}