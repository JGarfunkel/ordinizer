import { Grid } from "lucide-react";
import { Button } from "../../ui";
import { Skeleton } from "../../ui";
import type { EntityDomain } from "@civillyengaged/ordinizer-core";
import type { DomainItem } from "./types";

interface DomainSelectorProps {
  allDomains: DomainItem[] | undefined;
  selectedDomainId: string;
  selectedEntityId: string;
  availableDomains: EntityDomain[] | undefined;
  allDomainsLoading: boolean;
  domainsLoading: boolean;
  documentType: string;
  selectedRealmId: string;
  onDomainChange: (domainId: string, isAvailable?: boolean) => void;
  navigate: (path: string) => void;
  buildPath: (path: string) => string;
}

export function DomainSelector({
  allDomains,
  selectedDomainId,
  selectedEntityId,
  availableDomains,
  allDomainsLoading,
  domainsLoading,
  documentType,
  selectedRealmId,
  onDomainChange,
  navigate,
  buildPath,
}: DomainSelectorProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {domainsLoading || allDomainsLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-32 rounded-full" />
          ))
        ) : !allDomains || allDomains.length === 0 ? (
          <div className="text-gray-500">No domains available</div>
        ) : (
          allDomains.map((domain) => {
            const domainId = domain.id;
            const domainData = availableDomains?.find((d) => d.id === domainId);
            const isAvailable = !selectedEntityId || domainData?.available !== false;
            const grade = domainData?.grade;

            return (
              <button
                key={domainId}
                onClick={() => onDomainChange(domainId, isAvailable)}
                disabled={Boolean(selectedEntityId && !isAvailable)}
                className={`
                  px-4 py-2 rounded-full text-sm font-medium transition-all duration-200
                  ${
                    selectedDomainId === domainId
                      ? "bg-civic-blue text-white shadow-lg ring-2 ring-civic-blue ring-offset-2"
                      : ""
                  }
                  ${
                    isAvailable && selectedDomainId !== domainId && selectedEntityId
                      ? "ring-1 ring-civic-blue/50 bg-civic-blue/5"
                      : ""
                  }
                  ${selectedEntityId && !isAvailable ? "opacity-60" : ""}
                  ${
                    !selectedEntityId && selectedDomainId !== domainId
                      ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                      : ""
                  }
                `}
                title={
                  selectedEntityId && !isAvailable
                    ? `No ${documentType} available for this domain`
                    : selectedEntityId
                    ? "Available"
                    : domain.description || `${domain.displayName} regulations`
                }
              >
                {domain.displayName}
                {grade && (
                  <span className="ml-1 text-xs">({String(grade).toUpperCase()})</span>
                )}
              </button>
            );
          })
        )}
      </div>

      {selectedDomainId && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              navigate(buildPath(`/realm/${selectedRealmId}/${selectedDomainId}/matrix`))
            }
            data-testid="button-matrix-view"
            className="flex items-center gap-2"
          >
            <Grid className="w-4 h-4" />
            View Analysis Matrix
          </Button>
        </div>
      )}
    </div>
  );
}
