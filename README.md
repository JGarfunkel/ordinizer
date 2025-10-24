# Ordinizer - Municipal Statute Analysis Platform

Ordinizer is a comprehensive TypeScript-based municipal statute analysis platform that extracts, analyzes, and presents legal differences across Westchester County municipalities using advanced geospatial and text processing technologies.

## Features

- **Advanced Municipality Mapping**: Interactive GeoJSON-powered municipal boundary mapping with mobile-optimized interface
- **Vector-Based Analysis**: Pinecone vector search for statute indexing and retrieval with 60-95% confidence scores
- **Multiple Domain Support**: Trees, Gas Leaf Blowers (GLB), Wetland Protection, Dark Sky, Property Maintenance, Cluster Zoning, Solar, Slopes, and more
- **AI-Powered Q&A Generation**: Uses OpenAI GPT-4o to generate plain-language questions and answers from complex statute content
- **Smart Data Processing**: Automated HTML to plain text conversion with source preservation
- **Incremental Processing**: Only downloads/analyzes if files are missing, >30 days old, or forced
- **Quality Scoring**: Analysis version comparison to preserve better content when regenerating
- **File-Based Storage**: All data stored as JSON files for easy version control and transparency
- **Modern Web Interface**: React + TypeScript frontend with shadcn/ui components and mobile-friendly design

## Quick Start

### 1. Set up API Keys

The application requires API keys for external services:

1. **OpenAI API Key** (required for AI analysis):
   - Go to https://platform.openai.com
   - Create an account and get an API key
   - Add as `OPENAI_API_KEY` in Replit environment secrets

2. **Google Sheets API Key** (optional, for WEN data extraction):
   - Enable Google Sheets API in Google Cloud Console
   - Add as `GOOGLE_SHEETS_API_KEY` in Replit environment secrets

3. **Pinecone API Key** (optional, for vector analysis):
   - Create account at https://pinecone.io
   - Add as `PINECONE_API_KEY` in Replit environment secrets

### 2. Extract Municipality Data

Extract municipality and statute data from the WEN (Westchester Environmental Network) spreadsheet:

```bash
# Extract all domains with smart incremental processing (uses WEN_SPREADSHEET_URL env variable)
tsx ordinizer/scripts/extractFromGoogleSheets.ts

# Extract specific domain
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain="Property Maintenance"

# Extract with verbose logging
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain=Trees --verbose

# Extract with municipality filter
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain=Trees --municipality-filter="Ardsley,Bedford,Bronxville"
```

This will:
- Create `data/municipalities.json` with all municipalities including singular names for URL routing
- Create `data/domains.json` with statute domains
- Download statute files to `data/{domain}/NY-{Municipality}-{Type}/statute.txt`
- Create metadata files with download information and grades from WEN data
- Handle both hyperlinked URLs and direct text URLs from spreadsheet cells

### 3. Generate AI Analysis

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

# Fix question order in existing analysis files
tsx ordinizer/scripts/analyzeStatutes.ts --domain trees --fixorder

# Analyze specific municipalities only
tsx ordinizer/scripts/analyzeStatutes.ts --domain trees --municipality-filter="Ardsley,Bedford"

# Generate gap analysis for municipalities with scores below 1.0
tsx ordinizer/scripts/utils/generateGapAnalysis.ts --domain trees --verbose

# Create meta-analysis with best practices and common gaps (standalone)
tsx ordinizer/scripts/utils/createMetaAnalysis.ts --domain trees

# Generate analysis AND meta-analysis in one command
tsx ordinizer/scripts/analyzeStatutes.ts --domain trees --generate-meta

```

### 4. Run the Web Application

```bash
npm run dev
```

The application will be available at the provided URL with:
- Interactive map interface with municipality boundaries
- URL routing like `/trees/NY-Ardsley` for direct access
- Mobile-optimized interface with collapsible map functionality

## Script Architecture

The project uses a streamlined script architecture with two main production scripts.

**Library-Style Usage**: All scripts are referenced as a library from the `ordinizer/` directory. Run scripts using `tsx ordinizer/scripts/<script-name>.ts` from the project root, which allows the scripts to properly access the ordinizer library modules and maintain proper encapsulation.

### Main Production Scripts

#### 1. `extractFromGoogleSheets.ts` - Data Extraction & Statute Download
The primary data extraction script that handles the complete pipeline:

```bash
# Basic usage - extracts all domains (uses WEN_SPREADSHEET_URL env variable)
tsx ordinizer/scripts/extractFromGoogleSheets.ts

# Extract specific domain
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain="Property Maintenance"

