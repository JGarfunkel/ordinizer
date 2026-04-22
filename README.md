# Ordinizer - Municipal Statute Analysis Platform

Ordinizer is a comprehensive TypeScript-based municipal statute analysis platform that extracts, analyzes, and presents legal differences across jurisdictions using advanced geospatial and text processing technologies. It supports multiple realms (geographic scopes), each with configurable entity types, domains, and data sources.

## Features

- **Multi-Realm Architecture**: Configure multiple jurisdictions (counties, regions, districts) with independent data sources and entity types
- **Advanced Mapping**: Interactive GeoJSON-powered boundary mapping with mobile-optimized interface
- **Vector-Based Analysis**: Pinecone vector search for statute indexing and retrieval with 60-95% confidence scores
- **Multiple Domain Support**: Configurable analysis domains per realm (e.g., Trees, Wetlands, Property Maintenance, Zoning, and more)
- **AI-Powered Q&A Generation**: Uses OpenAI GPT-4o to generate plain-language questions and answers from complex statute content
- **Smart Data Processing**: Automated HTML to plain text conversion with source preservation
- **Incremental Processing**: Only downloads/analyzes if files are missing, >30 days old, or forced
- **Quality Scoring**: Analysis version comparison to preserve better content when regenerating
- **File-Based Storage**: All data stored as JSON files for easy version control and transparency
- **Modern Web Interface**: React + TypeScript frontend with shadcn/ui components and mobile-friendly design

## Concepts

### Realms

A **realm** is a geographic scope of analysis, defined in `data/realms.json`. Each realm specifies:
- **State and county** for geographic context
- **Entity type** (`municipalities` or `school-districts`)
- **Data source** (Google Sheets, JSON file, etc.)
- **Domains** to analyze (Trees, Zoning, etc.)
- **Map boundaries** for visualization

Example realm configuration:
```json
{
  "id": "my-county-environmental",
  "name": "My County Environmental",
  "displayName": "My County Environmental Ordinances",
  "type": "statute",
  "state": "NY",
  "county": "Westchester",
  "entityType": "municipalities",
  "datapath": "environmental-municipal",
  "mapBoundaries": "boundaries.json",
  "mapCenter": [41.1220, -73.7949],
  "mapZoom": 10,
  "domains": ["Trees", "Wetland Protection", "Dark Sky"]
}
```

### Entities

Entities are the subjects being analyzed — typically municipalities (towns, villages, cities) or school districts. Each entity has statute/policy documents organized by domain.

### Domains

Domains are the legal topics being analyzed (e.g., "Trees & Urban Forestry", "Wetland Protection", "Property Maintenance"). Each realm defines which domains it covers.

## Quick Start

### 1. Set up API Keys

The application requires API keys for external services:

1. **OpenAI API Key** (required for AI analysis):
   - Go to https://platform.openai.com
   - Create an account and get an API key
   - Add as `OPENAI_API_KEY` environment variable

2. **Google Sheets API Key** (optional, for spreadsheet-based data extraction):
   - Enable Google Sheets API in Google Cloud Console
   - Add as `GOOGLE_SHEETS_API_KEY` environment variable

3. **Pinecone API Key** (optional, for vector analysis):
   - Create account at https://pinecone.io
   - Add as `PINECONE_API_KEY` environment variable

### 2. Configure a Realm

Create or update `data/realms.json` with your realm configuration (see Concepts > Realms above).

If using a Google Sheets data source, configure `app/analyzer/data/spreadsheetExtractionProperties.json` with the spreadsheet URL, state code, and domain mappings for your realm.

### 3. Extract Entity Data

Extract entity and statute data from your configured data source:

```bash
# Extract all domains with smart incremental processing
tsx ordinizer/scripts/extractFromGoogleSheets.ts

# Extract specific domain
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain="Property Maintenance"

# Extract with verbose logging
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain=Trees --verbose

# Extract with entity filter
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain=Trees --municipality-filter="Ardsley,Bedford,Bronxville"
```

This will:
- Create entity and domain definition files in the realm's data directory
- Download statute/policy files to `data/{realm-datapath}/{domain}/{StateCode}-{Entity}-{Type}/statute.txt`
- Create metadata files with download information and grades
- Handle both hyperlinked URLs and direct text URLs from spreadsheet cells

### 4. Generate AI Analysis

Analyze statute files and generate AI-powered Q&A:

