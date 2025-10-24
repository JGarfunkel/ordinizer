#!/usr/bin/env tsx

import { Pinecone } from "@pinecone-database/pinecone";

const INDEX_NAME = "ordinizer-statutes";

async function deleteIndex() {
  try {
    console.log("🗑️  Deleting Pinecone index to clean up HTML content...");
    
    // Initialize Pinecone client
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
    
    // Check if index exists
    const indexes = await pinecone.listIndexes();
    const indexExists = indexes.indexes?.some(index => index.name === INDEX_NAME);
    
    if (!indexExists) {
      console.log(`✅ Index "${INDEX_NAME}" does not exist. Nothing to delete.`);
      return;
    }
    
    console.log(`📍 Found index "${INDEX_NAME}". Deleting...`);
    
    // Delete the index
    await pinecone.deleteIndex(INDEX_NAME);
    
    console.log(`✅ Successfully deleted index "${INDEX_NAME}"`);
    console.log(`📝 The index will be automatically recreated when analyzeStatutes.ts runs next time.`);
    console.log(`💡 All statute content will be re-indexed with clean text (no HTML).`);
    
  } catch (error) {
    console.error(`❌ Error deleting index:`, error.message);
    process.exit(1);
  }
}

async function deleteVectors(municipality?: string, domain?: string) {
  try {
    // Initialize Pinecone client
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
    
    // Check if index exists
    const indexes = await pinecone.listIndexes();
    const indexExists = indexes.indexes?.some(index => index.name === INDEX_NAME);
    
    if (!indexExists) {
      console.log(`✅ Index "${INDEX_NAME}" does not exist. Nothing to delete.`);
      return;
    }
    
    const index = pinecone.index(INDEX_NAME);
    
    if (!municipality && !domain) {
      console.log("❌ No filters specified. Use --municipality and/or --domain parameters.");
      return;
    }
    
    const filterDescription = [
      municipality ? `municipality: ${municipality}` : null,
      domain ? `domain: ${domain}` : null
    ].filter(Boolean).join(", ");
    
    console.log(`🗑️  Deleting vectors with filters: ${filterDescription}`);
    console.log(`📍 Found index "${INDEX_NAME}". Deleting vectors...`);
    
    let deletedCount = 0;
    
    if (municipality && domain) {
      // Delete specific municipality-domain combination using prefix
      const prefix = `${municipality}-${domain}-`;
      console.log(`🎯 Using prefix: ${prefix}`);
      
      const listResponse = await index.listPaginated({ prefix });
      
      if (listResponse.vectors && listResponse.vectors.length > 0) {
        const ids = listResponse.vectors.map(v => v.id!);
        console.log(`📊 Found ${ids.length} vectors to delete`);
        
        // Delete in small batches to avoid Pinecone API limits
        const batchSize = 10; // Conservative batch size
        deletedCount = 0;
        
        for (let i = 0; i < ids.length; i += batchSize) {
          const batch = ids.slice(i, i + batchSize);
          try {
            await index.deleteMany({ ids: batch });
            deletedCount += batch.length;
            console.log(`🗑️  Deleted batch ${Math.floor(i/batchSize) + 1}: ${batch.length} vectors`);
          } catch (batchError) {
            console.warn(`⚠️ Batch ${Math.floor(i/batchSize) + 1} failed, trying individual deletions...`);
            
            // Try deleting each ID individually
            for (const id of batch) {
              try {
                await index.deleteMany({ ids: [id] });
                deletedCount++;
              } catch (singleError) {
                console.warn(`⚠️ Failed to delete ${id}: ${singleError.message}`);
              }
            }
          }
        }
        
        console.log(`🗑️  Successfully deleted ${deletedCount}/${ids.length} vectors with prefix: ${prefix}`);
      } else {
        console.log(`📭 No vectors found with prefix: ${prefix}`);
      }
    } else if (municipality || domain) {
      // For partial matches, we need to list all vectors and filter
      console.log(`🔍 Searching for vectors matching partial filter...`);
      
      // Get all vectors (this could be slow for large indexes)
      const allVectors = await index.listPaginated();
      
      if (allVectors.vectors && allVectors.vectors.length > 0) {
        const matchingIds: string[] = [];
        
        for (const vector of allVectors.vectors) {
          const id = vector.id!;
          const parts = id.split('-');
          
          // ID format: municipalityId-domainId-chunkIndex
          // For municipality filter: check if ID starts with municipality
          // For domain filter: check if domain appears in the right position
          
          let matches = false;
          
          if (municipality && !domain) {
            // Municipality only: check if ID starts with municipality
            matches = id.startsWith(`${municipality}-`);
          } else if (domain && !municipality) {
            // Domain only: check if domain appears after municipality
            // This is more complex since municipality could contain hyphens
            const domainPattern = new RegExp(`^[^-]+-.*?-${domain}-\\d+$`);
            matches = domainPattern.test(id);
          }
          
          if (matches) {
            matchingIds.push(id);
          }
        }
        
        if (matchingIds.length > 0) {
          console.log(`📊 Found ${matchingIds.length} matching vectors to delete`);
          
          // Delete in small batches to avoid Pinecone API limits
          const batchSize = 10;
          deletedCount = 0;
          
          for (let i = 0; i < matchingIds.length; i += batchSize) {
            const batch = matchingIds.slice(i, i + batchSize);
            try {
              await index.deleteMany({ ids: batch });
              deletedCount += batch.length;
              console.log(`🗑️  Deleted batch ${Math.floor(i/batchSize) + 1}: ${batch.length} vectors`);
            } catch (batchError) {
              console.warn(`⚠️ Batch ${Math.floor(i/batchSize) + 1} failed, trying individual deletions...`);
              
              // Try deleting each ID individually
              for (const id of batch) {
                try {
                  await index.deleteMany({ ids: [id] });
                  deletedCount++;
                } catch (singleError) {
                  console.warn(`⚠️ Failed to delete ${id}: ${singleError.message}`);
                }
              }
            }
          }
          
          console.log(`🗑️  Successfully deleted ${deletedCount}/${matchingIds.length} matching vectors`);
        } else {
          console.log(`📭 No vectors found matching filter: ${filterDescription}`);
        }
      } else {
        console.log(`📭 No vectors found in index`);
      }
    }
    
    console.log(`✅ Successfully deleted ${deletedCount} vectors for: ${filterDescription}`);
    console.log(`📝 Deleted vectors will be recreated when analyzeStatutes.ts runs next time.`);
    
  } catch (error) {
    console.error(`❌ Error deleting vectors:`, error.message);
    process.exit(1);
  }
}

