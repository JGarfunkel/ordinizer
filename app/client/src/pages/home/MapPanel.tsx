import { Database } from "lucide-react";
import { Link } from "wouter";
import { Card, CardContent } from "../../ui";
import { Button } from "../../ui";
import EntityMap from "../../components/EntityMap";
import type { Realm } from "@ordinizer/core";

interface MapPanelProps {
  selectedDomainId: string;
  selectedEntityId: string;
  selectedRealmId: string;
  currentRealm: Realm | undefined;
  entitiesLoading: boolean;
  onEntityClick: (entityId: string) => void;
  buildPath: (path: string) => string;
}

export function MapPanel({
  selectedDomainId,
  selectedEntityId,
  selectedRealmId,
  currentRealm,
  entitiesLoading,
  onEntityClick,
  buildPath,
}: MapPanelProps) {
  return (
    <div className="flex-shrink-0 w-full lg:w-auto">
      <Card className="shadow-sm border border-gray-200">
        <CardContent className="p-0">
          <div className="w-full lg:w-[450px] h-[300px] sm:h-[400px] lg:h-[500px]">
            {selectedRealmId && !entitiesLoading ? (
              <EntityMap
                selectedDomain={selectedDomainId}
                onEntityClick={onEntityClick}
                allowCollapse={true}
                className="w-full h-full"
                selectedEntityId={selectedEntityId}
                realmId={selectedRealmId}
                realm={currentRealm}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-gray-50">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-2"></div>
                  <p className="text-sm text-gray-600">Loading map...</p>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {selectedDomainId && (
        <Card className="shadow-sm border border-gray-200 mt-3">
          <CardContent className="p-4">
            <h4 className="font-medium mb-3 text-sm">Map Legend</h4>

            <div className="mb-3">
              <h5 className="text-xs font-medium text-gray-600 mb-2">
                Environmental Protection Scores
              </h5>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: "#22c55e" }}></div>
                  <span>Strong (8.0-10.0)</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: "#65d47f" }}></div>
                  <span>Moderate (5.0-7.9)</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: "#a7e6b7" }}></div>
                  <span>Weak (2.0-4.9)</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: "#bbf7d0" }}></div>
                  <span>Very Weak (0.0-1.9)</span>
                </div>
              </div>
            </div>

            <div>
              <h5 className="text-xs font-medium text-gray-600 mb-2">Other Indicators</h5>
              <div className="grid grid-cols-1 gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: "#3b82f6" }}></div>
                  <span>Uses NY State Code</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: "#8b5cf6" }}></div>
                  <span>Available Data (No Score)</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: "#e2e8f0" }}></div>
                  <span>No Data Available</span>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t">
              <Link href={buildPath(`/questions/${selectedRealmId}/domains`)}>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full flex items-center justify-center gap-2 text-xs"
                >
                  <Database className="w-3 h-3" />
                  Questions and Scoring
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
