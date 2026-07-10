import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from "../ui";
import { getEnvironmentalScoreLegend, getStateCodeLegendItem } from '../lib/scoreColors';
import { Button } from "../ui";
import { ArrowLeft, Printer } from 'lucide-react';
import { apiPath } from "../lib/apiConfig";
import { Link } from 'wouter';
import { useState } from 'react';
import { useRealmId } from '../hooks/useRealmId';
import { useBasePath } from '../contexts/BasePathContext';
import { useRealms } from '../hooks/useRealms';
import { SourceMapEntity, SourceMapLink } from '@civillyengaged/ordinizer-core';
import { SourcesPopup, SourcesIconButton } from "../components/SourcesPopup";
import { CombinedMatrixTable, type CombinedMatrixData } from "../components/CombinedMatrixTable";



export default function CombinedMatrix() {
  const realmId = useRealmId() ?? '';
  const { buildPath } = useBasePath();

  // Fetch realm info to determine terminology
  const { data: realms } = useRealms();

  const currentRealm = realms?.find((r: any) => r.id === realmId);
  const documentType = currentRealm?.ruleType;
  const documentTypeCapitalized = documentType ? documentType.charAt(0).toUpperCase() + documentType.slice(1) : '';
  const entityType = currentRealm?.entityType === 'school-districts' ? 'School District' : 'Entity';
  const scoreText = currentRealm?.terminology?.scoreText ?? 'Score';
  const stateCodeItem = getStateCodeLegendItem(currentRealm);
  const matrixScoreDisplay = currentRealm?.ui?.matrixScoreDisplay ?? 'horizontal';

  const { data: matrixData, isLoading, error } = useQuery<CombinedMatrixData>({
    queryKey: [apiPath('realms'), realmId, 'combined-matrix'],
    enabled: !!realmId, // Only query when realmId is available
    staleTime: 1000 * 60 * 5 // Cache for 5 minutes
  });

  const [stickyEnabled, setStickyEnabled] = useState(true);

  const [selectedSources, setSelectedSources] = useState<{
    entity: string;
    domainName: string;
    sources: SourceMapLink[];
  } | null>(null);

  const { data: datasources } = useQuery<Record<string, SourceMapEntity>>({
    queryKey: [apiPath(`realms/${realmId}/datasources`)],
    enabled: !!realmId,
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center min-h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-civic-blue mx-auto mb-4"></div>
            <p className="text-gray-600">Loading combined matrix...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !matrixData) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Error Loading Matrix</h2>
          <p className="text-gray-600 mb-4">Failed to load the combined analysis matrix.</p>
          <Link href={buildPath(`/realm/${realmId}`)}>
            <Button variant="outline">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Home
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 pt-8 h-dvh flex flex-col overflow-hidden">
      {/* Header */}
      <div className="mb-4 flex-shrink-0">
        <div className="flex items-center gap-4 mb-4">
          <Link href={buildPath(`/realm/${realmId}`)}>
            <Button variant="outline" size="sm">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Home
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Combined Analysis Matrix</h1>
            <p className="text-gray-600 mt-1">
              Complete overview of all {entityType.toLowerCase()}s and domains with {documentType} information and scores
            </p>
          </div>
        </div>
      </div>

      {/* Matrix Table */}
      <Card className="shadow-sm border border-gray-200 flex-1 min-h-0 flex flex-col">
        <CardHeader className="pb-4 flex-shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl">{entityType} {documentTypeCapitalized} Analysis Matrix</CardTitle>
            <button
              onClick={() => setStickyEnabled(v => !v)}
              className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border transition-colors ${stickyEnabled ? 'border-gray-300 text-gray-500 hover:border-gray-400' : 'border-civic-blue text-civic-blue bg-blue-50'}`}
              title={stickyEnabled ? 'Disable sticky headers for printing' : 'Re-enable sticky headers'}
            >
              <Printer className="w-3.5 h-3.5" />
              {stickyEnabled ? 'Print mode' : 'Sticky mode'}
            </button>
          </div>
          <p className="text-sm text-gray-600">
            Each cell shows {documentType} number, title, and environmental protection score. Click cells for detailed analysis.
          </p>
        </CardHeader>
        <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
          <div className={stickyEnabled ? 'flex-1 min-h-0 overflow-auto' : 'overflow-x-auto'}>
            <div className="min-w-full">
              <CombinedMatrixTable
                matrixData={matrixData}
                realmId={realmId}
                buildPath={buildPath}
                documentType={documentType}
                entityType={entityType}
                stateCodeItem={stateCodeItem}
                stateProvince={currentRealm?.geo?.stateProvince}
                matrixScoreDisplay={matrixScoreDisplay}
                stickyEnabled={stickyEnabled}
                variant="full"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sources Popup (single, after table) */}
      {selectedSources && (
        <SourcesPopup
          entity={selectedSources.entity}
          domainName={selectedSources.domainName}
          sources={selectedSources.sources}
          open={!!selectedSources}
          onOpenChange={(open) => !open && setSelectedSources(null)}
        />
      )}

      {/* Legend */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">Legend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <h5 className="text-sm font-medium text-gray-700 mb-2">{scoreText}s</h5>
              <div className="space-y-1">
                {getEnvironmentalScoreLegend().map((item, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded" style={{backgroundColor: item.color}}></div>
                    <span className="text-sm">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h5 className="text-sm font-medium text-gray-700 mb-2">Other Indicators</h5>
              <div className="space-y-1">
                {stateCodeItem && (
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded" style={{backgroundColor: stateCodeItem.color}}></div>
                    <span className="text-sm">{stateCodeItem.label}</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded" style={{backgroundColor: '#e2e8f0'}}></div>
                  <span className="text-sm">No Data Available</span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


