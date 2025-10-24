import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch, useParams, Link } from "wouter";
import { Card, CardContent } from "@ordinizer/client/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ordinizer/client/ui";
import { Button } from "@ordinizer/client/ui";
import { Skeleton } from "@ordinizer/client/ui";
import { Input } from "@ordinizer/client/ui";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@ordinizer/client/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@ordinizer/client/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@ordinizer/client/ui";
import { AlertCircle, Scale, MapPin, FolderOpen, ArrowLeft, X, HelpCircle, RotateCcw, Check, ChevronsUpDown, FileText, ExternalLink, Ban, Grid, Database } from "lucide-react";
import { apiPath } from "../lib/apiConfig";
import MunicipalityMap from "../components/MunicipalityMap";
import ScoreVisualization from "../components/ScoreVisualization";
import { queryClient } from "../lib/queryClient";
import { getDefaultRealmId } from '../lib/realmUtils';
import { useBasePath } from "../contexts/BasePathContext";
import type { Municipality, MunicipalityDomain } from "@ordinizer/core";

interface QuestionWithAnswer {
  id: number; // Fixed: should be number to match scoring data
  title: string;
  text: string;
  order: string;
  answer: string;
  sourceReference: string | null;
  lastUpdated: Date | null;
  relevantSections?: string[];
  gap?: string; // Added: gap analysis for scores < 1.0
  resolvedSectionUrls?: Array<{sectionNumber: string, sectionUrl?: string}>; // Added: pre-resolved URLs
}

interface BestPractice {
  questionId: number;
  question: string;
  bestAnswer: string;
  bestScore: number;
  bestMunicipality: {
    id: string;
    displayName: string;
  };
  quantitativeHighlights?: string[];
  supportingExamples: Array<{
    municipality: {
      id: string;
      displayName: string;
    };
    score: number;
    confidence: number;
  }>;

  commonGaps: string[];
}

interface MetaAnalysisData {
  domain: {
    id: string;
    displayName: string;
    description?: string;
  };
  analysisDate: string;
  totalMunicipalitiesAnalyzed: number;
  averageScore: number;
  highestScoringMunicipality: {
    id: string;
    displayName: string;
    score: number;
  };
  bestPractices: BestPractice[];
  overallRecommendations: {
    commonWeaknesses: string[];
    keyImprovements: string[];
    modelMunicipalities: string[];
  };
  version: string;
}

interface AnalysisResponse {
  municipality: Municipality;
  domain: MunicipalityDomain;
  statute: any;
  questions: QuestionWithAnswer[];
  alignmentSuggestions?: {
    strengths?: string[];
    improvements?: string[];
    recommendations?: string[];
    bestPractices?: string[];
  };
}

