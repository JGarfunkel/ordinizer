import { Link, useLocation } from 'wouter';
import { ExternalLink } from 'lucide-react';
import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui';
import { getEnvironmentalScoreColor, getStateCodeLegendItem } from '../lib/scoreColors';
import { ScoreVisualization } from './ScoreVisualization';

export interface CombinedMatrixData {
  domains: Array<{
    id: string;
    displayName: string;
    description?: string;
  }>;
  entities: Array<{
    entity: {
      id: string;
      displayName: string;
      mainUrl?: string;
    };
    domains: Record<string, {
      statuteNumber?: string;
      statuteTitle?: string;
      sourceUrl?: string;
      score?: number;
      scoreColor?: string;
      referencesStateCode?: boolean;
      hasStatute: boolean;
      overallSummary?: string;
    }>;
  }>;
}

export type MatrixScoreDisplay = 'number' | 'horizontal' | 'vertical' | 'none';

interface CombinedMatrixTableProps {
  matrixData: CombinedMatrixData;
  realmId: string;
  buildPath: (path: string) => string;
  documentType?: string;
  entityType: string;
  stateCodeItem: ReturnType<typeof getStateCodeLegendItem>;
  stateProvince?: string;
  matrixScoreDisplay: MatrixScoreDisplay;
  /** Full page lets the user toggle sticky headers off for printing; the compact panel is always sticky. */
  stickyEnabled?: boolean;
  /** 'full' is the dedicated matrix page; 'compact' is the condensed dashboard preview. */
  variant?: 'full' | 'compact';
}