// Show confirmation prompt
function showConfirmation(municipality?: string, domain?: string) {
  if (municipality || domain) {
    const filterDescription = [
      municipality ? `municipality: ${municipality}` : null,
      domain ? `domain: ${domain}` : null
    ].filter(Boolean).join(", ");
    
    console.log(`
⚠️  WARNING: This will delete specific vectors from the Pinecone index.

Index: "${INDEX_NAME}"
Filters: ${filterDescription}
Impact: Matching vectorized statute content will be removed
Recovery: Vectors will be recreated when analyzeStatutes.ts runs

Are you sure you want to proceed? (y/N)`);
  } else {
    console.log(`
⚠️  WARNING: This will delete the entire Pinecone vector database index.

Index to delete: "${INDEX_NAME}"
Impact: All vectorized statute content will be removed
Recovery: Index will be recreated when analyzeStatutes.ts runs

This action is necessary to clean up HTML content that was indexed
before the statute files were converted to plain text.

Are you sure you want to proceed? (y/N)`);
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🗑️  Pinecone Index Management Tool

Deletes vectors from the ordinizer-statutes index. Can delete the entire index
or specific municipality/domain combinations.

Usage:
  tsx scripts/utils/deletePineconeIndex.ts [options]

Options:
  --force, -f              Skip confirmation prompt
  --municipality=<id>      Delete vectors for specific municipality (e.g., NY-DobbsFerry-Village)
  --domain=<id>           Delete vectors for specific domain (e.g., trees)
  --help, -h              Show this help message

Examples:
  tsx scripts/utils/deletePineconeIndex.ts          # Delete entire index (interactive)
  tsx scripts/utils/deletePineconeIndex.ts --force  # Delete entire index (no confirmation)
  tsx scripts/utils/deletePineconeIndex.ts --municipality=NY-DobbsFerry-Village --domain=trees --force
  tsx scripts/utils/deletePineconeIndex.ts --domain=trees  # Delete all vectors for trees domain

Note: Deleted vectors will be recreated when analyzeStatutes.ts runs next.
`);
    process.exit(0);
  }
  
  // Parse municipality and domain filters
  const municipalityArg = args.find(arg => arg.startsWith('--municipality='));
  const domainArg = args.find(arg => arg.startsWith('--domain='));
  
  const municipality = municipalityArg ? municipalityArg.split('=')[1] : undefined;
  const domain = domainArg ? domainArg.split('=')[1] : undefined;
  
  return {
    force: args.includes('--force') || args.includes('-f'),
    municipality,
    domain
  };
}

async function main() {
  const { force, municipality, domain } = parseArgs();
  
  if (!process.env.PINECONE_API_KEY) {
    console.error("❌ PINECONE_API_KEY environment variable not set");
    process.exit(1);
  }
  
  if (!force) {
    showConfirmation(municipality, domain);
    
    // In a script environment, we'll proceed directly since we can't easily handle stdin
    // The user should use --force if they want to skip confirmation
    console.log("\n💡 Use --force flag to skip this confirmation and delete immediately.");
    const exampleParams = municipality || domain ? 
      ` --municipality=${municipality || 'MUNICIPALITY_ID'} --domain=${domain || 'DOMAIN_ID'}` : '';
    console.log(`Example: tsx scripts/utils/deletePineconeIndex.ts --force${exampleParams}`);
    process.exit(0);
  }
  
  if (municipality || domain) {
    await deleteVectors(municipality, domain);
  } else {
    await deleteIndex();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}