# Extract with verbose logging
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain="Property Maintenance" --verbose

# Filter by municipalities
tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain=Trees --municipality-filter="Ardsley,Bedford"

# Using specific spreadsheet URL  
tsx ordinizer/scripts/extractFromGoogleSheets.ts "https://docs.google.com/spreadsheets/d/SHEET_ID" --domain=Trees
```

**Features:**
- Smart URL extraction (prioritizes cell content over generic hyperlinks)
- Respects server rate limits (5-second delays between downloads)
- Creates municipalities.json and domains.json files
- Downloads statute content with HTML preservation option
- Handles WEN grading system (G-, R-, Y-, X- prefixes)
- Generates metadata with download timestamps and source URLs
- Verbose logging mode (`--verbose` or `-v`) for HTTP debugging
- Municipality filtering (`--municipality-filter="name1,name2"`) for targeted extraction
- **Intelligent parameter validation** with typo suggestions using Levenshtein distance algorithm
- Protected municipality database updates (skips when using filters to prevent corruption)

#### 2. `analyzeStatutes.ts` - AI Analysis Generation
Generates AI-powered Q&A analysis using OpenAI and optional Pinecone vector processing:

```bash
# Analyze all domains and municipalities
tsx ordinizer/scripts/analyzeStatutes.ts

# Process specific domain with verbose logging
tsx ordinizer/scripts/analyzeStatutes.ts --domain property-maintenance --verbose

# Force re-analysis of specific municipality
tsx ordinizer/scripts/analyzeStatutes.ts --municipality NY-Bedford-Town --force

# Regenerate scores only without AI analysis (fast)
tsx ordinizer/scripts/analyzeStatutes.ts --generateScoreOnly --domain trees

# Show available options and help
tsx ordinizer/scripts/analyzeStatutes.ts --help
```

**Features:**
- Generates domain-specific questions if missing
- Creates confidence-scored Q&A analysis using OpenAI GPT-4o and Pinecone vector search
- Implements incremental processing (only analyzes new/missing questions)
- Quality preservation (keeps better analysis when regenerating)
- Handles corrupted statute detection and state code references
- **Verbose logging** (`--verbose` or `-v`) shows detailed processing steps, API calls, vector scores, and confidence calculations

### Specialized Utility Scripts

Additional scripts for specific maintenance tasks:

- `cleanupNYStateFiles.ts` - Remove incorrectly downloaded NY State Property Maintenance Code files
- `reconvertHtmlToText.ts` - Re-convert statute HTML files to proper plain text using improved conversion logic
- `cleanupDuplicateDirectories.ts` - Remove duplicate municipality directories with incorrect naming (HastingsonHudson/CrotononHudson variants)
- `removeLoginPromptFiles.ts` - Remove statute files containing "Request a Municipal Login" text instead of actual content
- `clearCorruptionFlags.ts` - Remove corruption markers from analysis files
- `redownloadCorruptedStatutes.ts` - Re-attempt downloads for failed municipalities  
- `testSpreadsheetExtraction.ts` - Test URL extraction logic without downloading
- `readSpreadsheetUrls.ts` - Debug spreadsheet URL parsing
- `runFullExtractionWithCorrectUrls.ts` - Comprehensive extraction wrapper

#### Cleanup Utility

Remove statute files that contain generic NY State Property Maintenance Code instead of municipality-specific ordinances:

```bash
# Preview what would be deleted (recommended first)
tsx ordinizer/scripts/cleanupNYStateFiles.ts --dry-run --verbose

# Actually delete the incorrect files
tsx ordinizer/scripts/cleanupNYStateFiles.ts

# Show help
tsx ordinizer/scripts/cleanupNYStateFiles.ts --help
```

**Target Pattern**: Files starting with `<!DOCTYPE html><html><head><meta charSet="UTF-8"/><title>New York State Property Maintenance Code 2020`

#### HTML Reconversion Utility

Re-convert existing statute.html files to proper plain text using improved conversion logic:

```bash
# Preview what would be reconverted
tsx ordinizer/scripts/reconvertHtmlToText.ts --dry-run --verbose

# Actually reconvert the files
tsx ordinizer/scripts/reconvertHtmlToText.ts

# Filter by municipality
tsx ordinizer/scripts/reconvertHtmlToText.ts --municipality-filter=Bedford
```

**Detection Logic**: Identifies files where statute.txt contains raw HTML instead of converted text, or where conversion ratios suggest failed processing.

#### Duplicate Directory Cleanup

Remove incorrectly named municipality directories that duplicate properly named versions:

```bash
# Preview what would be removed
tsx ordinizer/scripts/cleanupDuplicateDirectories.ts --dry-run

