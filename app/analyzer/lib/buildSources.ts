/**
 * buildSources — extract URL/title pairs from EntityDownloads history files
 * and write a compact data/<realmid>/sources.json for use by the server.
 *
 * Usage:
 *   ordinizer build-sources [--realm <id>] [--entity <id>]
 */

import { getDefaultStorage } from "@civillyengaged/ordinizer-servercore";
import { parseCommonCliArgs } from "./scriptArgs.js";

export async function main() {
  const { common } = parseCommonCliArgs(process.argv.slice(2));

  if (!common.realm) {
    console.error("Error: --realm <id> is required (or set CURRENT_REALM env var)");
    process.exit(1);
  }

  const storage = getDefaultStorage(common.realm);

  if (common.entity) {
    await storage.updateEntitySources(common.entity);
    console.log(`✅ sources.json updated for entity: ${common.entity}`);
  } else {
    await storage.buildAllSources();
    console.log(`✅ sources.json built for realm: ${common.realm}`);
  }
}
