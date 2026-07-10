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
  case "spider": {
    const { main } = await import("./lib/spiderEntityWebsites.js");
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
  case "describe": {
    const { main } = await import("./lib/describe.js");
    await main();
    break;
  }
  case "build-sources": {
    const { main } = await import("./lib/buildSources.js");
    await main();
    break;
  }
  case "--help":
  case "-h":
    console.log(`
Usage: ordinizer <subcommand> [options]

Subcommands:
  describe       Show what exists in the data directory and suggest next steps
  spider         Crawl entity websites and download domain-relevant documents
  index          Index downloaded documents into the Pinecone vector database
  analyze        Analyze entities with AI using indexed documents
  report         Generate a markdown domain report
  build-sources  Extract URL/title pairs from EntityDownloads into sources.json

Common Options (all subcommands):
  --realm <id>              Target realm (or set CURRENT_REALM env var)
  --domain <id>             Scope to a specific domain (e.g., "property-maintenance")
  --entity <id>             Scope to a specific entity (e.g., "NY-Bedford-Town")
  --force                   Force operation even if output already exists
  --dry-run                 Plan without making AI calls or writing files
  --verbose, -v             Enable detailed logging
  --help, -h                Show this help message

─────────────────────────────────────────────────────────────────────
ordinizer describe
─────────────────────────────────────────────────────────────────────
  --realm <id>              Scope to a specific realm (default: all realms)
  --domain <id>             Scope to a specific domain
  --websites                Show website boilerplate/selector status per host
  --missing                 (with --websites) Show only hosts missing contentSelector
  --entity <id>             (with --websites) Scope to a single entity

─────────────────────────────────────────────────────────────────────
ordinizer spider
─────────────────────────────────────────────────────────────────────
  --entity <id>             Crawl a single entity by ID
  --all                     Crawl all entities in the realm
  --domain <id>             Restrict classification to one domain
  --max-depth <n>           Maximum crawl depth, 1–3 (default: 2)
  --max-pages <n>           Total page cap (default: 3× per-source limit)
  --concurrency <n>         Parallel fetch concurrency, 1–20 (default: 3)
  --recrawl-days <n>        Re-fetch pages older than N days
  --force                   Force re-crawl even if recently visited
  --nodownload              Score existing cached pages without fetching
  --interactive             Prompt for domain confirmation per page
  --review                  Show summary table and review interactively
  --scan, --nospider        Re-score downloaded pages without fetching
  --rewriteText             Re-generate .txt artifacts from cached HTML; discovers missing contentSelector/header/footer selectors
  --rewriteText --force     Also reset and re-discover all selector data from scratch
  --listlocal               List locally downloaded files for each entity
  --generate-summary        Write a summary JSON across all entities

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
    console.error("Run \"ordinizer describe\" for a data overview, or --help for all subcommands.");
    process.exit(1);
}