```bash
# Generate analysis for all domains
tsx ordinizer/scripts/analyzeStatutes.ts

# Analyze specific domain
tsx ordinizer/scripts/analyzeStatutes.ts --domain trees

# Force regenerate analysis (ignores age checks)
tsx ordinizer/scripts/analyzeStatutes.ts --domain trees --force

# Generate with verbose logging for debugging
tsx ordinizer/scripts/analyzeStatutes.ts --domain trees --verbose

# Regenerate scores only (fast, no AI calls)
tsx ordinizer/scripts/analyzeStatutes.ts --generateScoreOnly --domain trees

# Generate analysis AND meta-analysis in one command
tsx ordinizer/scripts/analyzeStatutes.ts --domain trees --generate-meta
```

### 5. Run the Web Application

```bash
npm run dev
```

The application will be available at the provided URL with:
- Interactive map interface with entity boundaries
- URL routing like `/realm/{realmId}/{domain}/{entityId}` for direct access
- Mobile-optimized interface with collapsible map functionality

## Script Architecture

The project uses a streamlined script architecture with two main production scripts.

**Library-Style Usage**: All scripts are referenced as a library from the `ordinizer/` directory. Run scripts using `tsx ordinizer/scripts/<script-name>.ts` from the project root.

### Main Production Scripts

#### 1. `extractFromGoogleSheets.ts` - Data Extraction & Statute Download
The primary data extraction script that handles the complete pipeline:

```bash
# Basic usage - extracts all domains
tsx ordinizer/scripts/extractFromGoogleSheets.ts

# Extract specific domain
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain="Property Maintenance"

# Filter by entities
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain=Trees --municipality-filter="Ardsley,Bedford"
```

**Features:**
- Smart URL extraction (prioritizes cell content over generic hyperlinks)
- Respects server rate limits (5-second delays between downloads)
- Creates entity and domain definition files
- Downloads statute content with HTML preservation option
- Handles grading system (G-, R-, Y-, X- prefixes)
- Generates metadata with download timestamps and source URLs
- Verbose logging mode (`--verbose` or `-v`) for HTTP debugging
- Entity filtering (`--municipality-filter="name1,name2"`) for targeted extraction
- **Intelligent parameter validation** with typo suggestions using Levenshtein distance algorithm

#### 2. `analyzeStatutes.ts` - AI Analysis Generation
Generates AI-powered Q&A analysis using OpenAI and optional Pinecone vector processing:

```bash
# Analyze all domains and entities
tsx ordinizer/scripts/analyzeStatutes.ts

# Process specific domain with verbose logging
tsx ordinizer/scripts/analyzeStatutes.ts --domain property-maintenance --verbose

# Force re-analysis of specific entity
tsx ordinizer/scripts/analyzeStatutes.ts --municipality NY-Bedford-Town --force

# Regenerate scores only without AI analysis (fast)
tsx ordinizer/scripts/analyzeStatutes.ts --generateScoreOnly --domain trees
```

**Features:**
- Generates domain-specific questions if missing
- Creates confidence-scored Q&A analysis using OpenAI GPT-4o and Pinecone vector search
- Implements incremental processing (only analyzes new/missing questions)
- Quality preservation (keeps better analysis when regenerating)
- Handles corrupted statute detection and state code references

### Specialized Utility Scripts

Additional scripts for specific maintenance tasks:

- `reconvertHtmlToText.ts` - Re-convert statute HTML files to proper plain text
- `cleanupDuplicateDirectories.ts` - Remove duplicate entity directories with incorrect naming
- `removeLoginPromptFiles.ts` - Remove files containing login prompts instead of actual content
- `clearCorruptionFlags.ts` - Remove corruption markers from analysis files
- `redownloadCorruptedStatutes.ts` - Re-attempt downloads for failed entities
- `testSpreadsheetExtraction.ts` - Test URL extraction logic without downloading

## Object Types and Storage

The system uses a comprehensive object-oriented data model with file-based storage:

### Core Object Types

| Object Type | Storage Location | Description |
|-------------|------------------|-------------|
| **Realm** | `data/realms.json` | Realm definitions with state, county, entity type, domains, map config |
| **Entity** | `data/{realm-datapath}/{entity-file}` | Entity definitions (municipalities, school districts) with IDs and names |
| **Domain** | `data/{realm-datapath}/domains.json` | Domain definitions for the realm |
| **Statute/Policy Text** | `data/{realm-datapath}/{domain}/{Entity-ID}/statute.txt` | Plain text content |
| **Statute/Policy HTML** | `data/{realm-datapath}/{domain}/{Entity-ID}/statute.html` | Original HTML source (optional) |
| **Metadata** | `data/{realm-datapath}/{domain}/{Entity-ID}/metadata.json` | Download metadata with grades, URLs, timestamps |
| **Analysis** | `data/{realm-datapath}/{domain}/{Entity-ID}/analysis.json` | AI-generated Q&A with confidence scores and grades |
| **Questions** | `data/{realm-datapath}/{domain}/questions.json` | Domain-specific question templates for AI analysis |
| **Boundaries** | `data/{realm-datapath}/boundaries.json` | GeoJSON boundary data for map visualization |

