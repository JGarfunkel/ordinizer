import { useState } from "react";
import { Card, CardContent } from "../../ui";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { MetaAnalysis } from "@ordinizer/core";

interface MetaAnalysisPanelProps {
  metaAnalysisData: MetaAnalysis | undefined;
  metaLoading: boolean;
  selectedDomainId: string;
  onMetaEntityClick: (questionId: number, municipalityId: string, domainId: string) => void;
}

export function MetaAnalysisPanel({
  metaAnalysisData,
  metaLoading,
  selectedDomainId,
  onMetaEntityClick,
}: MetaAnalysisPanelProps) {
  if (metaLoading) {
    return (
      <Card className="shadow-sm border border-gray-200">
        <CardContent className="p-6 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-civic-blue mx-auto mb-4"></div>
          <p className="text-gray-600">Loading best practices analysis...</p>
        </CardContent>
      </Card>
    );
  }

  if (!metaAnalysisData) return null;

  const [open, setOpen] = useState(false);

  return (
    <Card className="shadow-sm border border-gray-200">
      {/* Collapsible header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors rounded-t-lg"
      >
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            {metaAnalysisData.domain?.displayName} — Best Practices Analysis
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {metaAnalysisData.bestPractices?.length || 0} best practices •{" "}
            {metaAnalysisData.totalMunicipalitiesAnalyzed} municipalities analysed
          </p>
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
        )}
      </button>

      {open && (
      <CardContent className="p-6 pt-0">
        <div className="space-y-6">

          {/* Best Practices */}
          <div>
            <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
              <span className="w-6 h-6 bg-civic-blue text-white rounded-full text-sm flex items-center justify-center mr-2">
                🏆
              </span>
              Best Practices Identified
            </h4>
            <div className="space-y-4">
              {metaAnalysisData?.bestPractices?.map((practice) => (
                <div
                  key={practice.questionId}
                  className="border-l-4 border-civic-blue bg-blue-50 p-4 rounded-r-lg"
                >
                  <div className="mb-3">
                    <h5 className="font-medium text-gray-900 mb-2">
                      Q{practice.questionId}: {practice.question}
                    </h5>
                    <p className="text-gray-700 text-sm leading-relaxed mb-3">
                      <strong>Best Practice:</strong> {practice.bestAnswer}
                    </p>
                    {practice.supportingExamples && practice.supportingExamples.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        <span className="text-xs text-gray-500 mr-2">References:</span>
                        {practice.supportingExamples.slice(0, 3).map((example, idx) => (
                          <button
                            key={idx}
                            onClick={() =>
                              onMetaEntityClick(
                                practice.questionId,
                                example.municipality.id,
                                selectedDomainId
                              )
                            }
                            className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded hover:bg-blue-200 transition-colors cursor-pointer"
                          >
                            {example.municipality.displayName}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {practice.quantitativeHighlights && practice.quantitativeHighlights.length > 0 && (
                    <div className="mt-3 p-3 bg-green-50 border-l-4 border-green-400 rounded-r border">
                      <p className="text-sm text-green-700 font-medium flex items-center mb-2">
                        <span className="inline-block w-5 h-5 text-center mr-2">📊</span>
                        Strongest Requirements:
                      </p>
                      <ul className="space-y-1">
                        {practice.quantitativeHighlights.map((highlight, idx) => (
                          <li key={idx} className="text-sm text-green-600 flex items-start">
                            <span className="w-1.5 h-1.5 bg-green-400 rounded-full mt-2 mr-2 flex-shrink-0"></span>
                            {highlight}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Model Municipalities */}
          {metaAnalysisData?.overallRecommendations?.modelMunicipalities?.length > 0 && (
            <div className="border-t pt-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4">Leading Municipalities</h4>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h5 className="font-medium text-green-700 mb-2">Top Performers</h5>
                  <ul className="space-y-1 text-sm text-gray-600">
                    {metaAnalysisData?.overallRecommendations?.modelMunicipalities
                      ?.slice(0, 6)
                      .map((municipality, index) => (
                        <li key={index} className="flex items-start">
                          <span className="w-1.5 h-1.5 bg-green-400 rounded-full mt-2 mr-2 flex-shrink-0"></span>
                          {municipality}
                        </li>
                      ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Call to Action */}
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-gray-700 mb-2">
              <strong>Click on a municipality</strong> above to see how it compares to these best
              practices
            </p>
            <p className="text-sm text-gray-500">
              Analysis shows specific improvement recommendations and performance gaps
            </p>
          </div>
        </div>
      </CardContent>
      )}
    </Card>
  );
}
