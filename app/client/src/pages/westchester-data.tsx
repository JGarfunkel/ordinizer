import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from "@ordinizer/client/ui";
import { Skeleton } from "@ordinizer/client/ui";
import { Badge } from "@ordinizer/client/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ordinizer/client/ui";
import { Button } from "@ordinizer/client/ui";
import { 
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@ordinizer/client/ui";
import { ExternalLink, Calendar, FileText, ArrowLeft, Database } from 'lucide-react';
import { apiPath } from "../lib/apiConfig";
import { Link } from 'wouter';
import { useBasePath } from '../contexts/BasePathContext';

interface DomainData {
  sourceUrl: string | null;
  lastDownloadTime: string | null;
  wordCount: number;
  characterCount: number;
  isArticleBased: boolean;
  usesStateCode: boolean;
  referencesStateFile?: boolean;
  articleCount?: number;
  sourceUrls?: Array<{ title: string; url: string }>;
}

interface Municipality {
  id: string;
  name: string;
  displayName: string;
  domains: { [domain: string]: DomainData };
}

interface WestchesterData {
  generated: string;
  totalMunicipalities: number;
  availableDomains: string[];
  summary: Municipality[];
}

interface DataSource {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: string;
  url: string;
  dataFile: string;
  lastUpdated: string;
  domains: string[];
  municipalities: number;
  status: string;
}

interface DataSourcesResponse {
  sources: DataSource[];
}

function formatDate(dateString: string | null): string {
  if (!dateString) return 'Never';
  try {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return 'Invalid date';
  }
}

function formatWordCount(count: number): string {
  if (count === 0) return '—';
  if (count < 1000) return count.toString();
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function DataCell({ data, domain }: { data: DomainData | undefined; domain: string }) {
  if (!data || !data.sourceUrl) {
    return (
      <td className="px-3 py-2 text-center text-gray-400 dark:text-gray-600 border-r border-gray-200 dark:border-gray-700">
        —
      </td>
    );
  }

  const cellContent = (
    <div className="flex flex-col items-center gap-1">
      <span className="font-medium text-blue-600 dark:text-blue-400">
        {formatWordCount(data.wordCount)}
      </span>
      {data.usesStateCode && (
        <Badge variant="secondary" className="text-xs">
          State
        </Badge>
      )}
      {data.isArticleBased && (
        <Badge variant="outline" className="text-xs">
          {data.articleCount}A
        </Badge>
      )}
    </div>
  );

  const tooltipContent = (
    <div className="text-sm space-y-1">
      <div className="flex items-center gap-2">
        <Calendar className="w-4 h-4" />
        <span>Updated: {formatDate(data.lastDownloadTime)}</span>
      </div>
      <div className="flex items-center gap-2">
        <FileText className="w-4 h-4" />
        <span>{data.wordCount.toLocaleString()} words</span>
      </div>
      {data.characterCount > 0 && (
        <div className="text-xs text-gray-300">
          {data.characterCount.toLocaleString()} characters
        </div>
      )}
      {data.usesStateCode && (
        <div className="text-xs text-blue-300">
          Uses NY State Code
        </div>
      )}
      {data.isArticleBased && (
        <div className="text-xs text-green-300">
          Multi-article statute ({data.articleCount} articles)
        </div>
      )}
    </div>
  );

  return (
    <td className="px-3 py-2 text-center border-r border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={data.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block group transition-colors hover:bg-blue-50 dark:hover:bg-blue-950 rounded p-1"
            >
              {cellContent}
              <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity mx-auto mt-1 text-gray-400" />
            </a>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            {tooltipContent}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </td>
  );
}

export default function WestchesterDataPage() {
  const [selectedSourceId, setSelectedSourceId] = useState<string>('');
  const { buildPath } = useBasePath();

  // Fetch available data sources
  const { data: dataSources, isLoading: sourcesLoading } = useQuery<DataSourcesResponse>({
    queryKey: [apiPath('datasources')],
  });

  // Set default source ID from the first available source
  useEffect(() => {
    if (dataSources?.sources && dataSources.sources.length > 0 && !selectedSourceId) {
      setSelectedSourceId(dataSources.sources[0].id);
    }
  }, [dataSources, selectedSourceId]);

  // Fetch data for selected source
  const { data, isLoading, error } = useQuery<WestchesterData>({
    queryKey: [apiPath('sourcedata'), selectedSourceId],
    queryFn: async () => {
      const response = await fetch(apiPath(`sourcedata?source=${selectedSourceId}`));
      if (!response.ok) throw new Error('Failed to fetch source data');
      const result = await response.json();
      return result.data;
    },
    enabled: !!selectedSourceId,
  });

  if (isLoading) {
    return (
      <div className="container mx-auto p-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-8 w-96" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[...Array(10)].map((_, i) => (
                <div key={i} className="flex gap-4">
                  <Skeleton className="h-6 w-32" />
                  {[...Array(9)].map((_, j) => (
                    <Skeleton key={j} className="h-6 w-16" />
                  ))}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-red-600">Error Loading Data</CardTitle>
          </CardHeader>
          <CardContent>
            <p>Failed to load Westchester environmental data. Please try again later.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const totalWords = data.summary.reduce((total, municipality) => {
    return total + Object.values(municipality.domains).reduce((sum, domain) => sum + domain.wordCount, 0);
  }, 0);

  const domainStats = data.availableDomains.map(domain => ({
    domain,
    count: data.summary.filter(m => m.domains[domain]).length
  }));

  return (
    <div className="container mx-auto p-4">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-4 mb-4">
          <Link href={buildPath("/")}>
            <Button variant="ghost" size="sm" className="flex items-center gap-2" data-testid="button-back-home">
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Button>
          </Link>
        </div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2 flex items-center gap-3">
          <Database className="w-8 h-8 text-blue-600" />
          Data Sources
        </h1>
        <p className="text-gray-600">
          Explore the underlying data sources that power Ordinizer's municipal statute analysis.
        </p>
      </div>

      {/* Source Selection */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">Select Data Source</CardTitle>
        </CardHeader>
        <CardContent>
          {sourcesLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select value={selectedSourceId} onValueChange={setSelectedSourceId}>
              <SelectTrigger data-testid="select-data-source">
                <SelectValue placeholder="Choose a data source..." />
              </SelectTrigger>
              <SelectContent>
                {dataSources?.sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-bold">
            {dataSources?.sources.find(s => s.id === selectedSourceId)?.displayName || 'Data Source'}
          </CardTitle>
          <div className="flex flex-wrap gap-4 text-sm text-gray-600 dark:text-gray-400">
            <span>{data.totalMunicipalities} municipalities</span>
            <span>{data.availableDomains.length} domains</span>
            <span>{totalWords.toLocaleString()} total words</span>
            <span>Updated: {formatDate(data.generated)}</span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-auto max-h-[80vh] border rounded-lg">
            <table className="w-full border-collapse">
              <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0 z-10">
                <tr>
                  <th className="sticky left-0 z-20 bg-gray-50 dark:bg-gray-800 px-4 py-3 text-left font-semibold border-r border-gray-200 dark:border-gray-700 min-w-[200px]">
                    Municipality
                  </th>
                  {data.availableDomains.map((domain) => (
                    <th
                      key={domain}
                      className="px-3 py-3 text-center font-semibold border-r border-gray-200 dark:border-gray-700 min-w-[100px] whitespace-nowrap"
                    >
                      <div className="flex flex-col items-center gap-1">
                        <span>{domain}</span>
                        <Badge variant="outline" className="text-xs">
                          {domainStats.find(s => s.domain === domain)?.count || 0}
                        </Badge>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.summary.map((municipality) => (
                  <tr
                    key={municipality.id}
                    className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  >
                    <td className="sticky left-0 z-10 bg-white dark:bg-gray-900 px-4 py-3 font-medium border-r border-gray-200 dark:border-gray-700">
                      <div>
                        <div className="font-semibold">{municipality.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {municipality.displayName.split(' - ')[1]}
                        </div>
                      </div>
                    </td>
                    {data.availableDomains.map((domain) => (
                      <DataCell
                        key={`${municipality.id}-${domain}`}
                        data={municipality.domains[domain]}
                        domain={domain}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Domain Statistics */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">Domain Coverage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-4">
            {domainStats.map(({ domain, count }) => (
              <div key={domain} className="text-center">
                <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                  {count}
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-400 truncate">
                  {domain}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}