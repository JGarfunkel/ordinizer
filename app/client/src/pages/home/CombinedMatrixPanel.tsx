import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui';
import { ExternalLink } from 'lucide-react';
import { Link } from 'wouter';
import { apiPath } from '../../lib/apiConfig';
import { getStateCodeLegendItem } from '../../lib/scoreColors';
import type { Realm } from '@civillyengaged/ordinizer-core';
import { CombinedMatrixTable, type CombinedMatrixData } from '../../components/CombinedMatrixTable';

// Leaves room below the table for whatever the host page renders under it (e.g. a footer).
const BOTTOM_GUTTER = 24;
const MIN_TABLE_HEIGHT = 240;

interface CombinedMatrixPanelProps {
  realmId: string;
  currentRealm: Realm | undefined;
  buildPath: (path: string) => string;
}

export function CombinedMatrixPanel({ realmId, currentRealm, buildPath }: CombinedMatrixPanelProps) {
  const documentType = currentRealm?.ruleType;
  const entityType = currentRealm?.entityType === 'school-districts' ? 'School District' : 'Entity';
  const stateCodeItem = getStateCodeLegendItem(currentRealm);
  const matrixScoreDisplay = currentRealm?.ui?.matrixScoreDisplay ?? 'horizontal';

  const { data: matrixData, isLoading } = useQuery<CombinedMatrixData>({
    queryKey: [apiPath('realms'), realmId, 'combined-matrix'],
    enabled: !!realmId,
    staleTime: 1000 * 60 * 5,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const [tableMaxHeight, setTableMaxHeight] = useState<number>();

  useEffect(() => {
    const recalculate = () => {
      const el = scrollRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const available = window.innerHeight - top - BOTTOM_GUTTER;
      setTableMaxHeight(Math.max(available, MIN_TABLE_HEIGHT));
    };

    recalculate();
    window.addEventListener('resize', recalculate);
    return () => window.removeEventListener('resize', recalculate);
    // isLoading/matrixData: recalculate once the table actually mounts and has a real offset
  }, [isLoading, matrixData]);

  if (isLoading) {
    return (
      <Card className="shadow-sm border border-gray-200 w-full">
        <CardContent className="flex items-center justify-center h-48">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-2"></div>
            <p className="text-sm text-gray-600">Loading matrix...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!matrixData) return null;

  return (
    <Card className="shadow-sm border border-gray-200 w-full min-w-0">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{entityType} Analysis Matrix</CardTitle>
          <Link href={buildPath(`/realm/${realmId}/combined-matrix`)}>
            <span className="text-xs text-civic-blue hover:underline flex items-center gap-1">
              Full view <ExternalLink className="w-3 h-3" />
            </span>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div
          ref={scrollRef}
          className="overflow-auto"
          style={{ maxHeight: tableMaxHeight ?? '70vh' }}
        >
          <CombinedMatrixTable
            matrixData={matrixData}
            realmId={realmId}
            buildPath={buildPath}
            documentType={documentType}
            entityType={entityType}
            stateCodeItem={stateCodeItem}
            stateProvince={currentRealm?.geo?.stateProvince}
            matrixScoreDisplay={matrixScoreDisplay}
            variant="compact"
          />
        </div>
      </CardContent>
    </Card>
  );
}
