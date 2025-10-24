# Ordinizer Scripts Documentation

## Core Production Scripts (3 scripts total)

### `extractFromGoogleSheets.ts`
**Purpose**: Downloads municipality and domain data from WEN Google Sheets  
**Usage**: `tsx extractFromGoogleSheets.ts [--domain <domain-name>] [--force]`
**Features**:
- Downloads statute files from spreadsheet URLs
- Only re-downloads if >30 days old or `--force` specified  
- Creates metadata.json with source URLs and timestamps
- Handles all domains: trees, property-maintenance, glb, wetlands, etc.

### `analyzeStatutes.ts` 
**Purpose**: Generates AI analysis for statutes using vector search
**Usage**: `tsx analyzeStatutes.ts [--domain <domain>] [--municipality <id>] [--force]`
**Features**:
- Auto-generates domain questions if missing
- Vector analysis using Pinecone + OpenAI
- Only processes if analysis missing, >30 days old, or `--force`
- Handles state codes vs local ordinances correctly
- Smart incremental processing

### `fetchAnswers.ts`
**Purpose**: CLI utility for querying specific municipality/domain analysis
**Usage**: `tsx fetchAnswers.ts -m <municipality> -d <domain> -t <topic> [-v]`
**Features**:
- Case-insensitive search for municipalities and domains
- Topic-based filtering of questions/answers
- Verbose mode for detailed output
- Quick lookup tool for development/testing

## Utility Scripts (Single-use/Development)

### `utils/regeneratePropertyMaintenanceAnalysis.ts`
- One-time script to fix Property Maintenance state vs local code detection
- Moved to utils as it was single-use for migration

### `utils/generateLocalPropertyMaintenanceAnalysis.ts`  
- Development script for testing vector analysis on local ordinances
- Moved to utils as functionality integrated into main analyzeStatutes.ts

### `utils/generateVectorBasedPropertyAnalysis.ts`
- Legacy script for Property Maintenance vector generation
- Replaced by unified analyzeStatutes.ts approach

## Moved to utils/ (50+ scripts)

**Analysis Scripts**: analyzeDomain.ts, analyzePropertyMaintenance.ts, analyzeTreeStatutes.ts, etc.
**Data Processing**: cleanHtmlToText.ts, convertHtmlToText.ts, fixMunicipalities.ts, etc.  
**Testing/Debug**: test-property-analysis.ts, debugGoogleSheets.ts, inspectWENData.ts, etc.
**One-time Migration**: regeneratePropertyMaintenanceAnalysis.ts, restoreWENGrades.ts, etc.

## Recommended Workflow

1. **Data Download**: `tsx extractFromGoogleSheets.ts` (runs automatically on schedule)
2. **Analysis Generation**: `tsx analyzeStatutes.ts` (runs automatically for new/updated statutes)
3. **Force Refresh**: Add `--force` to either script to bypass age checks

## Environment Variables Required

- `GOOGLE_SHEETS_API_KEY`: For accessing WEN spreadsheet data
- `PINECONE_API_KEY`: For vector database operations  
- `OPENAI_API_KEY`: For AI-powered statute analysis
- `WEN_SPREADSHEET_URL`: Source spreadsheet with municipality data