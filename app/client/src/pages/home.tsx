import { useState, useEffect, useCallback } from "react";
import { useLocation, useSearch, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiPath } from "../lib/apiConfig";
import { queryClient } from "../lib/queryClient";
import { getDefaultRealmId } from '../lib/realmUtils';
import { useBasePath } from "../contexts/BasePathContext";
import { useRealms } from "../hooks/useRealms";
import { useEntities } from "../hooks/useEntities";
import type { Entity, EntityDomain, Realm, MetaAnalysis, Analysis } from "@civillyengaged/ordinizer-core";
import { AppHeader } from "./home/AppHeader";
import { EntityCombobox } from "./home/EntityCombobox";
import { DomainSelector } from "./home/DomainSelector";
import { MapPanel } from "./home/MapPanel";
import { DomainOverviewCard } from "./home/DomainOverviewCard";
import { MetaAnalysisPanel } from "./home/MetaAnalysisPanel";
import { SidebarAnalysis } from "./home/SidebarAnalysis";
import { FullAnalysisView } from "./home/FullAnalysisView";
import { QuestionMunicipalitiesDialog } from "./home/QuestionMunicipalitiesDialog";
import { MunicipalityAnswerPopup } from "./home/MunicipalityAnswerPopup";
import type { ScoreData, VersionsData } from "./home/types";

