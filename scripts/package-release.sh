#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
release_version="$(node -p 'require("./package.json").version')"
if [[ ! "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  echo 'Invalid release version' >&2
  exit 1
fi
npm run build
mkdir -p artifacts
release_stage="$(mktemp -d)"
trap 'rm -r -- "$release_stage"' EXIT
release_name="express-web-$release_version-runtime"
mkdir -p "$release_stage/$release_name/packages"
cp package.json package-lock.json README.md LICENSE NOTICE CHANGELOG.md SECURITY.md .env.example "$release_stage/$release_name/"
cp -a docs deploy scripts "$release_stage/$release_name/"
for workspace in shared server web; do
  mkdir -p "$release_stage/$release_name/packages/$workspace"
  cp "packages/$workspace/package.json" "$release_stage/$release_name/packages/$workspace/"
  cp -a "packages/$workspace/dist" "$release_stage/$release_name/packages/$workspace/"
done
cp -a packages/server/migrations "$release_stage/$release_name/packages/server/"
tar -czf "artifacts/$release_name.tar.gz" -C "$release_stage" "$release_name"
echo "Created artifacts/$release_name.tar.gz"