### Data Storage Structure

```
data/
├── realms.json                          # Realm definitions
├── {realm-datapath}/                    # e.g., environmental-municipal/
│   ├── municipalities.json              # Entity definitions
│   ├── domains.json                     # Domain definitions
│   ├── boundaries.json                  # GeoJSON map boundaries
│   ├── {domain}/                        # e.g., trees/
│   │   ├── questions.json               # AI-generated questions for domain
│   │   ├── {StateCode}-{Entity}-{Type}/ # e.g., NY-Ardsley-Village/
│   │   │   ├── statute.txt              # Plain text content
│   │   │   ├── statute.html             # Original HTML (optional)
│   │   │   ├── metadata.json            # Download metadata
│   │   │   └── analysis.json            # AI-generated Q&A
│   │   └── ...
│   └── ...
└── ...
```

## API Endpoints

The application provides comprehensive REST API endpoints:

### Realms
- `GET /api/realms` - List all configured realms
- `GET /api/realms/:realmId` - Get a specific realm
- `GET /api/realms/:realmId/entities` - List entities for a realm

### Analysis & Content
- `GET /api/analyses/:realmId/:entityId/:domainId` - Get AI-generated Q&A analysis
- `GET /api/map-boundaries?realm=:realmId` - GeoJSON boundaries for map visualization

### Domains & Scores
- `GET /api/domains/:realmId/:domainId/summary` - Domain summary with grades across entities
- `GET /api/realms/:realmId/combined-matrix` - Full score matrix across all domains

## Development

### Technology Stack
- **Frontend**: React 18 + TypeScript + Vite + shadcn/ui components + Tailwind CSS
- **Backend**: Express.js + TypeScript with hot reloading via tsx
- **Storage**: File-based JSON with fs-extra
- **AI Processing**: OpenAI GPT-4o for question generation and statute analysis
- **Vector Search**: Pinecone integration for enhanced statute analysis (optional)
- **Mapping**: Leaflet + react-leaflet with GeoJSON boundaries
- **State Management**: TanStack Query (React Query) for server state and caching
- **Routing**: Wouter for lightweight client-side routing

### Project Structure

```
packages/
├── core/                # Shared types and schemas (@ordinizer/core)
└── servercore/          # Server-side storage, scoring, config (@ordinizer/servercore)

app/
├── analyzer/            # Data extraction and analysis pipeline
│   ├── lib/             # Core analysis modules
│   └── data/            # Realm-specific extraction config
├── client/              # React frontend
│   ├── src/components/  # Reusable UI components
│   ├── src/pages/       # Route components
│   ├── src/hooks/       # Custom React hooks
│   └── src/lib/         # Utilities and query client setup
└── server/              # Express.js backend with realm-aware routes
    └── routes/          # API endpoint definitions
```

### Environment Variables
- `OPENAI_API_KEY` - Required for AI analysis
- `GOOGLE_SHEETS_API_KEY` - Required for spreadsheet-based data extraction
- `PINECONE_API_KEY` - Optional for vector analysis
- `KEEP_STATUTE_SOURCE_HTML` - Set to 'true' to preserve original HTML files
- `CURRENT_REALM` - Set the active realm for analysis scripts (e.g., `my-county-environmental`)

## User Experience Features

- **Realm Switching**: Navigate between different jurisdictions/scopes
- **Direct URLs**: Access specific entity/domain combinations via `/realm/{realmId}/{domain}/{entityId}`
- **Mobile Optimization**: Collapsible map interface with touch-friendly controls
- **Plain Language**: AI generates "Not specified in the statute" when answers aren't found
- **Quality Assurance**: Analysis version comparison preserves better content when regenerating
- **Confidence Scoring**: Each answer includes 0-100 confidence score with source references

## Contributing

1. **Data Pipeline**: Data is extracted from configured sources and processed through standardized scripts
2. **Quality Control**: Analysis includes confidence scoring and version comparison for continuous improvement
3. **Extensibility**: New realms/domains can be added by updating `realms.json` and running the extraction pipeline
4. **Transparency**: All processing logic documented in TypeScript with comprehensive error handling