export default function Home() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = useParams();
  const { buildPath } = useBasePath();
  const [selectedEntityId, setSelectedEntityId] = useState<string>("");
  const [selectedDomainId, setSelectedDomainId] = useState<string>("");
  const [selectedRealmId, setSelectedRealmId] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<string>("current");
  const [showResults, setShowResults] = useState(false);
  const [showSidebarAnalysis, setShowSidebarAnalysis] = useState(false);
  const [municipalityComboOpen, setEntityComboOpen] = useState(false);
  const [questionMunicipalitiesPopup, setQuestionMunicipalitiesPopup] = useState<{questionId: string; municipalities: any[]} | null>(null);
  const [municipalityAnswerPopup, setEntityAnswerPopup] = useState<{questionId: number; municipalityId: string; answer: string; score: number; confidence: number} | null>(null);

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
  const handleMetaEntityClick = async (questionId: number, municipalityId: string, domainId: string) => {
    try {
      const response = await fetch(apiPath(`analyses/${selectedRealmId}/${municipalityId}/${domainId}`));
      if (response.ok) {
        const responseData = await response.json();
        const analysisData = responseData;
        const question = analysisData.questions.find((q: any) => q.id === questionId);
        if (question) {
          setEntityAnswerPopup({
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
  const { data: realms, isLoading: realmsLoading } = useRealms();

  // Get current realm info for terminology
  const currentRealm = realms?.find(r => r.id === selectedRealmId);
  const isPolicy = currentRealm?.ruleType === 'policy';
  const documentType = isPolicy ? 'policy' : 'statute';
  const documentTypeCapitalized = isPolicy ? 'Policy' : 'Statute';
  const entityType = currentRealm?.entityType === 'school-districts' ? 'School District' : 'Entity';

  // Fetch entities for current realm (municipalities, school districts, etc.)
  const { data: entities, isLoading: entitiesLoading } = useEntities(selectedRealmId);

  // Use entities as municipalities for backward compatibility
  const municipalities = entities;
  const municipalitiesLoading = entitiesLoading;

  // Helper function to create municipality display name for URL
  const createEntitySlug = (municipality: Entity): string => {
    // Use the municipality ID directly since it's already in the correct format
    return municipality.id;
  };

  // Helper function to find municipality by slug
  const findEntityBySlug = (slug: string, municipalities: Entity[]): Entity | undefined => {
    // Since slug is now the municipality ID, just find by exact ID match
    return municipalities.find(m => m.id === slug);
  };

  // Extract realm ID from route parameters first
  useEffect(() => {
    const realmIdFromRoute = params.realmid;
    if (realmIdFromRoute && realmIdFromRoute !== selectedRealmId) {
      // console.log('Setting realm ID from route:', realmIdFromRoute);
      setSelectedRealmId(realmIdFromRoute);
    } else if (!realmIdFromRoute && !selectedRealmId) {
      // Fallback to dynamically determined default realm
      // console.log('ðŸ›ï¸ No realm in route, determining default dynamically');
      getDefaultRealmId().then(defaultRealmId => {
        if (defaultRealmId) {
          // console.log('ðŸ›ï¸ Using default realm:', defaultRealmId);
          setSelectedRealmId(defaultRealmId);
        }
      }).catch(error => {
        console.warn('ðŸ›ï¸ Failed to get default realm:', error);
      });
    }
  }, [params.realmid]);

  // Parse both path parameters and query parameters
  useEffect(() => {
    // console.log('URL Effect triggered:', { 
    //   params, 
    //   search, 
    //   selectedEntityId, 
    //   selectedDomainId 
    // });
    
    // Handle path-based routing (/realm/westchester-municipal-environmental/trees/NY-Ardsley or /realm/westchester-municipal-environmental/trees)
    if (params.realmid && params.domain) {
      const realmId = params.realmid;
      const domainId = params.domain;
      // console.log('Path-based routing - realm:', realmId, 'domain:', domainId, 'municipality:', params.municipality);
      
      // Set realm if different
      if (realmId !== selectedRealmId) {
        // console.log('Setting realm from URL:', realmId);
        setSelectedRealmId(realmId);
      }
      
      // Set domain if different
      if (domainId !== selectedDomainId) {
        // console.log('Setting domain from URL:', domainId);
        setSelectedDomainId(domainId);
      }
      
      // Handle municipality if provided (/realm/westchester-municipal-environmental/trees/NY-Ardsley)
      if (params.municipality && municipalities) {
        const municipalitySlug = params.municipality;
        const municipality = findEntityBySlug(municipalitySlug, municipalities);
        // console.log('Found municipality from slug:', municipalitySlug, '->', municipality?.displayName);
        
        if (municipality && municipality.id !== selectedEntityId) {
          // console.log('Setting municipality from URL:', municipality.id);
          setSelectedEntityId(municipality.id);
          setSelectedVersion("current"); // Reset to current version when municipality changes
          setShowSidebarAnalysis(true); // Show analysis in sidebar, keep map visible
          setShowResults(false); // Always keep map visible
        }
      }
      // If only domain is provided (/realm/westchester-municipal-environmental/trees), don't show results yet - wait for municipality selection
      else if (!params.municipality) {
        // console.log('Domain-only path, clearing municipality and sidebar');
        // Clear municipality if it's set (avoid React warnings by using setTimeout)
        if (selectedEntityId) {
          // console.log('Clearing municipality from domain-only URL');
          setTimeout(() => setSelectedEntityId(""), 0);
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
    
    if (municipalityParam && municipalityParam !== selectedEntityId) {
      setSelectedEntityId(municipalityParam);
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
      setSelectedEntityId("");
      setSelectedDomainId("");
      setShowResults(false);
    }
  }, [search, params, municipalities, selectedDomainId, selectedEntityId]);

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
  });


  // Fetch domains for selected municipality
  const { data: availableDomains, isLoading: domainsLoading } = useQuery<EntityDomain[]>({
    queryKey: [apiPath('realms'), selectedRealmId, 'entities', selectedEntityId, 'domains'],
    enabled: !!selectedEntityId && !!selectedRealmId
  });

  // Fetch domain summary data to determine if municipality uses state code
  const { data: domainSummary } = useQuery<Array<{entityId: string, grade: string | null, gradeColor: string | null, available: boolean, stateCodeApplies: boolean}>>({
    queryKey: [apiPath('domains'), selectedRealmId, selectedDomainId, 'summary'],
    enabled: !!selectedDomainId && !!selectedRealmId
  });

  // Fetch meta-analysis when domain is selected but no municipality
  const { data: metaAnalysisData, isLoading: metaLoading } = useQuery<MetaAnalysis>({
    queryKey: [apiPath('domains'), selectedRealmId, selectedDomainId, 'meta-analysis'],
    enabled: !!selectedDomainId && !selectedEntityId && !!selectedRealmId
  });

  // Fetch analysis data
  // Check if selected municipality uses state code
  const selectedEntitySummary = domainSummary?.find(s => s.entityId === selectedEntityId);
  const usesStateCode = selectedEntitySummary?.stateCodeApplies || false;
  
  // Determine which municipality ID to use for analysis fetch
  const analysisTargetEntityId = usesStateCode ? `${currentRealm?.state}-State` : selectedEntityId;

  // Fetch available analysis versions
  const { data: versionsData } = useQuery<{versions: Array<{version: string; filename: string; displayName: string; timestamp: string; isCurrent: boolean}>}>({
    queryKey: [apiPath('analyses'), selectedRealmId, analysisTargetEntityId, selectedDomainId, 'versions'],
    enabled: !!selectedEntityId && !!selectedDomainId && !!selectedRealmId
  });

  const { data: analysisData, isLoading: analysisLoading, error: analysisError } = useQuery<Analysis>({
    queryKey: [apiPath('analyses'), selectedRealmId, analysisTargetEntityId, selectedDomainId, selectedVersion],
    queryFn: async () => {
      const url = apiPath(`analyses/${selectedRealmId}/${analysisTargetEntityId}/${selectedDomainId}${selectedVersion !== 'current' ? `?version=${encodeURIComponent(selectedVersion)}` : ''}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch analysis');
      return response.json();
    },
    enabled: (showResults || showSidebarAnalysis) && !!selectedEntityId && !!selectedDomainId && !!selectedRealmId
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
    queryKey: [apiPath('scores'), selectedRealmId, selectedEntityId, selectedDomainId],
    enabled: !usesStateCode && !!selectedEntityId && !!selectedDomainId && !!selectedRealmId,
    staleTime: 1000 * 60 * 5 // Cache for 5 minutes
  });

  // Add effect to log analysis data changes
  useEffect(() => {
    if (analysisData && selectedDomainId && selectedEntityId) {
      // console.log('Analysis data received:', {
      //   municipality: analysisData?.municipality?.displayName,
      //   domain: analysisData?.domain?.displayName,
      //   questionsCount: analysisData?.questions?.length || 0,
      //   hasAlignmentSuggestions: !!analysisData?.alignmentSuggestions,
      //   showSidebarAnalysis,
      //   showResults
      // });
    }
    if (analysisError) {
      console.error('Analysis data fetch failed:', analysisError);
    }
  }, [analysisData, analysisError, showSidebarAnalysis, showResults, selectedDomainId, selectedEntityId]);

  const selectedEntity = municipalities?.find(m => m.id === selectedEntityId);
  const selectedDomain = availableDomains?.find(d => d.id === selectedDomainId);

  const handleEntityChange = (value: string) => {
    // console.log('Dropdown municipality selection:', value);
    const municipality = municipalities?.find(m => m.id === value);
    // console.log('Found municipality object:', municipality?.displayName, 'ID:', municipality?.id);
    
    setSelectedEntityId(value);
    // Don't clear domain selection when changing municipality
    // If domain is already selected, show results in right pane, don't navigate
    if (selectedDomainId) {
      setShowSidebarAnalysis(true);
      // Update URL for deep linking but don't navigate
      if (municipality) {
        const slug = createEntitySlug(municipality);
        // console.log('Created slug for URL:', slug);
        window.history.pushState({}, '', `/realm/${selectedRealmId}/${selectedDomainId}/${slug}`);
      }
    } else {
      setShowSidebarAnalysis(false);
      updateURL(value, "");
    }
  };

  const handleRealmChange = (realmId: string) => {
    // console.log('=== REALM CHANGE START ===');
    // console.log('Changing from', selectedRealmId, 'to', realmId);
    // console.log('Current allDomains before change:', allDomains?.map(d => d.displayName));
    
    // Store old realm ID before updating
    const oldRealmId = selectedRealmId;
    
    // Completely clear all realm-related queries
    // console.log('Removing ALL realm queries from cache');
    queryClient.removeQueries({ queryKey: [apiPath('realms')] });
    queryClient.clear(); // Nuclear option - clear entire cache
    
    // console.log('Setting selectedRealmId to:', realmId);
    setSelectedRealmId(realmId);
    
    // Reset domain and municipality when realm changes since different realms have different domains/entities
    if (selectedDomainId) {
      // console.log('Clearing domain selection due to realm change');
      setSelectedDomainId("");
    }
    if (selectedEntityId) {
      // console.log('Clearing municipality selection due to realm change');
      setSelectedEntityId("");
    }
    
    // Clear UI state
    setShowSidebarAnalysis(false);
    setShowResults(false);
    
    // Navigate to the new realm route
    navigate(buildPath(`/realm/${realmId}`));
    // console.log('=== REALM CHANGE END ===');
  };

  const handleDomainChange = (domainId: string, available?: boolean) => {
    // console.log('Domain change - domainId:', domainId, 'available:', available, 'current selectedDomainId:', selectedDomainId);
    
    // For municipalities with loaded domains, check availability
    if (selectedEntityId && available !== undefined && !available) return;
    
    // If clicking the same domain, unselect it
    if (selectedDomainId === domainId) {
      // console.log('Unselecting domain:', domainId);
      setSelectedDomainId("");
      setShowSidebarAnalysis(false);
      updateURL(selectedEntityId, "");
    } else {
      // Select new domain
      // console.log('Selecting new domain:', domainId);
      setSelectedDomainId(domainId);
      
      // Show results in sidebar if both municipality and domain are selected
      if (selectedEntityId) {
        // console.log('Entity already selected, showing sidebar analysis');
        setShowSidebarAnalysis(true);
        setShowResults(false); // Ensure we stay in the main selection interface
        updateURL(selectedEntityId, domainId);
      } else {
        // If no municipality selected, navigate to domain-only path
        // console.log('No municipality selected, navigating to domain path');
        navigate(buildPath(`/realm/${selectedRealmId}/${domainId}`));
      }
    }
  };

  // Map click handler - clean state updates without timeout issues
  const handleMapEntityClick = useCallback((municipalityId: string) => {
    // console.log('Map click - municipality:', municipalityId);
    
    // Always set the municipality
    setSelectedEntityId(municipalityId);
    
    // Check current domain state and update sidebar accordingly
    setSelectedDomainId(currentDomainId => {
      if (currentDomainId) {
        // console.log('Domain is selected, showing analysis in sidebar for domain:', currentDomainId);
        
        // Show sidebar when domain is selected
        setShowSidebarAnalysis(true);
        
        // Update URL for deep linking
        const municipality = municipalities?.find(m => m.id === municipalityId);
        if (municipality) {
          const slug = createEntitySlug(municipality);
          updateURL(municipalityId, currentDomainId);
        }
      } else {
        // console.log('No domain selected, staying in selection mode');
        
        // Hide sidebar when no domain is selected
        setShowSidebarAnalysis(false);
        
        // Update URL with municipality only
        updateURL(municipalityId, "");
      }
      
      return currentDomainId; // Don't change domain selection
    });
    
    setShowResults(false); // Always stay in selection interface
  }, [municipalities, createEntitySlug, updateURL]);

  
  return (  
    <div className="bg-civic-bg" style={{ minHeight: 'calc(100vh - 52px)' }}>
      <AppHeader
        selectedRealmId={selectedRealmId}
        realms={realms}
        entityType={entityType}
        documentTypeCapitalized={documentTypeCapitalized}
        onRealmChange={handleRealmChange}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {!showResults ? (
          <div className="space-y-6">
            <EntityCombobox
              selectedEntityId={selectedEntityId}
              selectedDomainId={selectedDomainId}
              selectedRealmId={selectedRealmId}
              municipalities={municipalities}
              municipalityComboOpen={municipalityComboOpen}
              currentRealm={currentRealm}
              onOpenChange={setEntityComboOpen}
              onEntityChange={handleEntityChange}
              onClearEntity={() => {
                const newPath = selectedDomainId ? `/realm/${selectedRealmId}/${selectedDomainId}` : `/realm/${selectedRealmId}`;
                navigate(buildPath(newPath));
                setTimeout(() => {
                  setSelectedEntityId("");
                  setShowResults(false);
                  setShowSidebarAnalysis(false);
                  setEntityComboOpen(false);
                }, 50);
              }}
              onResetAll={() => {
                setSelectedEntityId("");
                setSelectedDomainId("");
                setShowResults(false);
                setShowSidebarAnalysis(false);
                navigate(buildPath(`/realm/${selectedRealmId}`));
              }}
            />

            <DomainSelector
              allDomains={allDomains}
              selectedDomainId={selectedDomainId}
              selectedEntityId={selectedEntityId}
              availableDomains={availableDomains}
              allDomainsLoading={allDomainsLoading}
              domainsLoading={domainsLoading}
              documentType={documentType}
              selectedRealmId={selectedRealmId}
              onDomainChange={handleDomainChange}
              navigate={navigate}
              buildPath={buildPath}
            />

            <div className="flex flex-col lg:flex-row gap-6">
              <MapPanel
                selectedDomainId={selectedDomainId}
                selectedEntityId={selectedEntityId}
                selectedRealmId={selectedRealmId}
                currentRealm={currentRealm}
                entitiesLoading={entitiesLoading}
                onEntityClick={handleMapEntityClick}
                buildPath={buildPath}
              />

              <div className="flex-1 space-y-4 w-full min-h-0">
                {selectedEntityId && !selectedDomainId && availableDomains && (
                  <DomainOverviewCard
                    selectedEntity={selectedEntity}
                    allDomains={allDomains}
                    availableDomains={availableDomains}
                    selectedEntityId={selectedEntityId}
                    onSelectDomain={(domainId) => {
                      setSelectedDomainId(domainId);
                      navigate(buildPath(`/${domainId}/${selectedEntityId}`));
                    }}
                    navigate={navigate}
                    buildPath={buildPath}
                  />
                )}

                {showSidebarAnalysis && selectedEntityId && selectedDomainId && (
                  <SidebarAnalysis
                    analysisData={analysisData}
                    analysisLoading={analysisLoading}
                    versionsData={versionsData as VersionsData | undefined}
                    scoreData={scoreData as ScoreData | undefined}
                    selectedVersion={selectedVersion}
                    onVersionChange={setSelectedVersion}
                    usesStateCode={usesStateCode}
                    municipalities={municipalities}
                    selectedEntityId={selectedEntityId}
                    currentRealm={currentRealm}
                    onQuestionMarkClick={handleQuestionMarkClick}
                  />
                )}

                <MetaAnalysisPanel
                  metaAnalysisData={metaAnalysisData}
                  metaLoading={metaLoading}
                  selectedDomainId={selectedDomainId}
                  onMetaEntityClick={handleMetaEntityClick}
                />
              </div>
            </div>
          </div>
        ) : (
          <FullAnalysisView
            analysisData={analysisData}
            analysisLoading={analysisLoading}
            scoreData={scoreData as ScoreData | undefined}
            usesStateCode={usesStateCode}
            municipalities={municipalities}
            selectedEntityId={selectedEntityId}
            selectedEntity={selectedEntity}
            selectedDomain={selectedDomain}
            documentType={documentType}
            onBack={() => {
              setShowResults(false);
              navigate(buildPath("/"));
            }}
            onQuestionMarkClick={handleQuestionMarkClick}
          />
        )}
      </div>

      <QuestionMunicipalitiesDialog
        popup={questionMunicipalitiesPopup}
        onClose={() => setQuestionMunicipalitiesPopup(null)}
      />

      <MunicipalityAnswerPopup
        popup={municipalityAnswerPopup}
        municipalities={municipalities}
        onClose={() => setEntityAnswerPopup(null)}
        onViewFullAnalysis={(municipalityId) => {
          setEntityAnswerPopup(null);
          setSelectedEntityId(municipalityId);
          setShowSidebarAnalysis(true);
          updateURL(municipalityId, selectedDomainId);
        }}
      />
    </div>
  );
}