export function CombinedMatrixTable({
  matrixData,
  realmId,
  buildPath,
  documentType,
  entityType,
  stateCodeItem,
  stateProvince,
  matrixScoreDisplay,
  stickyEnabled = true,
  variant = 'full',
}: CombinedMatrixTableProps) {
  const compact = variant === 'compact';
  const sticky = compact ? true : stickyEnabled;
  const [, navigate] = useLocation();

  return (
    <TooltipProvider>
    <table className={`w-full border-collapse${compact ? ' text-sm' : ''}`}>
      <thead>
        <tr className="bg-gray-50 border-b">
          <th
            className={`${compact ? 'px-3 py-2' : 'px-4 py-3'} text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r ${compact ? 'w-36' : 'w-48'} bg-gray-50 ${sticky ? 'sticky top-0 left-0 z-20' : ''}`}
          >
            {entityType}
          </th>
          {matrixData.domains.map((domain) => (
            <th
              key={domain.id}
              className={`px-2 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider border-r last:border-r-0 ${compact ? 'w-40' : 'w-52'} bg-gray-50 ${sticky ? 'sticky top-0 z-10' : ''}`}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link href={buildPath(`/realm/${realmId}/${domain.id}/matrix`)}>
                    {compact ? (
                      <span className="cursor-pointer hover:text-civic-blue transition-colors">
                        {domain.displayName}
                      </span>
                    ) : (
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
                    )}
                  </Link>
                </TooltipTrigger>
                {domain.description && (
                  <TooltipContent className="w-[300px] max-w-[300px] bg-gray-900 text-white text-sm font-medium normal-case leading-snug px-3 py-2">
                    {domain.description}
                  </TooltipContent>
                )}
              </Tooltip>
            </th>
          ))}
        </tr>
      </thead>

      <tbody>
        {matrixData.entities.map((entityRow, index) => (
          <tr
            key={entityRow.entity.id}
            className={`border-b hover:bg-gray-50 ${index % 2 === 0 ? 'bg-white' : 'bg-gray-25'}`}
          >
            {/* Entity Name */}
            <td className={`px-3 py-2 border-r bg-gray-50 ${sticky ? 'sticky left-0 z-10' : ''}`}>
              {compact ? (
                <div className="font-medium text-xs text-gray-900 truncate max-w-[130px]">
                  {entityRow.entity.displayName}
                </div>
              ) : (
                <div className="font-medium text-sm text-gray-900">
                  {entityRow.entity.displayName}
                  {entityRow.entity.mainUrl && (
                    <a
                      href={entityRow.entity.mainUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-civic-blue hover:text-civic-blue-dark text-xs"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              )}
            </td>

            {/* Domain Cells */}
            {matrixData.domains.map((domain) => {
              const domainData = entityRow.domains[domain.id];

              // State Code Reference
              if (domainData?.referencesStateCode) {
                return (
                  <td
                    key={domain.id}
                    className="px-2 py-2 text-center border-r last:border-r-0"
                    style={{ backgroundColor: stateCodeItem?.color ?? '#93c5fd' }}
                    data-testid={`cell-${entityRow.entity.id}-${domain.id}-state`}
                  >
                    <Badge variant="secondary" className="bg-white/20 text-white text-xs">
                      {stateProvince ?? 'State'} Code
                    </Badge>
                  </td>
                );
              }

              // No document for this domain
              if (!domainData?.hasStatute) {
                return (
                  <td
                    key={domain.id}
                    className="px-2 py-2 text-center border-r last:border-r-0"
                    style={{ backgroundColor: '#e2e8f0' }} // Standard map color for no data
                    data-testid={`cell-${entityRow.entity.id}-${domain.id}-empty`}
                  >
                    <span className={compact ? 'text-gray-400 text-base' : 'text-gray-500 text-lg'}>—</span>
                  </td>
                );
              }

              // Has document
              return (
                <td
                  key={domain.id}
                  className="px-2 py-2 border-r last:border-r-0 align-top cursor-pointer"
                  style={{
                    backgroundColor: domainData.score !== undefined ? getEnvironmentalScoreColor(domainData.score) : (domainData.scoreColor || '#e2e8f0')
                  }}
                  role="link"
                  tabIndex={0}
                  onClick={() => navigate(buildPath(`/realm/${realmId}/${domain.id}/${entityRow.entity.id}`))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(buildPath(`/realm/${realmId}/${domain.id}/${entityRow.entity.id}`));
                    }
                  }}
                  data-testid={`cell-${entityRow.entity.id}-${domain.id}`}
                >
                  <div className={matrixScoreDisplay === 'vertical' ? 'flex items-start justify-center gap-1.5' : 'text-center'}>
                    {/* Vertical score sits beside the text instead of taking its own row */}
                    {matrixScoreDisplay === 'vertical' && domainData.score !== undefined && (
                      <div
                        className="flex-shrink-0"
                        data-testid={`score-link-${entityRow.entity.id}-${domain.id}`}
                      >
                        <ScoreVisualization
                          score={domainData.score}
                          maxScore={1}
                          direction="vertical"
                          className="scale-75 flex-shrink-0"
                        />
                      </div>
                    )}

                    <div className={matrixScoreDisplay === 'vertical' ? 'text-left min-w-0' : ''}>
                      {/* Score + statute on one line */}
                      <div className={matrixScoreDisplay === 'vertical' ? '' : `inline-flex items-center justify-center ${compact ? 'gap-1' : 'gap-1.5'}`}>
                        {matrixScoreDisplay !== 'vertical' && domainData.score !== undefined && (
                          <span
                            className={`${compact ? 'text-xs' : 'text-sm'} font-bold text-gray-900`}
                            data-testid={`score-link-${entityRow.entity.id}-${domain.id}`}
                          >
                            {matrixScoreDisplay === 'number' && (
                              (domainData.score * 10).toFixed(1)
                            )}
                            {matrixScoreDisplay === 'horizontal' && (
                              <ScoreVisualization
                                score={domainData.score}
                                maxScore={1}
                                direction="horizontal"
                                className="scale-75"
                              />
                            )}
                          </span>
                        )}
                        {documentType === 'statute' && domainData.sourceUrl && (
                          <a
                            href={domainData.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className={`inline-flex items-center gap-0.5 ${compact ? 'text-[10px]' : 'text-[11px]'} text-gray-600 hover:opacity-80 transition-opacity`}
                            data-testid={`document-link-${entityRow.entity.id}-${domain.id}`}
                          >
                            {domainData.statuteNumber && (
                              <span className="truncate max-w-[60px]">{domainData.statuteNumber}</span>
                            )}
                            {!compact && domainData.statuteTitle && (
                              <span className="truncate max-w-[100px]">{domainData.statuteTitle}</span>
                            )}
                            <ExternalLink className={compact ? 'w-2.5 h-2.5 flex-shrink-0' : 'w-3 h-3 flex-shrink-0'} />
                          </a>
                        )}
                      </div>

                      {/* Overall Summary */}
                      {domainData.overallSummary && (
                        <p className={`${compact ? 'text-[10px]' : 'text-[12px]'} text-gray-600 leading-tight mt-0.5`}>
                          {domainData.overallSummary}
                        </p>
                      )}
                    </div>
                  </div>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
    </TooltipProvider>
  );
}