// Simplified Statute Link Component - purely presentational
const StatuteLink = ({ 
  href,
  fallbackHref,
  municipalityId,
  domainId,
  children 
}: { 
  href?: string;
  fallbackHref?: string;
  municipalityId?: string;
  domainId?: string;
  children: React.ReactNode;
}) => {
  // Simple URL resolution with fallback chain
  const statuteUrl = href || 
                    fallbackHref || 
                    (domainId && municipalityId ? apiPath(`statute/${domainId}/${municipalityId}`) : '#');

  return (
    <a 
      href={statuteUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-blue-800 underline inline-flex items-center gap-1"
    >
      {children}
      <ExternalLink size={10} />
    </a>
  );
};

export default function Home() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = useParams();
  const { buildPath } = useBasePath();
  const [selectedMunicipalityId, setSelectedMunicipalityId] = useState<string>("");
  const [selectedDomainId, setSelectedDomainId] = useState<string>("");
  const [selectedRealmId, setSelectedRealmId] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<string>("current");
  const [showResults, setShowResults] = useState(false);
  const [showSidebarAnalysis, setShowSidebarAnalysis] = useState(false);
  const [municipalityComboOpen, setMunicipalityComboOpen] = useState(false);
  const [questionMunicipalitiesPopup, setQuestionMunicipalitiesPopup] = useState<{questionId: string; municipalities: any[]} | null>(null);
  const [municipalityAnswerPopup, setMunicipalityAnswerPopup] = useState<{questionId: number; municipalityId: string; answer: string; score: number; confidence: number} | null>(null);

  // Helper function to check if answer is "Not specified"
  const isNotSpecified = (answer: string): boolean => {
    const lowerAnswer = answer.toLowerCase();
    return lowerAnswer.includes('not specified') || 
           lowerAnswer.includes('no specific') || 
           lowerAnswer.includes('does not specify');
  };



  // Function to handle question mark click
  const handleQuestionMarkClick = async (questionId: string, domainId: string) => {
    try {
      const response = await fetch(apiPath(`question-municipalities/${domainId}/${questionId}`));
      if (response.ok) {
        const municipalities = await response.json();
        setQuestionMunicipalitiesPopup({ questionId, municipalities });
      }
    } catch (error) {
      console.error('Error fetching municipalities with answers:', error);
    }
  };

  // Function to handle municipality click in meta-analysis
  const handleMetaMunicipalityClick = async (questionId: number, municipalityId: string, domainId: string) => {
    try {
      const response = await fetch(apiPath(`analyses/${selectedRealmId}/${municipalityId}/${domainId}`));
      if (response.ok) {
        const analysisData = await response.json();
        const question = analysisData.questions.find((q: any) => q.id === questionId);
        if (question) {
          setMunicipalityAnswerPopup({
            questionId,
            municipalityId,
            answer: question.answer,
            score: question.score || 0,
            confidence: question.confidence || 0
          });
        }
      }
    } catch (error) {
      console.error('Error fetching municipality answer:', error);
    }
  };

  // Fetch realms
  const { data: realms, isLoading: realmsLoading } = useQuery<{id: string; name: string; displayName: string}[]>({
    queryKey: [apiPath('realms')],
  });

  // Get current realm info for terminology
  const currentRealm = realms?.find((r: any) => r.id === selectedRealmId);
  const isPolicy = false; // Default to false since type property doesn't exist
  const documentType = isPolicy ? 'policy' : 'statute';
  const documentTypeCapitalized = isPolicy ? 'Policy' : 'Statute';
  const entityType = 'Municipality'; // Default to Municipality since entityType doesn't exist

  // Fetch entities for current realm (municipalities, school districts, etc.)
  const { data: entities, isLoading: entitiesLoading } = useQuery<Municipality[]>({
    queryKey: [apiPath(`realms/${selectedRealmId}/entities`)],
    enabled: !!selectedRealmId,
  });

  // Use entities as municipalities for backward compatibility
  const municipalities = entities;
  const municipalitiesLoading = entitiesLoading;

  // Helper function to create municipality display name for URL
  const createMunicipalitySlug = (municipality: Municipality): string => {
    // Use the municipality ID directly since it's already in the correct format
    return municipality.id;
  };

  // Helper function to find municipality by slug
  const findMunicipalityBySlug = (slug: string, municipalities: Municipality[]): Municipality | undefined => {
    // Since slug is now the municipality ID, just find by exact ID match
    return municipalities.find(m => m.id === slug);
  };

  // Extract realm ID from route parameters first
  useEffect(() => {
    const realmIdFromRoute = params.realmid;
    if (realmIdFromRoute && realmIdFromRoute !== selectedRealmId) {
      console.log('🏛️ Setting realm ID from route:', realmIdFromRoute);
      setSelectedRealmId(realmIdFromRoute);
    } else if (!realmIdFromRoute && !selectedRealmId) {
      // Fallback to dynamically determined default realm
      console.log('🏛️ No realm in route, determining default dynamically');
      getDefaultRealmId().then(defaultRealmId => {
        if (defaultRealmId) {
          console.log('🏛️ Using default realm:', defaultRealmId);
          setSelectedRealmId(defaultRealmId);
        }
      }).catch(error => {
        console.warn('🏛️ Failed to get default realm:', error);
      });
    }
  }, [params.realmid]);

  // Parse both path parameters and query parameters
  useEffect(() => {
    console.log('🔄 URL Effect triggered:', { 
      params, 
      search, 
      selectedMunicipalityId, 
      selectedDomainId 
    });
    
    // Handle path-based routing (/realm/westchester-municipal-environmental/trees/NY-Ardsley or /realm/westchester-municipal-environmental/trees)
    if (params.realmid && params.domain) {
      const realmId = params.realmid;
      const domainId = params.domain;
      console.log('📍 Path-based routing - realm:', realmId, 'domain:', domainId, 'municipality:', params.municipality);
      
      // Set realm if different
      if (realmId !== selectedRealmId) {
        console.log('🔄 Setting realm from URL:', realmId);
        setSelectedRealmId(realmId);
      }
      
      // Set domain if different
      if (domainId !== selectedDomainId) {
        console.log('🔄 Setting domain:', domainId);
        setSelectedDomainId(domainId);
      }
      
      // Handle municipality if provided (/realm/westchester-municipal-environmental/trees/NY-Ardsley)
      if (params.municipality && municipalities) {
        const municipalitySlug = params.municipality;
        const municipality = findMunicipalityBySlug(municipalitySlug, municipalities);
        console.log('🏛️ Found municipality from slug:', municipalitySlug, '->', municipality?.displayName);
        
        if (municipality && municipality.id !== selectedMunicipalityId) {
          console.log('🔄 Setting municipality from URL:', municipality.id);
          setSelectedMunicipalityId(municipality.id);
          setSelectedVersion("current"); // Reset to current version when municipality changes
          setShowSidebarAnalysis(true); // Show analysis in sidebar, keep map visible
          setShowResults(false); // Always keep map visible
        }
      }
      // If only domain is provided (/realm/westchester-municipal-environmental/trees), don't show results yet - wait for municipality selection
      else if (!params.municipality) {
        console.log('📍 Domain-only path, clearing municipality and sidebar');
        // Clear municipality if it's set (avoid React warnings by using setTimeout)
        if (selectedMunicipalityId) {
          console.log('🧹 Clearing municipality from domain-only URL');
          setTimeout(() => setSelectedMunicipalityId(""), 0);
        }
        setShowResults(false);
        setShowSidebarAnalysis(false);
      }
      
      return;
    }
    
    // Handle query parameter routing (?municipality=id&domain=id)
    const urlParams = new URLSearchParams(search);
    const municipalityParam = urlParams.get('municipality');
    const domainParam = urlParams.get('domain');
    
    if (municipalityParam && municipalityParam !== selectedMunicipalityId) {
      setSelectedMunicipalityId(municipalityParam);
      setSelectedVersion("current"); // Reset to current version when municipality changes
    }
    if (domainParam && domainParam !== selectedDomainId) {
      setSelectedDomainId(domainParam);
      setSelectedVersion("current"); // Reset to current version when domain changes
    }
    if (municipalityParam && domainParam) {
      setShowSidebarAnalysis(true); // Show analysis in sidebar, keep map visible
      setShowResults(false); // Always keep map visible
    } else if (!municipalityParam && !domainParam && !params.domain && !params.municipality) {
      // Clear state when no parameters
      setSelectedMunicipalityId("");
      setSelectedDomainId("");
      setShowResults(false);
    }
  }, [search, params, municipalities, selectedDomainId, selectedMunicipalityId]);

  // Update URL when selections change - prefer path-based routing
  const updateURL = useCallback((municipalityId: string, domainId: string) => {
    // Don't wait for municipalities to load - use municipalityId directly to avoid race conditions
    if (municipalityId && domainId && selectedRealmId) {
      // Create slug from municipalityId directly (e.g., "NY-Bedford-Town" -> "NY-Bedford-Town")
      navigate(buildPath(`/realm/${selectedRealmId}/${domainId}/${municipalityId}`));
    } else if (domainId && selectedRealmId) {
      // Just domain selected, use domain path
      navigate(buildPath(`/realm/${selectedRealmId}/${domainId}`));
    } else if (municipalityId && selectedRealmId) {
      // Just municipality selected, use query params
      navigate(buildPath(`/realm/${selectedRealmId}?municipality=${municipalityId}`));
    } else if (selectedRealmId) {
      navigate(buildPath(`/realm/${selectedRealmId}`));
    }
  }, [navigate, selectedRealmId, buildPath]);

  // Get current realm configuration (already declared above)
  
  // Fetch all domains for the buttons (filtered by "show" property on server)
  const { data: allDomains, isLoading: allDomainsLoading } = useQuery<{id: string; name: string; displayName: string; description: string; show?: boolean}[]>({
    queryKey: [apiPath('realms'), selectedRealmId, 'domains'],
    enabled: !!selectedRealmId,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    onSuccess: (data) => {
      console.log('🏗️  Domains loaded for realm', selectedRealmId, ':', data?.map(d => d.displayName));
    },
    onError: (error) => {
      console.error('❌ Error loading domains for realm', selectedRealmId, ':', error);
    }
  });


  // Fetch domains for selected municipality
  const { data: availableDomains, isLoading: domainsLoading } = useQuery<MunicipalityDomain[]>({
    queryKey: [apiPath('realms'), selectedRealmId, 'jurisdictions', selectedMunicipalityId, 'domains'],
    enabled: !!selectedMunicipalityId && !!selectedRealmId
  });

  // Fetch domain summary data to determine if municipality uses state code
  const { data: domainSummary } = useQuery<Array<{municipalityId: string, grade: string | null, gradeColor: string | null, available: boolean, stateCodeApplies: boolean}>>({
    queryKey: [apiPath('domains'), selectedRealmId, selectedDomainId, 'summary'],
    enabled: !!selectedDomainId && !!selectedRealmId
  });

  // Fetch meta-analysis when domain is selected but no municipality
  const { data: metaAnalysisData, isLoading: metaLoading } = useQuery<MetaAnalysisData>({
    queryKey: [apiPath('domains'), selectedRealmId, selectedDomainId, 'meta-analysis'],
    enabled: !!selectedDomainId && !selectedMunicipalityId && !!selectedRealmId
  });

  // Fetch analysis data
  // Check if selected municipality uses state code
  const selectedMunicipalitySummary = domainSummary?.find(s => s.municipalityId === selectedMunicipalityId);
  const usesStateCode = selectedMunicipalitySummary?.stateCodeApplies || false;
  
  // Determine which municipality ID to use for analysis fetch
  const analysisTargetMunicipalityId = usesStateCode ? 'NY-State' : selectedMunicipalityId;

  // Fetch available analysis versions
  const { data: versionsData } = useQuery<{versions: Array<{version: string; filename: string; displayName: string; timestamp: string; isCurrent: boolean}>}>({
    queryKey: [apiPath('analyses'), selectedRealmId, analysisTargetMunicipalityId, selectedDomainId, 'versions'],
    enabled: !!selectedMunicipalityId && !!selectedDomainId && !!selectedRealmId
  });

  const { data: analysisData, isLoading: analysisLoading, error: analysisError } = useQuery<AnalysisResponse>({
    queryKey: [apiPath('analyses'), selectedRealmId, analysisTargetMunicipalityId, selectedDomainId, selectedVersion],
    queryFn: async () => {
      const url = apiPath(`analyses/${selectedRealmId}/${analysisTargetMunicipalityId}/${selectedDomainId}${selectedVersion !== 'current' ? `?version=${encodeURIComponent(selectedVersion)}` : ''}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch analysis');
      return response.json();
    },
    enabled: (showResults || showSidebarAnalysis) && !!selectedMunicipalityId && !!selectedDomainId && !!selectedRealmId
  });

  // Fetch environmental protection scores for the selected municipality
  const { data: scoreData } = useQuery<{
    municipalityId: string;
    domainId: string;
    questions: Array<{
      id: number;
      question: string;
      answer: string;
      score: number;
      weight: number;
      weightedScore: number;
      maxWeightedScore: number;
      confidence: number;
    }>;
    totalWeightedScore: number;
    totalPossibleWeight: number;
    overallScore: number;
    scoreColor: string;
  }>({
    queryKey: [apiPath('scores'), selectedRealmId, selectedMunicipalityId, selectedDomainId],
    enabled: !usesStateCode && !!selectedMunicipalityId && !!selectedDomainId && !!selectedRealmId,
    staleTime: 1000 * 60 * 5 // Cache for 5 minutes
  });

  // Add effect to log analysis data changes
  useEffect(() => {
    if (analysisData && selectedDomainId && selectedMunicipalityId) {
      console.log('Analysis data received:', {
        municipality: analysisData?.municipality?.displayName,
        domain: analysisData?.domain?.displayName,
        questionsCount: analysisData?.questions?.length || 0,
        hasAlignmentSuggestions: !!analysisData?.alignmentSuggestions,
        statuteLength: analysisData?.statute?.content?.length || 0,
        showSidebarAnalysis,
        showResults
      });
    }
    if (analysisError) {
      console.error('Analysis data fetch failed:', analysisError);
    }
  }, [analysisData, analysisError, showSidebarAnalysis, showResults, selectedDomainId, selectedMunicipalityId]);

  const selectedMunicipality = municipalities?.find(m => m.id === selectedMunicipalityId);
  const selectedDomain = availableDomains?.find(d => d.id === selectedDomainId);

  // Function to get color based on grade
  const getGradeColor = (grade: string | null | undefined, available: boolean) => {
    if (!available) {
      return "bg-gray-200 text-gray-500 cursor-not-allowed";
    }
    switch (grade?.toUpperCase()) {
      case 'A': return "bg-green-500 text-white hover:bg-green-600";
      case 'B': return "bg-blue-500 text-white hover:bg-blue-600";
      case 'C': return "bg-yellow-500 text-white hover:bg-yellow-600";
      case 'D': return "bg-orange-500 text-white hover:bg-orange-600";
      case 'F': return "bg-red-500 text-white hover:bg-red-600";
      default: return "bg-civic-blue text-white hover:bg-civic-blue-dark";
    }
  };

  const handleMunicipalityChange = (value: string) => {
    console.log('🏛️  Dropdown municipality selection:', value);
    const municipality = municipalities?.find(m => m.id === value);
    console.log('🏛️  Found municipality object:', municipality?.displayName, 'ID:', municipality?.id);
    
    setSelectedMunicipalityId(value);
    // Don't clear domain selection when changing municipality
    // If domain is already selected, show results in right pane, don't navigate
    if (selectedDomainId) {
      setShowSidebarAnalysis(true);
      // Update URL for deep linking but don't navigate
      if (municipality) {
        const slug = createMunicipalitySlug(municipality);
        console.log('🏛️  Created slug for URL:', slug);
        window.history.pushState({}, '', `/realm/${selectedRealmId}/${selectedDomainId}/${slug}`);
      }
    } else {
      setShowSidebarAnalysis(false);
      updateURL(value, "");
    }
  };

  const handleRealmChange = (realmId: string) => {
    console.log('🏛️  === REALM CHANGE START ===');
    console.log('🏛️  Changing from', selectedRealmId, 'to', realmId);
    console.log('🏛️  Current allDomains before change:', allDomains?.map(d => d.displayName));
    
    // Store old realm ID before updating
    const oldRealmId = selectedRealmId;
    
    // Completely clear all realm-related queries
    console.log('🏛️  Removing ALL realm queries from cache');
    queryClient.removeQueries({ queryKey: [apiPath('realms')] });
    queryClient.clear(); // Nuclear option - clear entire cache
    
    console.log('🏛️  Setting selectedRealmId to:', realmId);
    setSelectedRealmId(realmId);
    
    // Reset domain and municipality when realm changes since different realms have different domains/entities
    if (selectedDomainId) {
      console.log('🔄 Clearing domain selection due to realm change');
      setSelectedDomainId("");
    }
    if (selectedMunicipalityId) {
      console.log('🔄 Clearing municipality selection due to realm change');
      setSelectedMunicipalityId("");
    }
    
    // Clear UI state
    setShowSidebarAnalysis(false);
    setShowResults(false);
    
    // Navigate to the new realm route
    navigate(buildPath(`/realm/${realmId}`));
    console.log('🏛️  === REALM CHANGE END ===');
  };

  const handleDomainChange = (domainId: string, available?: boolean) => {
    console.log('Domain change - domainId:', domainId, 'available:', available, 'current selectedDomainId:', selectedDomainId);
    
    // For municipalities with loaded domains, check availability
    if (selectedMunicipalityId && available !== undefined && !available) return;
    
    // If clicking the same domain, unselect it
    if (selectedDomainId === domainId) {
      console.log('Unselecting domain:', domainId);
      setSelectedDomainId("");
      setShowSidebarAnalysis(false);
      updateURL(selectedMunicipalityId, "");
    } else {
      // Select new domain
      console.log('Selecting new domain:', domainId);
      setSelectedDomainId(domainId);
      
      // Show results in sidebar if both municipality and domain are selected
      if (selectedMunicipalityId) {
        console.log('Municipality already selected, showing sidebar analysis');
        setShowSidebarAnalysis(true);
        setShowResults(false); // Ensure we stay in the main selection interface
        updateURL(selectedMunicipalityId, domainId);
      } else {
        // If no municipality selected, navigate to domain-only path
        console.log('No municipality selected, navigating to domain path');
        navigate(buildPath(`/realm/${selectedRealmId}/${domainId}`));
      }
    }
  };

  // Map click handler - clean state updates without timeout issues
  const handleMapMunicipalityClick = useCallback((municipalityId: string) => {
    console.log('Map click - municipality:', municipalityId);
    
    // Always set the municipality
    setSelectedMunicipalityId(municipalityId);
    
    // Check current domain state and update sidebar accordingly
    setSelectedDomainId(currentDomainId => {
      if (currentDomainId) {
        console.log('Domain is selected, showing analysis in sidebar for domain:', currentDomainId);
        
        // Show sidebar when domain is selected
        setShowSidebarAnalysis(true);
        
        // Update URL for deep linking
        const municipality = municipalities?.find(m => m.id === municipalityId);
        if (municipality) {
          const slug = createMunicipalitySlug(municipality);
          updateURL(municipalityId, currentDomainId);
        }
      } else {
        console.log('No domain selected, staying in selection mode');
        
        // Hide sidebar when no domain is selected
        setShowSidebarAnalysis(false);
        
        // Update URL with municipality only
        updateURL(municipalityId, "");
      }
      
      return currentDomainId; // Don't change domain selection
    });
    
    setShowResults(false); // Always stay in selection interface
  }, [municipalities, createMunicipalitySlug, updateURL]);

  return (
    <div className="min-h-screen bg-civic-bg">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-civic-blue rounded-lg flex items-center justify-center">
                <Scale className="text-white text-lg" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-gray-900">Ordinizer</h1>
                <p className="text-sm text-civic-gray-light">{entityType} {documentTypeCapitalized} Comparison</p>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              {/* Realm Selector */}
              <div className="flex items-center space-x-2">
                <Select value={selectedRealmId} onValueChange={handleRealmChange}>
                  <SelectTrigger className="w-96 h-8 text-sm border-gray-300" data-testid="select-realm">
                    <SelectValue placeholder="Select realm..." />
                  </SelectTrigger>
                  <SelectContent>
                    {realms?.map((realm: any) => (
                      <SelectItem key={realm.id} value={realm.id} data-testid={`realm-${realm.id}`}>
                        {realm.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <a 
                href={`/realm/${selectedRealmId}/matrix`}
                className="text-civic-gray-light hover:text-gray-900 transition-colors font-medium flex items-center gap-1"
                title="View complete analysis matrix for all municipalities and domains"
              >
                <Grid className="w-4 h-4" />
                Matrix
              </a>
              <a 
                href="/faq" 
                className="text-civic-gray-light hover:text-gray-900 transition-colors font-medium"
              >
                FAQ
              </a>
              <button className="text-civic-gray-light hover:text-gray-900 transition-colors">
                <AlertCircle className="text-lg" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Single Interface */}
        {!showResults ? (
          <div className="space-y-6">
            {/* Municipality Selection */}
            <div className="flex items-center gap-2 relative z-10">
              <Popover open={municipalityComboOpen} onOpenChange={setMunicipalityComboOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={municipalityComboOpen}
                    className="w-1/2 justify-between"
                  >
                    {selectedMunicipalityId
                      ? municipalities?.find((m) => m.id === selectedMunicipalityId)?.displayName
                      : `Choose a ${currentRealm?.entityType === 'school-districts' ? 'school district' : 'municipality'}...`}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" style={{zIndex: 9999}}>
                  <Command>
                    <CommandInput placeholder={`Search ${currentRealm?.entityType === 'school-districts' ? 'school districts' : 'municipalities'}...`} />
                    <CommandEmpty>No {currentRealm?.entityType === 'school-districts' ? 'school district' : 'municipality'} found.</CommandEmpty>
                    <CommandGroup>
                      <CommandList>
                        {municipalities?.map((municipality) => (
                          <CommandItem
                            key={municipality.id}
                            value={`${municipality.id} ${municipality.displayName}`}
                            onSelect={() => {
                              handleMunicipalityChange(municipality.id);
                              setMunicipalityComboOpen(false);
                            }}
                          >
                            <Check
                              className={`mr-2 h-4 w-4 ${
                                selectedMunicipalityId === municipality.id ? "opacity-100" : "opacity-0"
                              }`}
                            />
                            {municipality.displayName}
                          </CommandItem>
                        ))}
                      </CommandList>
                    </CommandGroup>
                  </Command>
                </PopoverContent>
              </Popover>
              {(selectedMunicipalityId || selectedDomainId) && (
                <div className="flex gap-1">
                  {/* Clear Municipality Button */}
                  {selectedMunicipalityId && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        console.log('🧹 Clearing selected municipality...');
                        console.log('🧹 Current state before clear:', {
                          selectedMunicipalityId,
                          selectedDomainId,
                          currentURL: window.location.pathname
                        });
                        
                        // Navigate first, then clear state (preserve realm)
                        const newPath = selectedDomainId ? `/realm/${selectedRealmId}/${selectedDomainId}` : `/realm/${selectedRealmId}`;
                        console.log('🧹 Navigating to:', newPath);
                        navigate(buildPath(newPath));
                        
                        // Clear state after navigation to prevent race condition
                        setTimeout(() => {
                          console.log('🧹 Clearing state after navigation...');
                          setSelectedMunicipalityId("");
                          setShowResults(false);
                          setShowSidebarAnalysis(false);
                          setMunicipalityComboOpen(false);
                        }, 50);
                      }}
                      className="text-gray-600 hover:text-gray-900"
                      title="Clear selected municipality"
                    >
                      <Ban size={14} />
                    </Button>
                  )}
                  
                  {/* Refresh Cache Button */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // Invalidate all relevant caches to force fresh data fetch
                      queryClient.invalidateQueries({ queryKey: [apiPath('municipalities')] });
                      queryClient.invalidateQueries({ queryKey: [apiPath('domains')] });
                      queryClient.invalidateQueries({ queryKey: [apiPath('westchester-boundaries')] });
                      if (selectedMunicipalityId && selectedDomainId) {
                        queryClient.invalidateQueries({ queryKey: [apiPath('analyses'), selectedMunicipalityId, selectedDomainId] });
                        queryClient.invalidateQueries({ queryKey: [apiPath('municipalities'), selectedMunicipalityId, 'domains'] });
                      }
                      if (selectedDomainId) {
                        queryClient.invalidateQueries({ queryKey: [apiPath('domains'), selectedDomainId, 'summary'] });
                      }
                    }}
                    className="text-gray-600 hover:text-gray-900"
                    title="Refresh data from server"
                  >
                    <RotateCcw size={14} />
                  </Button>
                  
                  {/* Reset All Button */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedMunicipalityId("");
                      setSelectedDomainId("");
                      setShowResults(false);
                      setShowSidebarAnalysis(false);
                      navigate(buildPath(`/realm/${selectedRealmId}`));
                    }}
                    className="text-gray-600 hover:text-gray-900"
                    title="Reset all selections"
                  >
                    <X size={14} />
                  </Button>
                </div>
              )}
            </div>

            {/* Domain Selection - Always Visible */}
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {domainsLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-32 rounded-full" />
                  ))
                ) : (
                  (() => {
                    console.log('🏗️  Rendering domain buttons. Current state:', {
                      selectedRealmId,
                      allDomainsCount: allDomains?.length || 0,
                      allDomains: allDomains?.map(d => ({ id: d.id, name: d.displayName })) || [],
                      allDomainsLoading,
                      selectedDomainId,
                      selectedMunicipalityId
                    });
                    
                    // Don't render anything while loading new domains for a different realm
                    if (allDomainsLoading) {
                      console.log('⏳ Domains are loading, showing skeletons');
                      return Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-10 w-32 rounded-full" />
                      ));
                    }
                    
                    if (!allDomains || allDomains.length === 0) {
                      console.log('⚠️  No domains to render!');
                      return <div className="text-gray-500">No domains available</div>;
                    }
                    
                    return allDomains.map((domain) => {
                      const domainId = domain.id;
                      // Find domain data if municipality is selected
                      const domainData = availableDomains?.find(d => d.id === domainId);
                      const isAvailable = !selectedMunicipalityId || domainData?.available !== false;
                      const grade = domainData?.grade;
                      
                      
                      return (
                        <button
                          key={domainId}
                          onClick={() => handleDomainChange(domainId, isAvailable)}
                          disabled={Boolean(selectedMunicipalityId && !isAvailable)}
                          className={`
                            px-4 py-2 rounded-full text-sm font-medium transition-all duration-200
                            ${selectedDomainId === domainId 
                              ? 'bg-civic-blue text-white shadow-lg ring-2 ring-civic-blue ring-offset-2' 
                              : ''
                            }
                            ${isAvailable && selectedDomainId !== domainId && selectedMunicipalityId
                              ? 'ring-1 ring-civic-blue/50 bg-civic-blue/5'
                              : ''
                            }
                            ${selectedDomainId !== domainId ? getGradeColor(grade, isAvailable) : ''}
                            ${selectedMunicipalityId && !isAvailable ? 'opacity-60' : ''}
                            ${!selectedMunicipalityId && selectedDomainId !== domainId ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : ''}
                          `}
                          title={
                            selectedMunicipalityId && !isAvailable
                              ? `No ${documentType} available for this domain`
                              : grade 
                                ? `Grade: ${grade.toUpperCase()}`
                                : selectedMunicipalityId 
                                  ? 'Available'
                                  : domain.description || `${domain.displayName} regulations`
                          }
                        >
                          {domain.displayName}
                          {grade && <span className="ml-1 text-xs">({grade.toUpperCase()})</span>}
                        </button>
                      );
                    });
                  })()
                )}
              </div>
              
              {/* Matrix View Button - Show when domain is selected */}
              {selectedDomainId && (
                <div className="flex justify-center">
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => navigate(buildPath(`/realm/${selectedRealmId}/${selectedDomainId}/matrix`))}
                    data-testid="button-matrix-view"
                    className="flex items-center gap-2"
                  >
                    <Grid className="w-4 h-4" />
                    View Analysis Matrix
                  </Button>
                </div>
              )}
            </div>

            {/* Map View */}
            <div className="flex flex-col lg:flex-row gap-6">
              <div className="flex-shrink-0 w-full lg:w-auto">
                <Card className="shadow-sm border border-gray-200">
                  <CardContent className="p-0">
                    <div className="w-full lg:w-[450px] h-[300px] sm:h-[400px] lg:h-[500px]">
                      {selectedRealmId && !entitiesLoading ? (
                        <MunicipalityMap
                          selectedDomain={selectedDomainId}
                          onMunicipalityClick={handleMapMunicipalityClick}
                          allowCollapse={true}
                          className="w-full h-full"
                          selectedMunicipalityId={selectedMunicipalityId}
                          realmId={selectedRealmId}
                          entities={municipalities || []}
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
                
                {/* Map Legend - show when domain is selected */}
                {selectedDomainId && (
                  <Card className="shadow-sm border border-gray-200 mt-3">
                    <CardContent className="p-4">
                      <h4 className="font-medium mb-3 text-sm">Map Legend</h4>
                      
                      {/* Environmental Scores */}
                      <div className="mb-3">
                        <h5 className="text-xs font-medium text-gray-600 mb-2">Environmental Protection Scores</h5>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded" style={{backgroundColor: '#22c55e'}}></div>
                            <span>Strong (8.0-10.0)</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded" style={{backgroundColor: '#65d47f'}}></div>
                            <span>Moderate (5.0-7.9)</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded" style={{backgroundColor: '#a7e6b7'}}></div>
                            <span>Weak (2.0-4.9)</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded" style={{backgroundColor: '#bbf7d0'}}></div>
                            <span>Very Weak (0.0-1.9)</span>
                          </div>
                        </div>
                      </div>
                      
                      {/* Other indicators */}
                      <div>
                        <h5 className="text-xs font-medium text-gray-600 mb-2">Other Indicators</h5>
                        <div className="grid grid-cols-1 gap-2 text-xs">
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded" style={{backgroundColor: '#3b82f6'}}></div>
                            <span>Uses NY State Code</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded" style={{backgroundColor: '#8b5cf6'}}></div>
                            <span>Available Data (No Score)</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded" style={{backgroundColor: '#e2e8f0'}}></div>
                            <span>No Data Available</span>
                          </div>
                        </div>
                      </div>
                      
                      {/* Questions and Scoring Link */}
                      <div className="pt-3 border-t">
                        <Link href={buildPath(`/questions/${selectedRealmId}/domains`)}>
                          <Button variant="outline" size="sm" className="w-full flex items-center justify-center gap-2 text-xs">
                            <Database className="w-3 h-3" />
                            Questions and Scoring
                          </Button>
                        </Link>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>

              {/* Analysis Results Section - Always visible on mobile when data is available */}
              <div className="flex-1 space-y-4 w-full min-h-0">
                {selectedMunicipalityId && !selectedDomainId && availableDomains && (
                  <Card className="shadow-sm border border-gray-200">
                    <CardContent className="p-6">
                      <div className="space-y-4">
                        <div className="text-center border-b pb-4">
                          <h3 className="text-xl font-bold text-gray-900 mb-2">
                            {selectedMunicipality?.displayName} - Domain Overview
                          </h3>
                          <p className="text-sm text-gray-600">
                            Environmental and municipal regulations analysis
                          </p>
                        </div>
                        
                        <div className="space-y-3">
                          {allDomains
                            ?.filter((domain) => domain.show !== false)
                            .map((domain) => {
                              const municipalityDomain = availableDomains.find(d => d.id === domain.id);
                              const hasData = municipalityDomain && municipalityDomain.available;
                              const score = hasData ? (municipalityDomain as any)?.score?.score || null : null;
                              
                              return (
                                <div 
                                  key={domain.id}
                                  className={`p-4 rounded-lg border cursor-pointer transition-colors hover:bg-gray-50 ${
                                    hasData ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50'
                                  }`}
                                  onClick={() => {
                                    if (hasData) {
                                      setSelectedDomainId(domain.id);
                                      navigate(buildPath(`/${domain.id}/${selectedMunicipalityId}`));
                                    }
                                  }}
                                >
                                  <div className="flex items-center justify-between">
                                    <div className="flex-1">
                                      <h4 className="font-medium text-gray-900 mb-1">
                                        {domain.displayName}
                                      </h4>
                                      <p className="text-sm text-gray-600 mb-2">
                                        {domain.description}
                                      </p>
                                      
                                      {hasData ? (
                                        <div className="flex items-center gap-4 text-xs">
                                          <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded">
                                            Local Regulations
                                          </span>
                                          {score !== null && (
                                            <span className={`px-2 py-1 rounded ${
                                              score >= 2.0 ? 'bg-green-100 text-green-700' :
                                              score >= 1.0 ? 'bg-yellow-100 text-yellow-700' :
                                              'bg-red-100 text-red-700'
                                            }`}>
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
                                          href={`/${domain.id}/${selectedMunicipalityId}`}
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
                )}

                {/* Meta-Analysis Display - Show when domain selected but no municipality */}
                {(() => {
                  const shouldShow = !selectedMunicipalityId && selectedDomainId && metaAnalysisData;
                  console.log('🔍 Meta-Analysis Display Check:', {
                    selectedMunicipalityId: selectedMunicipalityId,
                    selectedDomainId: selectedDomainId,
                    hasMetaAnalysisData: !!metaAnalysisData,
                    shouldShow: shouldShow
                  });
                  return shouldShow;
                })() && (
                  <Card className="shadow-sm border border-gray-200">
                    <CardContent className="p-6">
                      <div className="space-y-6">
                        {/* Header */}
                        <div className="text-center border-b pb-4">
                          <h3 className="text-2xl font-bold text-gray-900 mb-2">
                            {metaAnalysisData?.domain?.displayName} - Best Practices Analysis
                          </h3>
                          {metaAnalysisData?.domain?.description && (
                            <p className="text-sm text-gray-700 mb-3 mx-auto max-w-2xl leading-relaxed">
                              {metaAnalysisData.domain.description}
                            </p>
                          )}
                          <p className="text-sm text-gray-600">
                            Analysis of {metaAnalysisData?.totalMunicipalitiesAnalyzed} municipalities • 
                            Generated {new Date(metaAnalysisData?.analysisDate || '').toLocaleDateString()}
                          </p>
                          <div className="flex justify-center items-center gap-4 mt-3 text-sm">
                            <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full">
                              {metaAnalysisData?.bestPractices?.length || 0} best practices identified
                            </span>
                            <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full">
                              Leading: {metaAnalysisData?.highestScoringMunicipality?.displayName}
                            </span>
                          </div>
                        </div>

                        {/* Best Practices Overview */}
                        <div>
                          <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                            <span className="w-6 h-6 bg-civic-blue text-white rounded-full text-sm flex items-center justify-center mr-2">🏆</span>
                            Best Practices Identified
                          </h4>
                          <div className="space-y-4">
                            {metaAnalysisData?.bestPractices?.map((practice, index) => (
                              <div key={practice.questionId} className="border-l-4 border-civic-blue bg-blue-50 p-4 rounded-r-lg">
                                <div className="mb-3">
                                  <h5 className="font-medium text-gray-900 mb-2">
                                    Q{practice.questionId}: {practice.question}
                                  </h5>
                                  <p className="text-gray-700 text-sm leading-relaxed mb-3">
                                    <strong>Best Practice:</strong> {practice.bestAnswer}
                                  </p>
                                  
                                  {/* Municipal References */}
                                  {practice.supportingExamples && practice.supportingExamples.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                      <span className="text-xs text-gray-500 mr-2">References:</span>
                                      {practice.supportingExamples.slice(0, 3).map((example, idx) => (
                                        <button 
                                          key={idx}
                                          onClick={() => handleMetaMunicipalityClick(practice.questionId, example.municipality.id, selectedDomainId)}
                                          className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded hover:bg-blue-200 transition-colors cursor-pointer"
                                        >
                                          {example.municipality.displayName}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                
                                {/* Quantitative Highlights */}
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
                        {metaAnalysisData?.overallRecommendations && metaAnalysisData?.overallRecommendations?.modelMunicipalities?.length > 0 && (
                          <div className="border-t pt-6">
                            <h4 className="text-lg font-semibold text-gray-900 mb-4">Leading Municipalities</h4>
                            <div className="grid md:grid-cols-2 gap-4">
                              <div>
                                <h5 className="font-medium text-green-700 mb-2">Top Performers</h5>
                                <ul className="space-y-1 text-sm text-gray-600">
                                  {metaAnalysisData?.overallRecommendations?.modelMunicipalities?.slice(0, 6).map((municipality, index) => (
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
                            <strong>Click on a municipality</strong> above to see how it compares to these best practices
                          </p>
                          <p className="text-sm text-gray-500">
                            Analysis shows specific improvement recommendations and performance gaps
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Loading state for meta-analysis */}
                {(() => {
                  const shouldShowLoading = !selectedMunicipalityId && selectedDomainId && metaLoading;
                  console.log('⏳ Meta-Analysis Loading Check:', {
                    selectedMunicipalityId: selectedMunicipalityId,
                    selectedDomainId: selectedDomainId,
                    metaLoading: metaLoading,
                    shouldShowLoading: shouldShowLoading
                  });
                  return shouldShowLoading;
                })() && (
                  <Card className="shadow-sm border border-gray-200">
                    <CardContent className="p-6 text-center">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-civic-blue mx-auto mb-4"></div>
                      <p className="text-gray-600">Loading best practices analysis...</p>
                    </CardContent>
                  </Card>
                )}
                
                {/* Show results in right pane when both municipality and domain are selected */}
                {showSidebarAnalysis && selectedMunicipalityId && selectedDomainId && (
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
                              {usesStateCode ? municipalities?.find(m => m.id === selectedMunicipalityId)?.displayName : analysisData.municipality.displayName}
                            </h3>
                            <h4 className="text-base text-civic-blue capitalize">
                              {analysisData.domain.displayName} Regulations
                            </h4>
                            {usesStateCode ? (
                              <div className="inline-flex items-center px-3 py-2 mt-2 rounded-full text-sm font-medium bg-blue-600 text-white">
                                No Local Code, Uses State Code
                              </div>
                            ) : analysisData.domain.grade && (
                              <div className="inline-flex items-center px-3 py-2 mt-2 rounded-full text-sm font-medium bg-civic-blue text-white">
                                Grade: {analysisData.domain.grade.toUpperCase()}
                              </div>
                            )}
                            
                            {/* Version Selector - Show only if there are multiple versions */}
                            {versionsData && versionsData.versions.length > 1 && (
                              <div className="mt-3 flex items-center justify-center gap-2">
                                <label htmlFor="version-select" className="text-xs text-gray-600">
                                  Analysis Version:
                                </label>
                                <select
                                  id="version-select"
                                  value={selectedVersion}
                                  onChange={(e) => setSelectedVersion(e.target.value)}
                                  className="text-xs border border-gray-300 rounded px-2 py-1 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
                                  data-testid="select-analysis-version"
                                >
                                  {versionsData.versions.map((version) => {
                                    const date = new Date(version.timestamp);
                                    const formattedDate = date.toLocaleString(navigator.language, {
                                      year: 'numeric',
                                      month: 'numeric',
                                      day: 'numeric',
                                      hour: 'numeric',
                                      minute: 'numeric',
                                      second: 'numeric',
                                      hour12: true
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
                                  {(scoreData.overallScore).toFixed(1)}
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Questions and Answers - Condensed */}
                          {analysisData.questions.length > 0 ? (
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
                                {analysisData.questions.map((qa, index) => {
                                  const scoredQuestion = scoreData?.questions.find(sq => sq.id === qa.id);
                                  const hasGap = (scoredQuestion && scoredQuestion.score < 1.0) || qa.gap;
                                  
                                  return (
                                    <div key={index} className="text-sm border-b border-gray-100 pb-3 last:border-b-0">
                                      <div className="flex items-start justify-between mb-2">
                                        <p className="font-medium text-gray-800 flex-1">{qa.title}</p>
                                        {scoredQuestion && (
                                          <div className="ml-3 flex-shrink-0">
                                            <ScoreVisualization 
                                              score={scoredQuestion.score}
                                              weight={scoredQuestion.weight}
                                              showWeight={true}
                                              maxScore={1}
                                            />
                                          </div>
                                        )}
                                      </div>
                                      <div className="flex items-start gap-2 mb-2">
                                        <div className="text-gray-600 leading-relaxed flex-1">
                                          <p>{qa.answer}</p>
                                          {(() => {
                                            // Show per-question timestamp only if it differs by more than 10 minutes from overall timestamp
                                            if (!qa.analyzedAt || !analysisData.lastUpdated) return null;
                                            
                                            const questionTime = new Date(qa.analyzedAt);
                                            const overallTime = new Date(analysisData.lastUpdated);
                                            const diffMinutes = Math.abs(questionTime.getTime() - overallTime.getTime()) / (1000 * 60);
                                            
                                            if (diffMinutes > 10) {
                                              return (
                                                <p className="text-xs text-gray-500 mt-1 italic">
                                                  Updated: {questionTime.toLocaleDateString()} {questionTime.toLocaleTimeString()}
                                                </p>
                                              );
                                            }
                                            return null;
                                          })()} 
                                        </div>
                                        {isNotSpecified(qa.answer) && (
                                          <button
                                            onClick={() => handleQuestionMarkClick(qa.id.toString(), analysisData.domain.id)}
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
                                      {((qa.sourceReference && qa.sourceReference.trim()) || (qa.relevantSections && qa.relevantSections.length > 0)) && (
                                        <p className="text-sm text-blue-600 italic">
                                          Reference: 
                                          {qa.relevantSections && qa.relevantSections.length > 0 ? (
                                            <span className="ml-1">
                                              {(() => {
                                                // Handle both legacy string array and new object array formats
                                                const refs = qa.relevantSections;
                                                if (typeof refs[0] === 'string') {
                                                  // Legacy format: array of strings - each gets its own link with statute URL
                                                  return refs.map((section: string, index: number) => (
                                                    <span key={index}>
                                                      <StatuteLink 
                                                        href={analysisData.statute?.sourceUrl}
                                                        municipalityId={usesStateCode ? 'NY-State' : analysisData.municipality.id} 
                                                        domainId={analysisData.domain.id}
                                                      >
                                                        {section}
                                                      </StatuteLink>
                                                      {index < refs.length - 1 && ', '}
                                                    </span>
                                                  ));
                                                } else {
                                                  // New enhanced format: array of objects - each gets its own link with object URL
                                                  return refs.map((ref: any, index: number) => (
                                                    <span key={index}>
                                                      <StatuteLink 
                                                        href={ref.url}
                                                        fallbackHref={analysisData.statute?.sourceUrl}
                                                        municipalityId={usesStateCode ? 'NY-State' : analysisData.municipality.id} 
                                                        domainId={analysisData.domain.id}
                                                      >
                                                        {ref.name}
                                                      </StatuteLink>
                                                      {index < refs.length - 1 && ', '}
                                                    </span>
                                                  ));
                                                }
                                              })()}
                                            </span>
                                          ) : (
                                            // Fallback to single sourceReference link
                                            <StatuteLink 
                                              fallbackHref={analysisData.statute?.sourceUrl}
                                              municipalityId={usesStateCode ? 'NY-State' : analysisData.municipality.id} 
                                              domainId={analysisData.domain.id}
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
                                The analysis for {analysisData.municipality.displayName}'s {analysisData.domain.displayName} regulations 
                                needs to be generated. This will provide answers to common questions about local requirements.
                              </p>
                            </div>
                          )}

                          {/* Analysis & Recommendations */}
                          {analysisData.alignmentSuggestions && (
                            <div className="border-t pt-4 bg-blue-50/30 p-4 rounded-lg">
                              <h5 className="text-base font-semibold text-gray-900 mb-3 flex items-center">
                                <FileText className="text-civic-blue mr-2" size={18} />
                                Analysis & Recommendations
                              </h5>
                              <div className="space-y-4 text-sm bg-white p-3 rounded border">
                                {analysisData.alignmentSuggestions.strengths && analysisData.alignmentSuggestions.strengths.length > 0 && (
                                  <div>
                                    <p className="font-medium text-green-700 mb-1">Strengths</p>
                                    <ul className="list-disc list-inside text-gray-600 space-y-1">
                                      {analysisData.alignmentSuggestions.strengths.map((strength, index) => (
                                        <li key={index}>{strength}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                
                                {analysisData.alignmentSuggestions.improvements && analysisData.alignmentSuggestions.improvements.length > 0 && (
                                  <div>
                                    <p className="font-medium text-orange-700 mb-1">Areas for Improvement</p>
                                    <ul className="list-disc list-inside text-gray-600 space-y-1">
                                      {analysisData.alignmentSuggestions.improvements.map((improvement, index) => (
                                        <li key={index}>{improvement}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                
                                {analysisData.alignmentSuggestions.recommendations && analysisData.alignmentSuggestions.recommendations.length > 0 && (
                                  <div>
                                    <p className="font-medium text-blue-700 mb-1">Recommendations</p>
                                    <ul className="list-disc list-inside text-gray-600 space-y-1">
                                      {analysisData.alignmentSuggestions.recommendations.map((recommendation, index) => (
                                        <li key={index}>{recommendation}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                
                                {analysisData.alignmentSuggestions.bestPractices && analysisData.alignmentSuggestions.bestPractices.length > 0 && (
                                  <div>
                                    <p className="font-medium text-purple-700 mb-1">Best Practices</p>
                                    <ul className="list-disc list-inside text-gray-600 space-y-1">
                                      {analysisData.alignmentSuggestions.bestPractices.map((practice, index) => (
                                        <li key={index}>{practice}</li>
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
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left sidebar - Back button */}
            <div className="lg:col-span-1 space-y-4">
              <Card className="shadow-sm border border-gray-200">
                <CardContent className="p-4">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowResults(false);
                      navigate(buildPath("/"));
                    }}
                    className="w-full"
                  >
                    <ArrowLeft size={16} className="mr-2" />
                    Back to Selection
                  </Button>
                  
                  {selectedMunicipality && (
                    <div className="mt-4">
                      <h3 className="font-semibold text-gray-900 mb-2">Selected</h3>
                      <p className="text-sm text-gray-600 mb-1">{selectedMunicipality.displayName}</p>
                      <p className="text-sm text-civic-blue capitalize">{selectedDomain?.displayName}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Main content area */}
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
                          {usesStateCode ? municipalities?.find(m => m.id === selectedMunicipalityId)?.displayName : analysisData.municipality.displayName}
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
                            {analysisData.domain.grade ? `Grade: ${analysisData.domain.grade.toUpperCase()}` : 'Analysis Available'}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Environmental Protection Summary */}
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
                          <p>Weighted Score: {scoreData.totalWeightedScore.toFixed(1)} out of {scoreData.totalPossibleWeight} possible points</p>
                          <p className="mt-1 text-xs">Based on weighted analysis of {scoreData.questions.length} environmental protection questions</p>
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
                            const scoredQuestion = scoreData?.questions.find(sq => sq.id === qa.id);
                            const hasGap = (scoredQuestion && scoredQuestion.score < 1.0) || qa.gap;
                            
                            return (
                              <div key={index} className="border-l-4 border-civic-blue bg-blue-50 p-4 rounded-r-lg">
                                <div className="flex items-start justify-between mb-2">
                                  <h3 className="font-semibold text-gray-900 text-base flex-1">
                                    Q: {qa.title}
                                  </h3>
                                  {scoredQuestion && (
                                    <div className="ml-4 text-right flex-shrink-0 bg-white rounded-md px-2 py-1">
                                      <div className="text-sm font-medium text-gray-700">
                                        Score: {(scoredQuestion.score * 10).toFixed(1)}/10.0
                                      </div>
                                      {scoredQuestion.weight !== 1 && (
                                        <div className="text-xs text-gray-500">
                                          Weight: {scoredQuestion.weight}x = {scoredQuestion.weightedScore.toFixed(1)} pts
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
                                      onClick={() => handleQuestionMarkClick(qa.id.toString(), analysisData.domain.id)}
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
                                {((qa.sourceReference && qa.sourceReference.trim()) || (qa.relevantSections && qa.relevantSections.length > 0)) && (
                                  <p className="text-xs text-blue-600 mt-2">
                                    Reference: 
                                    <StatuteLink 
                                      fallbackHref={analysisData.statute?.sourceUrl}
                                      municipalityId={analysisData.municipality.id} 
                                      domainId={analysisData.domain.id}
                                    >
                                      <span className="ml-1">
                                        {qa.relevantSections && qa.relevantSections.length > 0 
                                          ? qa.relevantSections.join(', ') 
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
                            fallbackHref={analysisData.statute?.sourceUrl}
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
                          {analysisData.alignmentSuggestions.strengths && analysisData.alignmentSuggestions.strengths.length > 0 && (
                            <div>
                              <h3 className="font-semibold text-green-700 mb-3 text-lg">Strengths</h3>
                              <ul className="space-y-2">
                                {analysisData.alignmentSuggestions.strengths.map((strength, index) => (
                                  <li key={index} className="flex items-start">
                                    <div className="w-2 h-2 bg-green-500 rounded-full mt-2 mr-3 flex-shrink-0"></div>
                                    <span className="text-gray-700 text-sm leading-relaxed">{strength}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          
                          {analysisData.alignmentSuggestions.improvements && analysisData.alignmentSuggestions.improvements.length > 0 && (
                            <div>
                              <h3 className="font-semibold text-orange-700 mb-3 text-lg">Areas for Improvement</h3>
                              <ul className="space-y-2">
                                {analysisData.alignmentSuggestions.improvements.map((improvement, index) => (
                                  <li key={index} className="flex items-start">
                                    <div className="w-2 h-2 bg-orange-500 rounded-full mt-2 mr-3 flex-shrink-0"></div>
                                    <span className="text-gray-700 text-sm leading-relaxed">{improvement}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          
                          {analysisData.alignmentSuggestions.recommendations && analysisData.alignmentSuggestions.recommendations.length > 0 && (
                            <div>
                              <h3 className="font-semibold text-blue-700 mb-3 text-lg">Recommendations</h3>
                              <ul className="space-y-2">
                                {analysisData.alignmentSuggestions.recommendations.map((recommendation, index) => (
                                  <li key={index} className="flex items-start">
                                    <div className="w-2 h-2 bg-blue-500 rounded-full mt-2 mr-3 flex-shrink-0"></div>
                                    <span className="text-gray-700 text-sm leading-relaxed">{recommendation}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          
                          {analysisData.alignmentSuggestions.bestPractices && analysisData.alignmentSuggestions.bestPractices.length > 0 && (
                            <div>
                              <h3 className="font-semibold text-purple-700 mb-3 text-lg">Best Practices</h3>
                              <ul className="space-y-2">
                                {analysisData.alignmentSuggestions.bestPractices.map((practice, index) => (
                                  <li key={index} className="flex items-start">
                                    <div className="w-2 h-2 bg-purple-500 rounded-full mt-2 mr-3 flex-shrink-0"></div>
                                    <span className="text-gray-700 text-sm leading-relaxed">{practice}</span>
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
                      No {documentType} analysis is available for {selectedMunicipality?.displayName} in the {selectedDomain?.displayName} domain.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}

      </div>

      {/* Municipalities with Answers Dialog */}
      <Dialog open={!!questionMunicipalitiesPopup} onOpenChange={() => setQuestionMunicipalitiesPopup(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Municipalities with Specific Requirements</DialogTitle>
            <DialogDescription>
              The following municipalities have specified requirements for this question:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            {questionMunicipalitiesPopup?.municipalities.map((municipality, index) => (
              <div key={index} className="border border-gray-200 rounded-lg p-4">
                <h4 className="font-semibold text-gray-900 mb-2">{municipality.name}</h4>
                <p className="text-sm text-gray-600 leading-relaxed">{municipality.answer}</p>
              </div>
            ))}
            {questionMunicipalitiesPopup?.municipalities.length === 0 && (
              <p className="text-gray-500 text-center py-4">
                No municipalities have specified requirements for this question yet.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Municipality Answer Popup from Meta-Analysis */}
      {municipalityAnswerPopup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-semibold">
                    {municipalities?.find(m => m.id === municipalityAnswerPopup.municipalityId)?.displayName}
                  </h3>
                  <p className="text-sm text-gray-600">
                    Question {municipalityAnswerPopup.questionId} Response
                  </p>
                </div>
                <button
                  onClick={() => setMunicipalityAnswerPopup(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X size={24} />
                </button>
              </div>
              <div className="space-y-4">
                <div className="flex gap-4 text-sm text-gray-600">
                  <span>Score: {(municipalityAnswerPopup.score * 10).toFixed(1)}/10.0</span>
                  <span>Confidence: {municipalityAnswerPopup.confidence}%</span>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-gray-800 leading-relaxed">{municipalityAnswerPopup.answer}</p>
                </div>
                <div className="text-center pt-2">
                  <button
                    onClick={() => {
                      setMunicipalityAnswerPopup(null);
                      setSelectedMunicipalityId(municipalityAnswerPopup.municipalityId);
                      setShowSidebarAnalysis(true);
                      updateURL(municipalityAnswerPopup.municipalityId, selectedDomainId);
                    }}
                    className="text-sm text-civic-blue hover:text-civic-blue-dark underline"
                  >
                    View full analysis for this municipality
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200 mt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col md:flex-row items-center justify-between">
            <div className="flex items-center space-x-3 mb-4 md:mb-0">
              <div className="w-8 h-8 bg-civic-blue rounded-lg flex items-center justify-center">
                <Scale className="text-white text-sm" />
              </div>
              <span className="text-sm text-civic-gray-light">Ordinizer © 2025 Civilly Engaged. Making municipal law accessible.</span>
            </div>
            <div className="flex items-center space-x-6 text-sm text-civic-gray-light">
              <a href="#" className="hover:text-gray-900 transition-colors">About</a>
              <Link href={buildPath("/data/sourcedata")} className="hover:text-gray-900 transition-colors">Data Sources</Link>
              <a href="#" className="hover:text-gray-900 transition-colors">API</a>
              <a href="#" className="hover:text-gray-900 transition-colors">Contact</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}