import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ordinizer/client/ui";
import { Badge } from "@ordinizer/client/ui";
import { Separator } from "@ordinizer/client/ui";
import { ScrollArea } from "@ordinizer/client/ui";
import { Button } from "@ordinizer/client/ui";
import { apiPath } from "../lib/apiConfig";
import { ArrowLeft, ExternalLink, Database } from 'lucide-react';
import { useBasePath } from '../contexts/BasePathContext';

interface Question {
  id: number;
  category: string;
  question: string;
  scoreInstructions: string;
  weight: number;
  order: number;
}

interface DomainWithQuestions {
  id: string;
  name: string;
  displayName: string;
  questions: Question[];
  questionCount: number;
  totalWeight: number;
}

interface DataSource {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: string;
  url: string;
  domains: string[];
  municipalities: number;
  status: string;
}

export default function AdminDomains() {
  const { realmid } = useParams<{ realmid: string }>();
  const { buildPath } = useBasePath();
  
  const { data: domains, isLoading, error } = useQuery<DomainWithQuestions[]>({
    queryKey: [apiPath(`realms/${realmid}/domains/questions`)],
    enabled: !!realmid
  });

  const { data: datasources } = useQuery<{ sources: DataSource[] }>({
    queryKey: [apiPath('datasources')],
  });

  // Get realm info
  const { data: realms } = useQuery({
    queryKey: [apiPath('realms')],
    staleTime: 1000 * 60 * 60 // Cache for 1 hour
  });

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
              Configure questions and scoring weights for {currentRealm?.entityType || 'entities'} in this realm
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
                  {domain.questions.map((question) => (
                    <li key={question.id} data-testid={`question-${domain.id}-${question.id}`} className="leading-relaxed">
                      <span className="font-semibold">{question.category}:</span> 
                      <div>
                        {question.question}
                        {question.weight > 1 && (
                          <span className="ml-2 text-xs text-muted-foreground font-medium" data-testid={`question-weight-${domain.id}-${question.id}`}>
                            (x{question.weight})
                          </span>
                        )}
                      </div>
                      {question.scoreInstructions && (
                        <div className="text-xs text-muted-foreground mt-1 italic">
                          {question.scoreInstructions}
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