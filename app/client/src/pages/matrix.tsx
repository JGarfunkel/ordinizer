import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'wouter';
import { ArrowLeft, Info, ExternalLink, RotateCcw } from 'lucide-react';
import { apiPath } from "../lib/apiConfig";
import { useState } from 'react';
import { useBasePath } from '../contexts/BasePathContext';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ordinizer/client/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@ordinizer/client/ui";
import { Button } from "@ordinizer/client/ui";
import { Badge } from "@ordinizer/client/ui";
import ScoreVisualization from '../components/ScoreVisualization';
import { getMatrixScoreColor, getEnvironmentalScoreGradient } from '../lib/scoreColors';

interface MatrixData {
  domain: {
    id: string;
    displayName: string;
  };
  questions: Array<{
    id: number;
    question: string;
    category?: string;
    weight?: number;
  }>;
  municipalities: Array<{
    id: string;
    displayName: string;
    scores: Record<number, {
      score: number;
      confidence: number;
      answer: string;
      sourceRefs: string[];
    }>;
    totalScore: number;
    statute?: {
      number: string;
      title: string;
      url: string;
    };
    referencesStateCode?: boolean;
  }>;
}

interface CellPopupProps {
  municipality: string;
  question: string;
  score: number;
  confidence: number;
  answer: string;
  sourceRefs: string[];
  analyzedAt?: string;
  lastUpdated?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CellPopup({ municipality, question, score, confidence, answer, sourceRefs, analyzedAt, lastUpdated, open, onOpenChange }: CellPopupProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {municipality}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {question}
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Badge variant="outline" className="text-sm">
              Score: {(score * 10).toFixed(1)}/10
            </Badge>
            <Badge variant="outline" className="text-sm">
              Confidence: {confidence}%
            </Badge>
          </div>
          
          <div>
            <h4 className="font-medium mb-2">Answer</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {answer}
            </p>
          </div>
          
          {sourceRefs && sourceRefs.length > 0 && (
            <div>
              <h4 className="font-medium mb-2">Source References</h4>
              <div className="flex flex-wrap gap-1">
                {sourceRefs.map((ref, index) => (
                  <Badge key={index} variant="secondary" className="text-xs">
                    {ref}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          
          {(() => {
            // Show per-question timestamp only if it differs by more than 10 minutes from overall timestamp
            if (!analyzedAt || !lastUpdated) return null;
            
            const questionTime = new Date(analyzedAt);
            const overallTime = new Date(lastUpdated);
            const diffMinutes = Math.abs(questionTime.getTime() - overallTime.getTime()) / (1000 * 60);
            
            if (diffMinutes > 10) {
              return (
                <div className="pt-2 border-t">
                  <p className="text-xs text-gray-500 italic">
                    Updated: {questionTime.toLocaleDateString()} {questionTime.toLocaleTimeString()}
                  </p>
                </div>
              );
            }
            return null;
          })()}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Functions now imported from centralized scoreColors utility

export default function MatrixPage() {
  const { domain, realmid } = useParams<{ domain: string; realmid: string }>();
  const { buildPath } = useBasePath();
  const [selectedCell, setSelectedCell] = useState<{
    municipality: string;
    question: string;
    score: number;
    confidence: number;
    answer: string;
    sourceRefs: string[];
    analyzedAt?: string;
    lastUpdated?: string;
  } | null>(null);

  // Fetch realm info to determine terminology
  const { data: realms } = useQuery<Array<any>>({
    queryKey: [apiPath('realms')],
    staleTime: 1000 * 60 * 60 // Cache for 1 hour
  });

  const currentRealm = realms?.find((r: any) => r.id === realmid);
  const isPolicy = currentRealm?.type === 'policy';
  const documentType = isPolicy ? 'policy' : 'statute';
  const documentTypeCapitalized = isPolicy ? 'Policy' : 'Statute';
  const entityType = currentRealm?.entityType === 'school-districts' ? 'School District' : 'Municipality';

  const { data: matrixData, isLoading, error, refetch } = useQuery<MatrixData>({
    queryKey: [apiPath(`domains/${realmid}/${domain}/matrix`)],
    enabled: !!domain && !!realmid,
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes - refreshes automatically
    refetchOnWindowFocus: true, // Refresh when user returns to tab
  });

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center gap-4 mb-6">
          <Link href={buildPath(`/realm/${realmid}`)}>
            <Button variant="ghost" size="sm" data-testid="button-back">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </Link>
          <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-48 animate-pulse"></div>
        </div>
        <div className="space-y-4">
          <div className="h-12 bg-gray-200 dark:bg-gray-700 rounded animate-pulse"></div>
          <div className="h-96 bg-gray-200 dark:bg-gray-700 rounded animate-pulse"></div>
        </div>
      </div>
    );
  }

  if (error || !matrixData) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center gap-4 mb-6">
          <Link href={buildPath(`/realm/${realmid}`)}>
            <Button variant="ghost" size="sm" data-testid="button-back">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </Link>
        </div>
        <div className="text-center py-12">
          <h2 className="text-xl font-semibold text-red-600 dark:text-red-400">
            Error Loading Matrix Data
          </h2>
          <p className="text-muted-foreground mt-2">
            Unable to load the matrix data for this domain.
          </p>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="container mx-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link href={buildPath(`/realm/${realmid}`)}>
              <Button variant="ghost" size="sm" data-testid="button-back">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
            </Link>
            <h1 className="text-2xl font-bold" data-testid="text-domain-title">
              {matrixData.domain.displayName} - Analysis Matrix
            </h1>
          </div>
          
          {/* Refresh Button */}
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => refetch()}
            disabled={isLoading}
            data-testid="button-refresh-matrix"
            className="flex items-center gap-2"
          >
            <RotateCcw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh Data
          </Button>
        </div>

        {/* Matrix Table */}
        <div className="border rounded-lg overflow-hidden">
          <div className="overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
            <table className="w-full min-w-max">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="sticky left-0 z-10 bg-muted/50 px-4 py-3 text-left font-medium w-[200px] border-r">
                      Municipality
                    </th>
                    <th className="sticky left-[200px] z-10 bg-muted/50 px-3 py-3 text-center font-medium w-[150px] border-r">
                      {documentTypeCapitalized}
                    </th>
                    <th className="sticky left-[350px] z-10 bg-muted/50 px-3 py-3 text-center font-medium w-[100px] border-r">
                      Total Score
                    </th>
                    {matrixData.questions.map((question) => (
                      <th key={question.id} className="px-3 py-3 text-center font-medium w-[120px] border-r last:border-r-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex flex-col items-center justify-center gap-1 cursor-help">
                              <div className="flex items-center gap-1">
                                <span className="text-xs leading-tight">
                                  {question.category || `Q${question.id}`}
                                </span>
                                <Info className="w-3 h-3 text-muted-foreground" />
                              </div>
                              {question.weight && question.weight !== 1 && (
                                <span className="text-xs text-gray-500 font-medium">
                                  x{question.weight}
                                </span>
                              )}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p className="text-sm">{question.question}</p>
                            {question.weight && question.weight !== 1 && (
                              <p className="text-xs text-gray-400 mt-1">
                                Weight: {question.weight}x
                              </p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {matrixData.municipalities.map((municipality) => (
                  <tr key={municipality.id} className="border-t hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background px-4 py-2 font-medium border-r w-[200px]">
                      <span data-testid={`text-municipality-${municipality.id}`}>
                        {municipality.displayName}
                      </span>
                    </td>
                    <td className="sticky left-[200px] z-10 bg-background px-3 py-2 text-center border-r w-[150px]">
                      {municipality.statute ? (
                        municipality.statute.number === 'State Code' ? (
                          <span className="text-xs font-medium text-blue-600 dark:text-blue-400" data-testid={`text-state-code-${municipality.id}`}>
                            State Code
                          </span>
                        ) : (
                          <a
                            href={municipality.statute.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex flex-col items-center gap-0.5 text-civic-blue hover:text-civic-blue-dark text-xs group"
                            data-testid={`link-statute-${municipality.id}`}
                            title={`${municipality.statute.number}${municipality.statute.title ? ` - ${municipality.statute.title}` : ''}`}
                          >
                            <div className="flex items-center gap-1">
                              <span className="font-medium">{municipality.statute.number}</span>
                              <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60 group-hover:opacity-100" />
                            </div>
                            {municipality.statute.title && (
                              <span className="text-[10px] text-muted-foreground truncate max-w-[120px] leading-tight">
                                {municipality.statute.title}
                              </span>
                            )}
                          </a>
                        )
                      ) : (
                        <span className="text-gray-400 text-xs">No {documentType}</span>
                      )}
                    </td>
                    <td 
                      className="sticky left-[350px] z-10 px-3 py-2 text-center border-r font-medium w-[100px]"
                      style={{
                        backgroundColor: municipality.referencesStateCode ? '#f8f9fa' : getEnvironmentalScoreGradient(municipality.totalScore || 0).backgroundColor,
                      }}
                    >
                      {municipality.referencesStateCode ? (
                        <span className="text-xs text-gray-400">—</span>
                      ) : (
                        <Link href={buildPath(`/${domain}/${municipality.id}`)}>
                          <span className={`text-sm font-medium cursor-pointer hover:underline ${getEnvironmentalScoreGradient(municipality.totalScore || 0).textColor}`} data-testid={`link-total-score-${municipality.id}`}>
                            {((municipality.totalScore || 0) * 10).toFixed(1)}
                          </span>
                        </Link>
                      )}
                    </td>
                    {matrixData.questions.map((question) => {
                      if (municipality.referencesStateCode || !municipality.statute) {
                        // Show empty cells for state code municipalities or when no {documentType} exists
                        return (
                          <td 
                            key={question.id} 
                            className="px-3 py-2 text-center border-r last:border-r-0 bg-gray-50 dark:bg-gray-900 w-[120px]"
                            data-testid={`cell-${municipality.id}-${question.id}-empty`}
                          >
                            <span className="text-xs text-gray-400">—</span>
                          </td>
                        );
                      }

                      const scoreData = municipality.scores[question.id];
                      const score = scoreData?.score || 0;
                      const confidence = scoreData?.confidence || 0;
                      
                      return (
                        <td 
                          key={question.id} 
                          onClick={() => setSelectedCell({
                            municipality: municipality.displayName,
                            question: question.question,
                            score: score,
                            confidence: confidence,
                            answer: scoreData?.answer || `Not specified in the ${documentType}.`,
                            sourceRefs: scoreData?.sourceRefs || [],
                            analyzedAt: scoreData?.analyzedAt,
                            lastUpdated: municipality.lastUpdated
                          })}
                          className={`px-3 py-2 text-center border-r last:border-r-0 cursor-pointer transition-colors hover:opacity-80 w-[120px] ${getMatrixScoreColor(score)}`}
                          data-testid={`cell-${municipality.id}-${question.id}`}
                        >
                          <div className="flex justify-center">
                            <ScoreVisualization 
                              score={score}
                              maxScore={1}
                              className="scale-75"
                            />
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

        {/* Summary Stats */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-muted/30 rounded-lg p-4">
            <h3 className="font-medium text-sm text-muted-foreground">Total Municipalities</h3>
            <p className="text-2xl font-bold" data-testid="text-total-municipalities">
              {matrixData.municipalities.length}
            </p>
          </div>
          <div className="bg-muted/30 rounded-lg p-4">
            <h3 className="font-medium text-sm text-muted-foreground">Total Questions</h3>
            <p className="text-2xl font-bold" data-testid="text-total-questions">
              {matrixData.questions.length}
            </p>
          </div>
          <div className="bg-muted/30 rounded-lg p-4">
            <h3 className="font-medium text-sm text-muted-foreground">Total Analyses</h3>
            <p className="text-2xl font-bold" data-testid="text-total-analyses">
              {matrixData.municipalities.length * matrixData.questions.length}
            </p>
          </div>
        </div>

        {/* Cell Details Popup */}
        {selectedCell && (
          <CellPopup
            municipality={selectedCell.municipality}
            question={selectedCell.question}
            score={selectedCell.score}
            confidence={selectedCell.confidence}
            answer={selectedCell.answer}
            sourceRefs={selectedCell.sourceRefs}
            analyzedAt={selectedCell.analyzedAt}
            lastUpdated={selectedCell.lastUpdated}
            open={!!selectedCell}
            onOpenChange={(open) => !open && setSelectedCell(null)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}