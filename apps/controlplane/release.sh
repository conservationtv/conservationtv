#!/usr/bin/env bash
# Migrates gatekeeper's database, uploads gatekeeper as a Worker version tagged with the current commit, then routes its
# traffic to that version. Migrations must stay compatible with the version still serving until the deployment switches.
# Run with the Pulumi credentials from the repository root: `op run --env-file=.env.pulumi -- apps/controlplane/release.sh prod`.
set -euo pipefail

stack=${1:?usage: release.sh <stack>}
here=$(cd "$(dirname "$0")" && pwd)
git -C "$here" diff --quiet HEAD || { echo 'Commit your changes first: the version is tagged with the commit' >&2; exit 1; }
tag=$(git -C "$here" rev-parse HEAD)

DATABASE_URL=$(pulumi -C "$here/infrastructure" stack output gatekeeperMigrationUrl --show-secrets --stack "$stack") \
  pnpm --dir "$here/gatekeeper" run db:migrate

secrets=$(mktemp)
trap 'rm -f "$secrets"' EXIT
pulumi -C "$here/infrastructure" stack output gatekeeperSecrets --json --show-secrets --stack "$stack" > "$secrets"
STACK_OUTPUT_JSON=$(pulumi -C "$here/infrastructure" stack output --json --stack "$stack") \
  pnpm --dir "$here/gatekeeper" run upload --tag "$tag" --message "gatekeeper $tag" --secrets-file "$secrets"

pulumi -C "$here/infrastructure" up --stack "$stack" --config "gatekeeperVersion=$tag"
