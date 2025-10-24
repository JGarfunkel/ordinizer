#!/usr/bin/env tsx

import { Pinecone } from "@pinecone-database/pinecone";

const INDEX_NAME = "ordinizer-statutes";
const MUNICIPALITY_ID = "NY-Scarsdale-Town";
const DOMAIN_ID = "trees";

async function clearScarsdaleTrees() {
  try {
    console.log(`🗑️ Clearing Pinecone vectors for ${MUNICIPALITY_ID} ${DOMAIN_ID}...`);
    
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
    
    console.log(`🎯 Deleting vectors with metadata filter: municipalityId=${MUNICIPALITY_ID} AND domainId=${DOMAIN_ID}`);
    
    try {
      // Use metadata filter to delete all matching vectors at once
      await index.deleteMany({
        filter: {
          municipalityId: { $eq: MUNICIPALITY_ID },
          domainId: { $eq: DOMAIN_ID }
        }
      });
      
      console.log(`✅ Successfully deleted all vectors for Scarsdale Trees using metadata filter`);
    } catch (filterError) {
      console.log(`⚠️ Metadata filter approach failed, falling back to prefix deletion...`);
      
      // Fallback to prefix-based deletion with smaller batches
      const prefix = `${MUNICIPALITY_ID}-${DOMAIN_ID}-`;
      console.log(`🎯 Using prefix: ${prefix}`);
      
      const listResponse = await index.listPaginated({ prefix });
      
      if (listResponse.vectors && listResponse.vectors.length > 0) {
        const ids = listResponse.vectors.map(v => v.id!);
        console.log(`📊 Found ${ids.length} vectors to delete`);
        
        // Delete one by one if batches fail
        let deletedCount = 0;
        
        for (const id of ids) {
          try {
            await index.deleteMany({ ids: [id] });
            deletedCount++;
            if (deletedCount % 10 === 0) {
              console.log(`🗑️ Deleted ${deletedCount}/${ids.length} vectors...`);
            }
          } catch (singleDeleteError) {
            console.warn(`⚠️ Failed to delete ${id}:`, singleDeleteError.message);
          }
        }
        
        console.log(`✅ Successfully deleted ${deletedCount}/${ids.length} vectors for Scarsdale Trees`);
      } else {
        console.log(`📭 No vectors found with prefix: ${prefix}`);
        console.log(`💡 This is expected if vectors haven't been indexed yet.`);
      }
    }
    
  } catch (error) {
    console.error(`❌ Error clearing Scarsdale Trees vectors:`, error);
    throw error;
  }
}

// Run the function if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  clearScarsdaleTrees().catch(console.error);
}

export { clearScarsdaleTrees };