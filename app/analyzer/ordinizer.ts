#!/usr/bin/env tsx

import dotenv from "dotenv";
dotenv.config();

const subcommand = process.argv[2];
process.argv.splice(2, 1);

switch (subcommand) {
  case "analyze": {
    const { main } = await import("./lib/analyzeStatutes.js");
    await main();
    break;
  }
  case "index": {
    const { main } = await import("./lib/indexDocumentService.js");
    await main();
    break;
  }
  case "report": {
    const { main } = await import("./lib/domainReport.js");
    await main();
    break;
  }
  case "--help":
  case "-h":
    console.log(`
Usage: ordinizer <subcommand> [options]

Subcommands:
  analyze    Analyze municipal statutes and policies with AI & vector search
  index      Index documents into the Pinecone vector database
  report     Generate a markdown domain report

Common Options (all subcommands):
  --realm <id>              Target realm (or set CURRENT_REALM env var)
  --domain <id>             Scope to a specific domain (e.g., "property-maintenance")
  --entity <id>             Scope to a specific entity (e.g., "NY-Bedford-Town")
  --force                   Force operation even if output already exists
  --dry-run                 Plan without making AI calls or writing files
  --verbose, -v             Enable detailed logging
  --help, -h                Show this help message

─────────────────────────────────────────────────────────────────────
ordinizer analyze
─────────────────────────────────────────────────────────────────────
  --reindex                 Re-upload document chunks to Pinecone
  --fixorder                Fix question order in existing analysis.json files
  --fix-no-sources          Replace "No relevant sources available" with "Not specified" in statutory domains
  --setgrades               Copy grades from metadata.json to analysis.json
  --usemeta                 Compare analysis against meta-analysis best practices
  --questionId <id>         Analyze only the specified question ID (e.g., "9")
  --generate-meta           Generate meta-analysis after completing analysis
  --generate-meta-only      Only generate meta-analysis (skip all entity analysis)
  --generate-questions      Generate questions.json using AI if it doesn't exist
  --skip-recent <time>      Skip if analysis was generated within this window (e.g., "15m", "2h", "1d")
  --model <model>           AI model to use (e.g., gpt-5.4-mini, gpt-5.4, gpt-5.5)

─────────────────────────────────────────────────────────────────────
ordinizer report
─────────────────────────────────────────────────────────────────────
  (no subcommand-specific options — uses --realm and --domain from common options)
  Output: <cwd>/local/report-<domainId>.md

─────────────────────────────────────────────────────────────────────
ordinizer index
─────────────────────────────────────────────────────────────────────
  --list                    List documents currently in the Pinecone index
  --limit <n>               Limit for --list (default: 100)
  --only <type>             Index only "ruleset" or "general" documents
  --prune                   Delete vector chunks for entries with status=unrelated or status=index

Environment Variables Required:
  OPENAI_API_KEY            OpenAI API key for AI and embeddings
  PINECONE_API_KEY          Pinecone API key
`.trim());
    process.exit(0);
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand ?? "(none provided)"}`);
    console.error("Run with --help to see available subcommands.");
    process.exit(1);
}
