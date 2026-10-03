#!/usr/bin/env bash
# One-time setup: lets .github/workflows/release.yml publish every workspace package with npm trusted publishing (OIDC),
# so no npm token is stored anywhere. Packages must already exist on npm.
#
# Run it yourself in a terminal: npm asks for two-factor authentication in the browser. On that page, tick
# "skip two-factor authentication for the next 5 minutes" so the remaining packages go through without asking again.
# Extra arguments are passed to `npm trust github`, for example --dry-run.
# npm allows one trusted publisher per package, so re-running reports already-configured packages as failed.
set -uo pipefail

REPOSITORY="fadnisnikhil/atcn"
WORKFLOW_FILE="release.yml"
ENVIRONMENT="npm"
NPM_VERSION="11.21.0" # `npm trust` needs npm 11.15.0 or later

cd "$(dirname "$0")/.."
npm_dir=$(mktemp -d)
trap 'rm -rf "$npm_dir"' EXIT
npm install --silent --prefix "$npm_dir" "npm@$NPM_VERSION" || exit 1
npm_cli="$npm_dir/node_modules/.bin/npm"

packages=$(node -p "require('./package.json').workspaces.map((dir) => require('./' + dir + '/package.json')).filter((p) => !p.private).map((p) => p.name).join(' ')")
failed=()
for name in $packages; do
  echo "== $name"
  if ! "$npm_cli" trust github "$name" --repo "$REPOSITORY" --file "$WORKFLOW_FILE" --env "$ENVIRONMENT" --allow-publish --yes "$@"; then
    failed+=("$name")
  fi
  sleep 2
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "Not configured: ${failed[*]}"
  exit 1
fi
echo "Trusted publishing is configured for: $packages"
