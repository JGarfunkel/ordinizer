import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from "@ordinizer/client/ui";
import { getEnvironmentalScoreLegend } from '../lib/scoreColors';
import { Button } from "@ordinizer/client/ui";
import { Badge } from "@ordinizer/client/ui";
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { apiPath } from "../lib/apiConfig";
import { Link, useParams } from 'wouter';
import { useEffect, useState } from 'react';
import { getDefaultRealmId } from '../lib/realmUtils';
import { useBasePath } from '../contexts/BasePathContext';

interface CombinedMatrixData {
  domains: Array<{
    id: string;
    displayName: string;
    description?: string;
  }>;
  municipalities: Array<{
    municipality: {
      id: string;
      displayName: string;
    };
    domains: Record<string, {
      statuteNumber?: string;
      statuteTitle?: string;
      sourceUrl?: string;
      score?: number;
      scoreColor?: string;
      referencesStateCode?: boolean;
      hasStatute: boolean;
    }>;
  }>;
}

export default function CombinedMatrix() {
  const params = useParams();
  const [realmId, setRealmId] = useState<string>(params.realmid || '');
  const { buildPath } = useBasePath();

  // Resolve realm ID dynamically if not provided in URL
  useEffect(() => {
    async function resolveRealm() {
      if (!params.realmid) {
        const defaultRealmId = await getDefaultRealmId();
        if (defaultRealmId) {
          setRealmId(defaultRealmId);
        }
      } else {
        setRealmId(params.realmid);
      }
    }
    
    resolveRealm();
  }, [params.realmid]);

  // Fetch realm info to determine terminology
  const { data: realms } = useQuery<Array<any>>({
    queryKey: [apiPath('realms')],
    staleTime: 1000 * 60 * 60 // Cache for 1 hour
  });

  const currentRealm = realms?.find((r: any) => r.id === realmId);
  const isPolicy = currentRealm?.type === 'policy';
  const documentType = isPolicy ? 'policy' : 'statute';
  const documentTypeCapitalized = isPolicy ? 'Policy' : 'Statute';
  const entityType = currentRealm?.entityType === 'school-districts' ? 'School District' : 'Municipality';

  const { data: matrixData, isLoading, error } = useQuery<CombinedMatrixData>({
    queryKey: [apiPath('realms'), realmId, 'combined-matrix'],
    enabled: !!realmId, // Only query when realmId is available
    staleTime: 1000 * 60 * 5 // Cache for 5 minutes
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
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
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
      <Card className="shadow-sm border border-gray-200">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl">{entityType} {documentTypeCapitalized} Analysis Matrix</CardTitle>
          <p className="text-sm text-gray-600">
            Each cell shows {documentType} number, title, and environmental protection score. Click cells for detailed analysis.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <div className="min-w-full">
              <table className="w-full border-collapse">
                {/* Header Row */}
                <thead>
                  <tr className="bg-gray-50 border-b sticky top-0 z-10">
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r w-48 bg-gray-50">
                      {entityType}
                    </th>
                    {matrixData.domains.map((domain) => (
                      <th 
                        key={domain.id}
                        className="px-2 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider border-r last:border-r-0 w-52 bg-gray-50"
                        title={domain.description}
                      >
                        <Link href={buildPath(`/realm/${realmId}/${domain.id}/matrix`)}>
                          <div className="space-y-1 cursor-pointer hover:text-civic-blue transition-colors">
                            <div className="font-semibold flex items-center justify-center gap-1">
                              {domain.displayName}
                              <ExternalLink className="w-3 h-3" />
                            </div>
                            {domain.description && (
                              <div className="text-[10px] text-gray-400 normal-case leading-tight line-clamp-2">
                                {domain.description}
                              </div>
                            )}
                          </div>
                        </Link>
                      </th>
                    ))}
                  </tr>
                </thead>

                {/* Data Rows */}
                <tbody>
                  {matrixData.municipalities.map((municipalityRow, index) => (
                    <tr 
                      key={municipalityRow.municipality.id}
                      className={`border-b hover:bg-gray-50 ${index % 2 === 0 ? 'bg-white' : 'bg-gray-25'}`}
                    >
                      {/* Municipality Name */}
                      <td className="px-3 py-2 border-r bg-gray-50 sticky left-0 z-10">
                        <div className="font-medium text-sm text-gray-900">
                          {municipalityRow.municipality.displayName}
                        </div>
                      </td>

                      {/* Domain Cells */}
                      {matrixData.domains.map((domain) => {
                        const domainData = municipalityRow.domains[domain.id];
                        
                        // State Code Reference
                        if (domainData?.referencesStateCode) {
                          return (
                            <td 
                              key={domain.id}
                              className="px-2 py-2 text-center border-r last:border-r-0"
                              style={{ backgroundColor: '#93c5fd' }} // Lighter blue for state code
                              data-testid={`cell-${municipalityRow.municipality.id}-${domain.id}-state`}
                            >
                              <Badge variant="secondary" className="bg-white/20 text-white text-xs">
                                NY State Code
                              </Badge>
                            </td>
                          );
                        }
                        
                        // No {documentTypeCapitalized}
                        if (!domainData?.hasStatute) {
                          return (
                            <td 
                              key={domain.id}
                              className="px-2 py-2 text-center border-r last:border-r-0"
                              style={{ backgroundColor: '#e2e8f0' }} // Standard map color for no data
                              data-testid={`cell-${municipalityRow.municipality.id}-${domain.id}-empty`}
                            >
                              <span className="text-gray-500 text-lg">—</span>
                            </td>
                          );
                        }
                        
                        // Has {documentTypeCapitalized}
                        return (
                          <td 
                            key={domain.id}
                            className="px-2 py-2 border-r last:border-r-0"
                            style={{ 
                              backgroundColor: domainData.scoreColor || '#e2e8f0' // Light gray for data without score
                            }}
                            data-testid={`cell-${municipalityRow.municipality.id}-${domain.id}`}
                          >
                            <div className="text-center">
                              {/* Single line with ID, Title, and Link - Links to sourceUrl */}
                              <a 
                                href={domainData.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center gap-1 text-[10px] text-gray-700 mb-1 hover:opacity-80 transition-opacity"
                                data-testid={`document-link-${municipalityRow.municipality.id}-${domain.id}`}
                              >
                                {domainData.statuteNumber && (
                                  <span className="truncate max-w-[60px]">{domainData.statuteNumber}</span>
                                )}
                                {domainData.statuteTitle && (
                                  <span className="truncate max-w-[120px]">
                                    {domainData.statuteTitle}
                                  </span>
                                )}
                                <ExternalLink className="w-3 h-3 text-gray-500 flex-shrink-0" />
                              </a>
                              
                              {/* Environmental Score on separate line - Links to analysis page */}
                              {domainData.score !== undefined && (
                                <Link 
                                  href={buildPath(`/${domain.id}/${municipalityRow.municipality.id}`)}
                                  className="block text-sm font-bold text-gray-900 hover:opacity-80 transition-opacity"
                                  data-testid={`score-link-${municipalityRow.municipality.id}-${domain.id}`}
                                >
                                  {(domainData.score * 10).toFixed(1)}
                                </Link>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Legend */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">Legend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <h5 className="text-sm font-medium text-gray-700 mb-2">Environmental Protection Scores</h5>
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
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded" style={{backgroundColor: '#93c5fd'}}></div>
                  <span className="text-sm">Uses NY State Code</span>
                </div>

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