# Actually remove the duplicate directories
tsx ordinizer/scripts/cleanupDuplicateDirectories.ts
```

**Target Pattern**: Removes HastingsonHudson-Village and CrotononHudson-Village in favor of Hastings-on-Hudson-Village and Croton-on-Hudson-Village

#### Login Prompt File Cleanup

Remove statute files that contain login prompts instead of actual content:

```bash
# Preview what would be removed
tsx ordinizer/scripts/removeLoginPromptFiles.ts --dry-run

# Actually remove the login prompt files
tsx ordinizer/scripts/removeLoginPromptFiles.ts --verbose

# Show help and options
tsx ordinizer/scripts/removeLoginPromptFiles.ts --help
```

**Target Pattern**: Removes files containing "Request a Municipal Login" text from eCode360 sites requiring authentication

#### Municipality Recovery Utility

Emergency utility to regenerate municipalities.json from existing data directories:

```bash
# Regenerate the complete municipality list
tsx ordinizer/scripts/regenerateMunicipalities.ts
```

**Purpose**: Recovers from critical data loss by scanning all domain directories and reconstructing the municipality database. Automatically handles duplicate detection for naming variations while preserving legitimate separate municipalities.

### Legacy Scripts (utils/ directory)

50+ specialized scripts moved to `utils/` directory for historical reference and specific tasks. These handle individual domain processing, data migration, and debugging scenarios.

## Object Types and Storage

The system uses a comprehensive object-oriented data model with file-based storage:

### Core Object Types

| Object Type | Storage Location | Description |
|-------------|------------------|-------------|
| **Municipality** | `data/municipalities.json` | Municipal entity definitions with IDs, names, types, and URL routing data |
| **Domain** | `data/domains.json` | Statute domain definitions (Trees, Property Maintenance, etc.) |
| **Statute Text** | `data/{domain}/NY-{Municipality}-{Type}/statute.txt` | Plain text municipal statute content |
| **Statute HTML** | `data/{domain}/NY-{Municipality}-{Type}/statute.html` | Original HTML source (optional, when KEEP_STATUTE_SOURCE_HTML=true) |
| **Metadata** | `data/{domain}/NY-{Municipality}-{Type}/metadata.json` | Download metadata with WEN grades, URLs, timestamps |
| **Analysis** | `data/{domain}/NY-{Municipality}-{Type}/analysis.json` | AI-generated Q&A with confidence scores and grades map |
| **Questions** | `data/{domain}/questions.json` | Domain-specific question templates for AI analysis |
| **GeoJSON Boundaries** | `client/src/assets/westchester-boundaries.geojson` | Municipal boundary data for map visualization |

### Object Relationships

```
Municipality (1) ←→ (Many) Domain
    ↓
Domain (1) ←→ (Many) Statute Text
    ↓
Statute Text (1) ←→ (1) Metadata
    ↓
Statute Text (1) ←→ (1) Analysis
    ↓
