export interface CommonCliOptions {
  dataRoot?: string;
  realm?: string;
  domain?: string;
  entity?: string;
  notbot: boolean;
  force: boolean;
  dryRun: boolean;
}

export interface ParsedCommonCli {
  common: CommonCliOptions;
  rest: string[];
}

export function parseCommonCliArgs(args: string[]): ParsedCommonCli {
  const common: CommonCliOptions = {
    notbot: false,
    force: false,
    dryRun: false,
  };

  const rest: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--data-root") {
      common.dataRoot = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--realm") {
      common.realm = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--domain" || arg === "--domain-id") {
      common.domain = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--entity") {
      common.entity = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--force") {
      common.force = true;
      continue;
    }

    if (arg === "--notbot") {
      common.notbot = true;
      process.env.NOTBOT = "1";
      continue;
    }

    if (arg === "--dry-run") {
      common.dryRun = true;
      continue;
    }

    rest.push(arg);
  }

  if (!common.realm && process.env.CURRENT_REALM) {
    common.realm = process.env.CURRENT_REALM;
  }

  if (!common.dataRoot && process.env.DATA_ROOT) {
    common.dataRoot = process.env.DATA_ROOT;
  }

  return { common, rest };
}

export function requireDataRootAndRealm(common: CommonCliOptions): asserts common is CommonCliOptions & { dataRoot: string; realm: string } {
  if (!common.dataRoot) {
    throw new Error("Missing required argument: --data-root <path>");
  }

  if (!common.realm) {
    throw new Error("Missing required realm. Provide --realm <realm-id> or set CURRENT_REALM.");
  }
}
