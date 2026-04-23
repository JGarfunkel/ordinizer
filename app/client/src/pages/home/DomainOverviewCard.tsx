import { AlertCircle, Ban, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { Card, CardContent } from "../../ui";
import type { Entity, EntityDomain } from "@ordinizer/core";
import type { DomainItem } from "./types";

interface DomainOverviewCardProps {
  selectedEntity: Entity | undefined;
  allDomains: DomainItem[] | undefined;
  availableDomains: EntityDomain[];
  selectedEntityId: string;
  onSelectDomain: (domainId: string) => void;
  navigate: (path: string) => void;
  buildPath: (path: string) => string;
}

export function DomainOverviewCard({
  selectedEntity,
  allDomains,
  availableDomains,
  selectedEntityId,
  onSelectDomain,
  navigate,
  buildPath,
}: DomainOverviewCardProps) {
  return (
    <Card className="shadow-sm border border-gray-200">
      <CardContent className="p-6">
        <div className="space-y-4">
          <div className="text-center border-b pb-4">
            <h3 className="text-xl font-bold text-gray-900 mb-2">
              {selectedEntity?.displayName} - Domain Overview
            </h3>
            <p className="text-sm text-gray-600">
              Environmental and municipal regulations analysis
            </p>
          </div>

          <div className="space-y-3">
            {allDomains
              ?.filter((domain) => domain.show !== false)
              .map((domain) => {
                const municipalityDomain = availableDomains.find((d) => d.id === domain.id);
                const hasData = municipalityDomain && municipalityDomain.available;
                const score = hasData ? (municipalityDomain as any)?.score?.score || null : null;

                return (
                  <div
                    key={domain.id}
                    className={`p-4 rounded-lg border cursor-pointer transition-colors hover:bg-gray-50 ${
                      hasData ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50"
                    }`}
                    onClick={() => {
                      if (hasData) {
                        onSelectDomain(domain.id);
                        navigate(buildPath(`/${domain.id}/${selectedEntityId}`));
                      }
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <h4 className="font-medium text-gray-900 mb-1">{domain.displayName}</h4>
                        <p className="text-sm text-gray-600 mb-2">{domain.description}</p>

                        {hasData ? (
                          <div className="flex items-center gap-4 text-xs">
                            <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded">
                              Local Regulations
                            </span>
                            {score !== null && (
                              <span
                                className={`px-2 py-1 rounded ${
                                  score >= 2.0
                                    ? "bg-green-100 text-green-700"
                                    : score >= 1.0
                                    ? "bg-yellow-100 text-yellow-700"
                                    : "bg-red-100 text-red-700"
                                }`}
                              >
                                Score: {(score * 10).toFixed(1)}/10
                              </span>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-xs text-gray-500">
                            {municipalityDomain && !municipalityDomain.available ? (
                              <>
                                <Ban className="w-3 h-3" />
                                Uses State Code
                              </>
                            ) : (
                              <>
                                <AlertCircle className="w-3 h-3" />
                                No Local Regulations
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {hasData && (
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/${domain.id}/${selectedEntityId}`}
                            className="text-blue-600 hover:text-blue-800 transition-colors"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </Link>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          <div className="pt-3 border-t text-center">
            <p className="text-xs text-gray-500">
              Click on a domain with local regulations to view detailed analysis
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