Domain (1) ←→ (1) Questions
```

### Data Storage Structure

The system uses a comprehensive file-based data structure:

```
data/
├── municipalities.json          # All municipality definitions with singular names for URLs
├── domains.json                # All domain definitions with display names
├── property-maintenance/        # Property Maintenance domain (39 municipalities)
│   ├── questions.json          # AI-generated questions for domain
│   ├── NY-Ardsley-Village/
│   │   ├── statute.txt         # Plain text statute content
│   │   ├── statute.html        # Original HTML (if KEEP_STATUTE_SOURCE_HTML=true)
│   │   ├── metadata.json       # Download metadata with grades and URLs
│   │   └── analysis.json       # AI-generated Q&A with confidence scores
│   ├── NY-Bedford-Town/
│   └── [37 other municipalities...]
├── trees/                      # Tree domain
│   ├── questions.json
│   └── [municipality directories...]
├── glb/                        # Gas Leaf Blowers domain
├── wetland-protection/         # Wetland Protection domain  
├── dark-sky/                   # Dark Sky domain
├── cluster-zoning/             # Cluster Zoning domain
├── solar-1/                    # Solar domain
├── slopes/                     # Slopes domain
└── [other domains...]
```

**Key Features:**
- **Naming Convention**: All directories use kebab-case (e.g., `property-maintenance` not `property maintenance`)
- **Municipality IDs**: Follow pattern `NY-{Name}-{Type}` (e.g., `NY-Ardsley-Village`, `NY-Bedford-Town`)
- **URL Routing**: Uses `singular` attribute from municipalities.json for clean URLs (`/trees/NY-Ardsley`)
- **Metadata Tracking**: Each download includes timestamp, source URL, and WEN grading information
- **Version Control Friendly**: All JSON files formatted with consistent spacing

## WEN Spreadsheet Integration

The system integrates with the Westchester Environmental Network (WEN) ordinance library:

**Spreadsheet Structure:**
- **Source**: "Ordinances" tab starting from Row 2
- **Columns**: Municipality, Type, Trees, GLB, Wetland Protection, Dark Sky, Property Maintenance, etc.
- **URL Handling**: Prioritizes cell content URLs over generic hyperlinks
- **Grading System**: G- (Good), R- (Red), Y- (Yellow), X- (various conditions)

**Smart URL Extraction:**
```javascript
// When hyperlink is generic (https://ecode360.com/) but cell contains full URL:
// "G- https://ecode360.com/15780159" -> uses https://ecode360.com/15780159
// Handles data entry inconsistencies automatically
```

**Example Municipal Entry:**
```
Municipality: Ardsley  
Type: Village  
Trees: G- https://ecode360.com/7695873  
Property Maintenance: R-https://ecode360.com/15780159  
Wetland Protection: [empty - not applicable]
```

## API Endpoints

The application provides comprehensive REST API endpoints:

### Core Data
- `GET /api/municipalities` - List all municipalities with singular names
- `GET /api/domains` - List all domains with display names  
- `GET /api/municipalities/:id/domains` - Get available domains for municipality
- `GET /api/westchester-boundaries` - GeoJSON municipal boundaries for map

### Analysis & Content  
- `GET /api/analyses/:municipalityId/:domainId` - Get AI-generated Q&A analysis
- `GET /api/statute-metadata/:domainId/:municipalityId` - Get statute metadata (grades, URLs, timestamps)
- `GET /api/section-url/:domainId/:municipalityId/:section` - Get direct links to statute sections

### Data Status
- Municipality coverage varies by domain (e.g., Property Maintenance: 39 municipalities, Trees: 45+ municipalities)
- Analysis includes confidence scores (0-100) and source references
- State code municipalities return appropriate "uses state code" responses

## Development

### Technology Stack
- **Frontend**: React 18 + TypeScript + Vite + shadcn/ui components + Tailwind CSS
- **Backend**: Express.js + TypeScript with hot reloading via tsx
- **Storage**: File-based JSON with fs-extra + Drizzle ORM (configured but using JSON storage)
- **AI Processing**: OpenAI GPT-4o for question generation and statute analysis
- **Vector Search**: Pinecone integration for enhanced statute analysis (optional)
- **Mapping**: Leaflet + react-leaflet with GeoJSON municipal boundaries
- **State Management**: TanStack Query (React Query) for server state and caching
- **Routing**: Wouter for lightweight client-side routing

### Project Structure

```
client/src/          # React frontend with shadcn/ui components
├── components/      # Reusable UI components
├── pages/          # Route components (home.tsx, not-found.tsx)
├── hooks/          # Custom React hooks
└── lib/            # Utilities and query client setup

server/             # Express.js backend
├── index.ts        # Main server entry point
├── routes.ts       # API endpoint definitions  
├── storage.ts      # File-based storage interface
└── vite.ts         # Vite middleware integration

ordinizer/          # Ordinizer library (scripts and core modules)
├── scripts/        # Data processing pipeline scripts
│   ├── extractFromGoogleSheets.ts    # Main extraction script
│   ├── analyzeStatutes.ts           # Main analysis script
│   └── utils/      # 50+ specialized utility scripts
├── src/            # Core library modules
│   ├── adapters/   # Data adapters (FileDataAdapter, etc.)
│   ├── types.ts    # Type definitions
│   └── scoring.ts  # Score calculation logic
└── app/            # Web application server
    └── server/     # Realm-aware API routes

