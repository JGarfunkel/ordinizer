import { AlertCircle, ArrowLeft, HelpCircle, FileText, ExternalLink } from "lucide-react";
import { Card, CardContent } from "../../ui";
import { Button } from "../../ui";
import StatuteLink from "../../components/StatuteLink";
import type { Analysis, Entity, EntityDomain } from "@ordinizer/core";
import type { ScoreData } from "./types";

function isNotSpecified(answer: string): boolean {
  const lower = answer.toLowerCase();
  return (
    lower.includes("not specified") ||
    lower.includes("no specific") ||
    lower.includes("does not specify")
  );
}

interface FullAnalysisViewProps {
  analysisData: Analysis | undefined;
  analysisLoading: boolean;
  scoreData: ScoreData | undefined;
  usesStateCode: boolean;
  municipalities: Entity[] | undefined;
  selectedEntityId: string;
  selectedEntity: Entity | undefined;
  selectedDomain: EntityDomain | undefined;
  documentType: string;
  onBack: () => void;
  onQuestionMarkClick: (questionId: string, domainId: string) => void;
}

export function FullAnalysisView({
  analysisData,
  analysisLoading,
  scoreData,
  usesStateCode,
  municipalities,
  selectedEntityId,
  selectedEntity,
  selectedDomain,
  documentType,
  onBack,
  onQuestionMarkClick,
}: FullAnalysisViewProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left sidebar - Back button */}
      <div className="lg:col-span-1 space-y-4">
        <Card className="shadow-sm border border-gray-200">
          <CardContent className="p-4">
            <Button variant="outline" onClick={onBack} className="w-full">
              <ArrowLeft size={16} className="mr-2" />
              Back to Selection
            </Button>
            {selectedEntity && (
              <div className="mt-4">
                <h3 className="font-semibold text-gray-900 mb-2">Selected</h3>
                <p className="text-sm text-gray-600 mb-1">{selectedEntity.displayName}</p>
                <p className="text-sm text-civic-blue capitalize">{selectedDomain?.displayName}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Main content */}
      <div className="lg:col-span-2">
        {analysisLoading ? (
          <div className="flex justify-center items-center py-8">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-civic-blue"></div>
          </div>
        ) : analysisData ? (
          <div className="space-y-6">
            {/* Header */}
            <Card className="shadow-sm border border-gray-200">
              <CardContent className="p-6">
                <div className="text-center">
                  <h1 className="text-2xl font-bold text-gray-900 mb-2">
                    {usesStateCode
                      ? municipalities?.find((m) => m.id === selectedEntityId)?.displayName
                      : analysisData.municipality.displayName}
                  </h1>
                  <h2 className="text-lg text-civic-blue mb-4 capitalize">
                    {analysisData.domain.displayName} Regulations
                  </h2>
                  {usesStateCode ? (
                    <div className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-600 text-white">
                      No Local Code, Uses State Code
                    </div>
                  ) : (
                    <div className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-civic-blue text-white">
                      {analysisData.domain.grade
                        ? `Grade: ${String(analysisData.domain.grade).toUpperCase()}`
                        : "Analysis Available"}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Environmental Protection Score */}
            {scoreData && !usesStateCode && (
              <Card className="shadow-sm border border-gray-200">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center">
                      <div
                        className="w-8 h-8 rounded-full mr-3 flex items-center justify-center"
                        style={{ backgroundColor: scoreData.scoreColor }}
                      >
                        <span className="text-white text-sm font-bold">★</span>
                      </div>
                      <h2 className="text-xl font-semibold text-gray-900">
                        Environmental Protection Score
                      </h2>
                    </div>
                    <div className="text-3xl font-bold text-green-700">
                      {(scoreData.overallScore * 10).toFixed(1)}/10.0
                    </div>
                  </div>
                  <div className="text-sm text-gray-600">
                    <p>
                      Weighted Score: {scoreData.totalWeightedScore.toFixed(1)} out of{" "}
                      {scoreData.totalPossibleWeight} possible points
                    </p>
                    <p className="mt-1 text-xs">
                      Based on weighted analysis of {scoreData.questions.length} environmental
                      protection questions
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Questions and Answers */}
            {analysisData.questions.length > 0 && (
              <Card className="shadow-sm border border-gray-200">
                <CardContent className="p-6">
                  <div className="flex items-center mb-6">
                    <div className="w-8 h-8 bg-civic-blue rounded-full flex items-center justify-center flex-shrink-0 mr-3">
                      <HelpCircle className="text-white text-sm" />
                    </div>
                    <h2 className="text-xl font-semibold text-gray-900">
                      Common Questions & Answers
                      {scoreData && (
                        <span className="ml-2 text-sm text-gray-500 font-normal">
                          (with Environmental Protection Scores)
                        </span>
                      )}
                    </h2>
                  </div>
                  <div className="space-y-4">
                    {analysisData.questions.map((qa, index) => {
                      const scoredQuestion = scoreData?.questions.find((sq) => sq.id === qa.id);
                      const hasGap = (scoredQuestion && scoredQuestion.score < 1.0) || qa.gap;

                      return (
                        <div
                          key={index}
                          className="border-l-4 border-civic-blue bg-blue-50 p-4 rounded-r-lg"
                        >
                          <div className="flex items-start justify-between mb-2">
                            <h3 className="font-semibold text-gray-900 text-base flex-1">
                              Q: {qa.question}
                            </h3>
                            {scoredQuestion && (
                              <div className="ml-4 text-right flex-shrink-0 bg-white rounded-md px-2 py-1">
                                <div className="text-sm font-medium text-gray-700">
                                  Score: {(scoredQuestion.score * 10).toFixed(1)}/10.0
                                </div>
                                {scoredQuestion.weight !== 1 && (
                                  <div className="text-xs text-gray-500">
                                    Weight: {scoredQuestion.weight}x ={" "}
                                    {scoredQuestion.weightedScore.toFixed(1)} pts
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-start gap-2 mb-2">
                            <p className="text-gray-700 text-sm leading-relaxed flex-1">
                              A: {qa.answer}
                            </p>
                            {isNotSpecified(qa.answer) && (
                              <button
                                onClick={() =>
                                  onQuestionMarkClick(qa.id.toString(), analysisData.domain.id)
                                }
                                className="text-gray-400 hover:text-blue-600 transition-colors flex-shrink-0"
                                title="See municipalities that have specified this requirement"
                              >
                                <HelpCircle size={16} />
                              </button>
                            )}
                          </div>
                          {hasGap && qa.gap && (
                            <div className="mt-3 p-3 bg-orange-50 border-l-4 border-orange-400 rounded-r border">
                              <p className="text-sm text-orange-700 font-medium flex items-center mb-2">
                                <span className="inline-block w-5 h-5 text-center mr-2">🔧</span>
                                Improvement Gap:
                              </p>
                              <p className="text-sm text-orange-600">{qa.gap}</p>
                            </div>
                          )}
                          {((qa.sourceReference && qa.sourceReference.trim()) ||
                            (qa.relevantSections && qa.relevantSections.length > 0)) && (
                            <p className="text-xs text-blue-600 mt-2">
                              Reference:{" "}
                              <StatuteLink
                                municipalityId={analysisData.municipality.id}
                                domainId={analysisData.domain.id}
                              >
                                <span className="ml-1">
                                  {qa.relevantSections && qa.relevantSections.length > 0
                                    ? qa.relevantSections.join(", ")
                                    : qa.sourceReference}
                                </span>
                              </StatuteLink>
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Analysis & Recommendations */}
            {analysisData.alignmentSuggestions && (
              <Card className="shadow-sm border border-gray-200">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center">
                      <div className="w-8 h-8 bg-civic-blue rounded-full flex items-center justify-center flex-shrink-0 mr-3">
                        <FileText className="text-white text-sm" />
                      </div>
                      <h2 className="text-xl font-semibold text-gray-900">
                        Analysis & Recommendations
                      </h2>
                    </div>
                    <StatuteLink
                      municipalityId={analysisData.municipality.id}
                      domainId={analysisData.domain.id}
                    >
                      <Button variant="outline" size="sm" className="text-xs">
                        View Source File
                        <ExternalLink className="w-3 h-3 ml-1" />
                      </Button>
                    </StatuteLink>
                  </div>
                  <div className="space-y-6">
                    {analysisData.alignmentSuggestions.strengths &&
                      analysisData.alignmentSuggestions.strengths.length > 0 && (
                        <div>
                          <h3 className="font-semibold text-green-700 mb-3 text-lg">Strengths</h3>
                          <ul className="space-y-2">
                            {analysisData.alignmentSuggestions.strengths.map((strength, i) => (
                              <li key={i} className="flex items-start">
                                <div className="w-2 h-2 bg-green-500 rounded-full mt-2 mr-3 flex-shrink-0"></div>
                                <span className="text-gray-700 text-sm leading-relaxed">
                                  {strength}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    {analysisData.alignmentSuggestions.improvements &&
                      analysisData.alignmentSuggestions.improvements.length > 0 && (
                        <div>
                          <h3 className="font-semibold text-orange-700 mb-3 text-lg">
                            Areas for Improvement
                          </h3>
                          <ul className="space-y-2">
                            {analysisData.alignmentSuggestions.improvements.map((item, i) => (
                              <li key={i} className="flex items-start">
                                <div className="w-2 h-2 bg-orange-500 rounded-full mt-2 mr-3 flex-shrink-0"></div>
                                <span className="text-gray-700 text-sm leading-relaxed">{item}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    {analysisData.alignmentSuggestions.recommendations &&
                      analysisData.alignmentSuggestions.recommendations.length > 0 && (
                        <div>
                          <h3 className="font-semibold text-blue-700 mb-3 text-lg">
                            Recommendations
                          </h3>
                          <ul className="space-y-2">
                            {analysisData.alignmentSuggestions.recommendations.map((rec, i) => (
                              <li key={i} className="flex items-start">
                                <div className="w-2 h-2 bg-blue-500 rounded-full mt-2 mr-3 flex-shrink-0"></div>
                                <span className="text-gray-700 text-sm leading-relaxed">{rec}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    {analysisData.alignmentSuggestions.bestPractices &&
                      analysisData.alignmentSuggestions.bestPractices.length > 0 && (
                        <div>
                          <h3 className="font-semibold text-purple-700 mb-3 text-lg">
                            Best Practices
                          </h3>
                          <ul className="space-y-2">
                            {analysisData.alignmentSuggestions.bestPractices.map((practice, i) => (
                              <li key={i} className="flex items-start">
                                <div className="w-2 h-2 bg-purple-500 rounded-full mt-2 mr-3 flex-shrink-0"></div>
                                <span className="text-gray-700 text-sm leading-relaxed">
                                  {practice}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          <Card className="shadow-sm border border-gray-200">
            <CardContent className="p-8 text-center">
              <AlertCircle className="mx-auto h-12 w-12 text-red-500 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">Analysis Not Found</h3>
              <p className="text-civic-gray-light">
                No {documentType} analysis is available for {selectedEntity?.displayName} in the{" "}
                {selectedDomain?.displayName} domain.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
