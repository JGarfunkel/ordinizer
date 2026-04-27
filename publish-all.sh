#!/bin/bash
# Exit on any error
set -e

# List your subdirectories in order of dependency
PACKAGES=("packages/core" "packages/servercore" "apps/analyzer" "apps/client" "apps/server")

for PKG in "${PACKAGES[@]}"; do
  echo "Processing $PKG..."
  pushd $PKG > /dev/null
  
  # 1. Increment version (patch = 0.0.1 -> 0.0.2)
  npm version patch --no-git-tag-version
  
  # 2. Build the package
  npm run build
  
  # 3. Publish to Artifact Registry
  npm publish
  
  popd > /dev/null
  echo "Successfully published $PKG"
done