shared/             # Shared TypeScript types and schemas
samplesite/data/    # Sample data for westchester-municipal-environmental realm
```

### Environment Variables
- `OPENAI_API_KEY` - Required for AI analysis
- `GOOGLE_SHEETS_API_KEY` - Required for WEN data extraction from Google Sheets API
- `PINECONE_API_KEY` - Optional for vector analysis
- `WEN_SPREADSHEET_URL` - WEN ordinance library spreadsheet URL (has default fallback)
- `KEEP_STATUTE_SOURCE_HTML` - Set to 'true' to preserve original HTML files

**Important Notes**:
- The `GOOGLE_SHEETS_API_KEY` is required for the extraction script to work properly. Without it, the script will fail to access the WEN spreadsheet data.
- The script uses the WEN spreadsheet URL from `WEN_SPREADSHEET_URL` environment variable, or falls back to the default WEN ordinance library spreadsheet.
- Both the main `processSpreadsheetData` function and the analysis phase require the Google Sheets API key to function.

## Troubleshooting

### Common Issues

1. **Missing Google Sheets API Key**: If you get "GOOGLE_SHEETS_API_KEY environment variable is required" error:
   ```bash
   # The script requires a Google Sheets API key to access WEN data
   # Get an API key from Google Cloud Console and add it to Replit secrets
   Error: GOOGLE_SHEETS_API_KEY environment variable is required
   ```
   **Solution**: Add your Google Sheets API key to Replit environment secrets as `GOOGLE_SHEETS_API_KEY`

2. **WEN Spreadsheet Access**: Ensure the WEN spreadsheet URL is accessible. The script uses a default URL but you can override with `WEN_SPREADSHEET_URL`

3. **OpenAI API Errors**: Verify your API key is correctly set in Replit environment secrets. Check usage quotas at https://platform.openai.com

4. **eCode360 Download Failures**: Some municipalities are blocked by anti-bot protection (returns 403 Forbidden). The script identifies correct URLs but manual download may be required:
   ```bash
   # Check which municipalities need manual intervention
   cd data/property-maintenance && find . -name "CORRUPTED_STATUTE.flag"
   ```

5. **Incorrect Domain Names**: Use exact domain names with proper capitalization:
   ```bash
   # Correct: 
   tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain="Property Maintenance"
   # Wrong:
   tsx ordinizer/scripts/extractFromGoogleSheets.ts --domain=property-maintenance
   ```

6. **Analysis Generation Timeouts**: Large statute files may timeout during analysis. Use municipality filters to process smaller batches:
   ```bash
   tsx ordinizer/scripts/analyzeStatutes.ts --domain property-maintenance --municipality-filter="Ardsley,Bedford"
   ```

7. **Missing Analysis Files**: If analysis.json files are missing, regenerate them:
   ```bash
   tsx ordinizer/scripts/analyzeStatutes.ts --domain DOMAIN_NAME --force
   ```

### Data Status & Debugging

Check current coverage and identify issues:

```bash
# Count analysis files by domain
cd data && find . -name "analysis.json" | cut -d'/' -f2 | sort | uniq -c

# Check for municipalities with working Q&A
cd data/property-maintenance && find . -name "analysis.json" -exec grep -l '"questions":\s*\[{' {} \;

# Identify corrupted statute files
cd data && find . -name "CORRUPTED_STATUTE.flag"

# Test URL extraction without downloading
tsx ordinizer/scripts/testSpreadsheetExtraction.ts
```

### Performance Optimization

- **Incremental Processing**: Scripts only process missing/old files unless `--force` is specified
- **Rate Limiting**: 5-second delays between downloads to respect server limits  
- **Smart Caching**: Analysis reuses existing questions when statute files are current
- **Vector Chunking**: Large statutes processed in chunks for better AI analysis accuracy

## Current Domain Coverage

As of August 2025, the system supports these domains with varying municipality coverage:

- **Property Maintenance**: 39 municipalities (87% with full analysis, 13% blocked by anti-bot protection)
- **Trees**: 45+ municipalities with comprehensive ordinance coverage
- **Gas Leaf Blowers (GLB)**: Extracted from noise ordinances with specific GLB focus
- **Wetland Protection**: Environmental protection ordinances  
- **Dark Sky**: Light pollution and outdoor lighting regulations
- **Cluster Zoning**: Planned development and clustering regulations
- **Solar**: Solar installation and renewable energy ordinances
- **Slopes**: Steep slope protection and erosion control

## User Experience Features

- **Direct URLs**: Access specific municipality/domain combinations via `/trees/NY-Ardsley`
- **Mobile Optimization**: Collapsible map interface with touch-friendly controls
- **Plain Language**: AI generates "Not specified in the statute" when answers aren't found
- **Quality Assurance**: Analysis version comparison preserves better content when regenerating
- **Confidence Scoring**: Each answer includes 0-100 confidence score with source references

## Contributing

1. **Data Pipeline**: All data generated from WEN spreadsheet and processed through standardized scripts
2. **Quality Control**: Analysis includes confidence scoring and version comparison for continuous improvement  
3. **Extensibility**: New domains can be added by updating WEN spreadsheet and running extraction pipeline
4. **Transparency**: All processing logic documented in TypeScript with comprehensive error handling
5. **Version Control**: JSON-based storage makes all changes trackable and reviewable

## License

MIT License - see LICENSE file for details.