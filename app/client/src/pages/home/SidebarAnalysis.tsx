import { AlertCircle, HelpCircle, FileText } from "lucide-react";
import { Card, CardContent } from "../../ui";
import StatuteLink from "../../components/StatuteLink";
import { ScoreVisualization } from "../../components/ScoreVisualization";
import type { Analysis, Entity, Realm } from "@civillyengaged/ordinizer-core";
import type { ScoreData, VersionsData } from "./types";

function isNotSpecified(answer: string): boolean {
  const lower = answer.toLowerCase();
  return (
    lower.includes("not specified") ||
    lower.includes("no specific") ||
    lower.includes("does not specify")
  );
}

interface SidebarAnalysisProps {
  analysisData: Analysis | undefined;
  analysisLoading: boolean;
  versionsData: VersionsData | undefined;
  scoreData: ScoreData | undefined;
  selectedVersion: string;
  onVersionChange: (version: string) => void;
  usesStateCode: boolean;
  municipalities: Entity[] | undefined;
  selectedEntityId: string;
  currentRealm: Realm | undefined;
  onQuestionMarkClick: (questionId: string, domainId: string) => void;
}

export function SidebarAnalysis({
  analysisData,
  analysisLoading,
  versionsData,
  scoreData,
  selectedVersion,
  onVersionChange,
  usesStateCode,
  municipalities,
  selectedEntityId,
  currentRealm,
  onQuestionMarkClick,
}: SidebarAnalysisProps) {
  return (
    <Card className="shadow-sm border border-gray-200">
      <CardContent className="p-4">
        {analysisLoading ? (
          <div className="flex justify-center items-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-civic-blue"></div>
          </div>
        ) : analysisData ? (
          <div className="space-y-4">
            {/* Header */}
            <div className="text-center border-b pb-4">
              <h3 className="text-xl font-bold text-gray-900 mb-1">
                {usesStateCode
                  ? municipalities?.find((m) => m.id === selectedEntityId)?.displayName
                  : analysisData?.municipality?.displayName}
              </h3>
              <h4 className="text-base text-civic-blue capitalize">
                {analysisData?.domain?.displayName} Regulations
              </h4>
              {usesStateCode ? (
                <div className="inline-flex items-center px-3 py-2 mt-2 rounded-full text-sm font-medium bg-blue-600 text-white">
                  No Local Code, Uses State Code
                </div>
              ) : (
                analysisData?.domain?.grade && (
                  <div className="inline-flex items-center px-3 py-2 mt-2 rounded-full text-sm font-medium bg-civic-blue text-white">
                    Grade: {String(analysisData?.domain?.grade).toUpperCase()}
                  </div>
                )
              )}

              {/* Version Selector */}
              {versionsData && versionsData.versions.length > 1 && (
                <div className="mt-3 flex items-center justify-center gap-2">
                  <label htmlFor="version-select" className="text-xs text-gray-600">
                    Analysis Version:
                  </label>
                  <select
                    id="version-select"
                    value={selectedVersion}
                    onChange={(e) => onVersionChange(e.target.value)}
                    className="text-xs border border-gray-300 rounded px-2 py-1 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
                    data-testid="select-analysis-version"
                  >
                    {versionsData.versions.map((version) => {
                      const date = new Date(version.timestamp);
                      const formattedDate = date.toLocaleString(navigator.language, {
                        year: "numeric",
                        month: "numeric",
                        day: "numeric",
                        hour: "numeric",
                        minute: "numeric",
                        second: "numeric",
                        hour12: true,
                      });
                      return (
                        <option key={version.version} value={version.version}>
                          {version.displayName} ({formattedDate})
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}
            </div>

            {/* Environmental Protection Summary */}
            {scoreData && !usesStateCode && (
              <div className="border p-4 rounded-lg bg-gradient-to-r from-green-50 to-green-100">
                <div className="flex items-center justify-between mb-2">
                  <h5 className="text-base font-semibold text-gray-900 flex items-center">
                    <div
                      className="w-4 h-4 rounded-full mr-2"
                      style={{ backgroundColor: scoreData.scoreColor }}
                    ></div>
                    Environmental Protection Score
                  </h5>
                  <div className="text-lg font-bold text-green-700" title="score out of 10.0">
                    {scoreData.overallScore.toFixed(1)}
                  </div>
                </div>
              </div>
            )}

            {/* Questions and Answers */}
            {analysisData?.questions?.length > 0 ? (
              <div>
                <h5 className="text-base font-semibold text-gray-900 mb-3 flex items-center">
                  <HelpCircle className="text-civic-blue mr-2" size={18} />
                  Common Questions
                  {scoreData && (
                    <span className="ml-2 text-xs text-gray-500">
                      (Environmental scores shown below)
                    </span>
                  )}
                </h5>
                <div className="space-y-4">
                  {analysisData?.questions?.map((qa, index) => {
                    const scoredQuestion = scoreData?.questions.find((sq) => sq.id === qa.id);
                    const hasGap = (scoredQuestion && scoredQuestion.score < 1.0) || qa.gap;

                    return (
                      <div
                        key={index}
                        className="text-sm border-b border-gray-100 pb-3 last:border-b-0"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <p className="font-medium text-gray-800 flex-1">{qa.question}</p>
                          {scoredQuestion && (
                            <div className="ml-3 flex-shrink-0">
                              <ScoreVisualization score={scoredQuestion.score} maxScore={1} />
                            </div>
                          )}
                        </div>
                        <div className="flex items-start gap-2 mb-2">
                          <div className="text-gray-600 leading-relaxed flex-1">
                            <p>{qa.answer}</p>
                            {(() => {
                              if (!qa.analyzedAt || !analysisData?.lastUpdated) return null;
                              const questionTime = new Date(qa.analyzedAt);
                              const overallTime = new Date(analysisData?.lastUpdated);
                              const diffMinutes =
                                Math.abs(questionTime.getTime() - overallTime.getTime()) /
                                (1000 * 60);
                              if (diffMinutes > 10) {
                                return (
                                  <p className="text-xs text-gray-500 mt-1 italic">
                                    Updated: {questionTime.toLocaleDateString()}{" "}
                                    {questionTime.toLocaleTimeString()}
                                  </p>
                                );
                              }
                              return null;
                            })()}
                          </div>
                          {isNotSpecified(qa.answer) && qa.id !== undefined && typeof analysisData?.domain?.id === "string" && (
                            <button
                              onClick={() =>
                                onQuestionMarkClick(String(qa.id), String(analysisData?.domain?.id))
                              }
                              className="text-gray-400 hover:text-blue-600 transition-colors flex-shrink-0"
                              title="See municipalities that have specified this requirement"
                            >
                              <HelpCircle size={14} />
                            </button>
                          )}
                        </div>
                        {hasGap && qa.gap && (
                          <div className="mt-2 p-2 bg-orange-50 border-l-4 border-orange-400 rounded-r">
                            <p className="text-xs text-orange-700 font-medium flex items-center">
                              <span className="inline-block w-4 h-4 text-center mr-2">🔧</span>
                              Improvement Gap:
                            </p>
                            <p className="text-xs text-orange-600 mt-1">{qa.gap}</p>
                          </div>
                        )}
                        {((qa.sourceReference && qa.sourceReference.trim()) ||
                          (qa.relevantSections && qa.relevantSections.length > 0)) && (
                          <p className="text-sm text-blue-600 italic">
                            Reference:{" "}
                            {qa.relevantSections && qa.relevantSections.length > 0 ? (
                              <span className="ml-1">
                                {(() => {
                                  const refs = qa.relevantSections as (string | { name: string; url?: string })[];
                                  const stateEntityId = usesStateCode
                                    ? `${currentRealm?.state}-State`
                                    : analysisData?.municipality?.id;
                                  return refs.map((ref, i) => {
                                    if (typeof ref === "string") {
                                      return (
                                        <span key={i}>
                                          <StatuteLink
                                            municipalityId={stateEntityId}
                                            domainId={analysisData?.domain?.id}
                                          >
                                            {ref}
                                          </StatuteLink>
                                          {i < refs.length - 1 && ", "}
                                        </span>
                                      );
                                    } else if (ref && typeof ref === "object" && "name" in ref) {
                                      return (
                                        <span key={i}>
                                          <StatuteLink
                                            href={ref.url}
                                            municipalityId={stateEntityId}
                                            domainId={analysisData?.domain?.id}
                                          >
                                            {ref.name}
                                          </StatuteLink>
                                          {i < refs.length - 1 && ", "}
                                        </span>
                                      );
                                    } else {
                                      return null;
                                    }
                                  });
                                })()}
                              </span>
                            ) : (
                              <StatuteLink
                                municipalityId={
                                  usesStateCode
                                    ? `${currentRealm?.state}-State`
                                    : analysisData?.municipality?.id
                                }
                                domainId={analysisData?.domain?.id}
                              >
                                <span className="ml-1">{qa.sourceReference}</span>
                              </StatuteLink>
                            )}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-center text-gray-500 py-8">
                <AlertCircle className="mx-auto mb-3" size={32} />
                <h5 className="text-lg font-medium mb-2">Analysis Processing Required</h5>
                <p className="text-sm">
                  The analysis for {analysisData?.municipality?.displayName}'s{" "}
                  {analysisData?.domain?.displayName} regulations needs to be generated. This will
                  provide answers to common questions about local requirements.
                </p>
              </div>
            )}

            {/* Analysis & Recommendations */}
            {analysisData?.alignmentSuggestions && (
              <div className="border-t pt-4 bg-blue-50/30 p-4 rounded-lg">
                <h5 className="text-base font-semibold text-gray-900 mb-3 flex items-center">
                  <FileText className="text-civic-blue mr-2" size={18} />
                  Analysis & Recommendations
                </h5>
                <div className="space-y-4 text-sm bg-white p-3 rounded border">
                  {analysisData?.alignmentSuggestions?.strengths &&
                    analysisData?.alignmentSuggestions?.strengths.length > 0 && (
                      <div>
                        <p className="font-medium text-green-700 mb-1">Strengths</p>
                        <ul className="list-disc list-inside text-gray-600 space-y-1">
                          {analysisData?.alignmentSuggestions?.strengths.map((strength, i) => (
                            <li key={i}>{strength}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  {analysisData?.alignmentSuggestions?.improvements &&
                    analysisData.alignmentSuggestions.improvements.length > 0 && (
                      <div>
                        <p className="font-medium text-orange-700 mb-1">Areas for Improvement</p>
                        <ul className="list-disc list-inside text-gray-600 space-y-1">
                          {analysisData.alignmentSuggestions.improvements.map((item, i) => (
                            <li key={i}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  {analysisData.alignmentSuggestions.recommendations &&
                    analysisData.alignmentSuggestions.recommendations.length > 0 && (
                      <div>
                        <p className="font-medium text-blue-700 mb-1">Recommendations</p>
                        <ul className="list-disc list-inside text-gray-600 space-y-1">
                          {analysisData.alignmentSuggestions.recommendations.map((rec, i) => (
                            <li key={i}>{rec}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  {analysisData.alignmentSuggestions.bestPractices &&
                    analysisData.alignmentSuggestions.bestPractices.length > 0 && (
                      <div>
                        <p className="font-medium text-purple-700 mb-1">Best Practices</p>
                        <ul className="list-disc list-inside text-gray-600 space-y-1">
                          {analysisData.alignmentSuggestions.bestPractices.map((practice, i) => (
                            <li key={i}>{practice}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-gray-500 text-sm">
            <AlertCircle className="mx-auto mb-2" size={20} />
            Analysis not available for this selection.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
