#!/usr/bin/env node
/**
 * switch-deps.js
 *
 * Switches all @civillyengaged dependencies in package.json files between local file: paths and npm release versions.
 * Usage: node switch-deps.js [local|release] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MODE = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');

if (!['local', 'release'].includes(MODE)) {
  console.error('Usage: node switch-deps.js [local|release] [--dry-run]');
  process.exit(1);
}

// List of all package.json files to update
const packages = [
  'app/analyzer',
  'app/client',
  'app/server',
  'packages/servercore',
];

// Map of package name to relative path from each consumer
const localPaths = {
  '@civillyengaged/ordinizer-core': '../core',
  '@civillyengaged/ordinizer-client': '../client',
  '@civillyengaged/ordinizer-servercore': '../../packages/servercore',
};

function getReleaseVersion(pkgPath) {
  const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return pkgJson.version;
}

function updateDeps(deps, pkgDir, mode) {
  let changed = false;
  for (const dep in deps) {
    if (dep.startsWith('@civillyengaged/')) {
      if (mode === 'local') {
        const relPath = localPaths[dep];
        if (relPath && deps[dep] !== `file:${relPath}`) {
          deps[dep] = `file:${relPath}`;
          changed = true;
        }
      } else if (mode === 'release') {
        // Find the actual package.json for this dep
        let depPath;
        if (dep === '@civillyengaged/ordinizer-core') depPath = path.join(__dirname, 'packages/core/package.json');
        else if (dep === '@civillyengaged/ordinizer-client') depPath = path.join(__dirname, 'app/client/package.json');
        else if (dep === '@civillyengaged/ordinizer-servercore') depPath = path.join(__dirname, 'packages/servercore/package.json');
        else continue;
        const version = getReleaseVersion(depPath);
        if (deps[dep] !== version) {
          deps[dep] = version;
          changed = true;
        }
      }
    }
  }
  return changed;
}

for (const pkg of packages) {
  const pkgDir = path.join(__dirname, pkg);
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) continue;
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  let changed = false;
  if (pkgJson.dependencies) {
    changed = updateDeps(pkgJson.dependencies, pkgDir, MODE) || changed;
  }
  // Optionally: update devDependencies/peerDependencies as well
  if (changed) {
    if (DRY_RUN) {
      console.log(`[DRY RUN] Would update ${pkgJsonPath}`);
    } else {
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
      console.log(`Updated ${pkgJsonPath}`);
      // Run npm install to update package-lock.json
      try {
        execSync('npm install', { cwd: pkgDir, stdio: 'inherit' });
      } catch (e) {
        console.error(`npm install failed in ${pkgDir}`);
      }
    }
  }
}

console.log('Dependency switching complete.');
