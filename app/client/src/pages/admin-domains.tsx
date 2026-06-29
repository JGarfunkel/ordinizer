import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from 'wouter';
import { useRealmId } from '../hooks/useRealmId';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui";
import { Badge } from "../ui";
import { Button } from "../ui";
import { apiPath } from "../lib/apiConfig";
import { ArrowLeft, ExternalLink, Database } from 'lucide-react';
import { useBasePath } from '../contexts/BasePathContext';
import type { Question, QuestionWithScore, DomainWithQuestions, DataSource } from '@civillyengaged/ordinizer-core';
import { useRealms } from '../hooks/useRealms';

type DomainQuestion = Question | QuestionWithScore;

function isQuestionWithScore(q: DomainQuestion): q is QuestionWithScore {
  return 'answer' in q && 'score' in q;
}

export default function AdminDomains() {
  const realmid = useRealmId();
  const { buildPath } = useBasePath();
  const search = useSearch();
  const entityId = new URLSearchParams(search).get('entity') ?? undefined;

  const apiUrl = entityId
    ? apiPath(`realms/${realmid}/domains/questions?entity=${encodeURIComponent(entityId)}`)
    : apiPath(`realms/${realmid}/domains/questions`);

  const { data: domains, isLoading, error } = useQuery<DomainWithQuestions[]>({
    queryKey: [apiPath(`realms/${realmid}/domains/questions`), entityId],
    queryFn: () => fetch(apiUrl).then(r => r.json()),
    enabled: !!realmid
  });

  const { data: datasources } = useQuery<{ sources: DataSource[] }>({
    queryKey: [apiPath('datasources')],
  });

  // Get realm info
  const { data: realms } = useRealms();

  const currentRealm = realms?.find((r: any) => r.id === realmid);

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-lg">Loading domains...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-lg text-red-600">Error loading domains</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6">
      <div className="mb-8">
        {/* Header with navigation */}
        <div className="flex items-center gap-4 mb-4">
          <Link href={buildPath(`/realm/${realmid}`)}>
            <Button variant="outline" size="sm" className="flex items-center gap-2">
              <ArrowLeft className="w-4 h-4" />
              Back to Map
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold">Questions & Scoring - {currentRealm?.name || realmid}</h1>
            <p className="text-muted-foreground">
              {entityId
                ? `Answers and scores for: ${entityId}`
                : `Configure questions and scoring weights for ${currentRealm?.entityType || 'entities'} in this realm`}
            </p>
          </div>
        </div>
        
        {/* Data Sources Section */}
        {datasources && datasources.sources.length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3">Associated Data Sources</h2>
            <div className="flex flex-wrap gap-3">
              {datasources.sources.map((source) => (
                <div key={source.id} className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    className="h-8"
                    data-testid={`source-${source.id}`}
                  >
                    <a href={`/data/sourcedata?source=${source.id}`} className="flex items-center gap-2">
                      <Database className="w-4 h-4" />
                      {source.displayName}
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    asChild
                    className="h-8 w-8 p-0"
                    data-testid={`source-external-${source.id}`}
                  >
                    <a href={source.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-6">
        {domains?.map((domain) => (
          <Card key={domain.id} className="w-full" data-testid={`domain-card-${domain.id}`}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-xl" data-testid={`domain-name-${domain.id}`}>
                    {domain.displayName}
                  </CardTitle>
                  <CardDescription className="text-sm text-muted-foreground">
                    ID: {domain.id}
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Badge variant="secondary" data-testid={`question-count-${domain.id}`}>
                    {domain.questionCount} questions
                  </Badge>
                  <Badge variant="outline" data-testid={`total-weight-${domain.id}`}>
                    Total weight: {domain.totalWeight}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            
            <CardContent>
              {domain.questions.length > 0 ? (
                <ol className="list-decimal list-inside space-y-3 text-sm">
                  {(domain.questions as DomainQuestion[]).map((question) => (
                    <li key={question.id} data-testid={`question-${domain.id}-${question.id}`} className="leading-relaxed">
                      {'category' in question && <span className="font-bold">{question.category}:</span>}
                      <span className="font-bold ml-1">
                        {question.question}
                        {question.weight > 1 && (
                          <span className="ml-2 text-muted-foreground font-medium" data-testid={`question-weight-${domain.id}-${question.id}`}>
                            (x{question.weight})
                          </span>
                        )}
                      </span>
                      {'scoreInstructions' in question && question.scoreInstructions && (
                        <div className="text-xs text-muted-foreground mt-1 italic">
                          {question.scoreInstructions}
                        </div>
                      )}
                      {isQuestionWithScore(question) && question.answer && (
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-muted-foreground italic">{question.answer}</span>
                          <Badge variant="outline" className="text-xs">
                            {Math.round(question.score * 100)}%
                          </Badge>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="text-center py-4 text-muted-foreground">
                  No questions found for this domain
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {domains?.length === 0 && (
        <div className="text-center py-12">
          <div className="text-lg text-muted-foreground">No domains found</div>
        </div>
      )}
    </div>
  );
}