import { AlertCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiPath } from "../../lib/apiConfig";
import { Card, CardContent } from "../../ui";
import { getEntityScoreColor, formatColumnValue } from "../../lib/domainScoring";
import type { DomainDataFile, Entity, Realm } from "@civillyengaged/ordinizer-core";

interface SidebarDataProps {
  realmId: string;
  domainId: string;
  selectedEntityId: string;
  entities: Entity[] | undefined;
  currentRealm: Realm | undefined;
}

export function SidebarData({ realmId, domainId, selectedEntityId, entities }: SidebarDataProps) {
  const { data: domainDataFile, isLoading } = useQuery<DomainDataFile | null>({
    queryKey: [apiPath("realms"), realmId, "domains", domainId, "data"],
    queryFn: async () => {
      const response = await fetch(apiPath(`realms/${realmId}/domains/${domainId}/data`));
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!realmId && !!domainId,
    staleTime: 1000 * 60 * 10,
  });

  const entity = entities?.find((e) => e.id === selectedEntityId);
  const dataRow = domainDataFile?.rows.find((r) => r.entityId === selectedEntityId);

  return (
    <Card className="shadow-sm border border-gray-200">
      <CardContent className="p-4">
        {isLoading ? (
          <div className="flex justify-center items-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-civic-blue"></div>
          </div>
        ) : !domainDataFile ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            <AlertCircle className="mx-auto mb-2" size={20} />
            No data available for this domain.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-center border-b pb-4">
              <h3 className="text-xl font-bold text-gray-900 mb-1">
                {entity?.displayName || selectedEntityId}
              </h3>
              <h4 className="text-base text-civic-blue capitalize">{domainDataFile.domain}</h4>

              {/* Score badge */}
              {domainDataFile.scoring?.length && dataRow && (() => {
                const scoring = domainDataFile.scoring![0];
                const color = getEntityScoreColor(dataRow, scoring);
                const value = dataRow[scoring.scoreColumn];
                const colLabel = domainDataFile.columns.find(c => c.key === scoring.scoreColumn)?.label ?? scoring.scoreColumn;
                if (color && value != null) {
                  return (
                    <div className="mt-2">
                      <span
                        className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium text-white"
                        style={{ backgroundColor: color }}
                      >
                        {colLabel}: {formatColumnValue(value, scoring.scoreColumnFormat)}
                      </span>
                    </div>
                  );
                }
                return null;
              })()}
            </div>

            {!dataRow ? (
              <div className="text-center text-gray-500 py-4 text-sm">
                No data available for this entity.
              </div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {domainDataFile.columns.map((col) => (
                    <tr key={col.key} className="border-b border-gray-100 last:border-0">
                      <td className="py-2 pr-3 text-gray-500 font-medium w-1/2">{col.label}</td>
                      <td className="py-2 text-gray-800">
                        {formatColumnValue(dataRow[col.key], col.type)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {domainDataFile.sourceUrl && (
              <div className="text-xs text-gray-400 pt-2 border-t">
                Source:{" "}
                <a
                  href={domainDataFile.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-civic-blue hover:underline"
                >
                  {domainDataFile.sourceUrl}
                </a>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
