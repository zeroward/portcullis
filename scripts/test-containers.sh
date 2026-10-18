#!/usr/bin/env bash
# Smoke-test only disposable containers. Never read the deployment's .env.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: bash scripts/test-containers.sh <local-image>" >&2
  exit 2
fi

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d)
project="portcullis-ci-${RANDOM}-${RANDOM}"
export PORTCULLIS_IMAGE="$1"
export PORTCULLIS_ENV_FILE="$test_dir/.env"
export PORTCULLIS_PORT=0
export POSTGRES_PASSWORD
POSTGRES_PASSWORD=$(openssl rand -hex 24)
compose=(docker compose --project-name "$project" --file "$repo_dir/compose.yml" --env-file "$PORTCULLIS_ENV_FILE")

cleanup() {
  status=$?
  trap - EXIT
  if [[ $status -ne 0 ]]; then
    "${compose[@]}" ps --all || true
    "${compose[@]}" logs --no-color --tail 100 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans || true
  rm -rf -- "$test_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

umask 077
cat > "$PORTCULLIS_ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
BASE_URL=https://portal.example.invalid
OIDC_ISSUER=https://id.example.invalid
OIDC_CLIENT_ID=container-smoke-test
OIDC_CLIENT_SECRET=container-smoke-test-only
ENCRYPTION_KEY=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
EOF

"${compose[@]}" config --quiet
"${compose[@]}" pull db
"${compose[@]}" up --detach --wait --wait-timeout 120 --no-build --pull never app worker

# Verify static assets, readiness, and denial of unauthenticated API requests.
"${compose[@]}" exec -T app node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
assert.notEqual(process.getuid(), 0, "app must run as non-root");
for (const route of ["/", "/healthz", "/readyz"]) {
  const response = await fetch(`http://127.0.0.1:3000${route}`);
  assert.equal(response.status, 200, route);
  if (route === "/") {
    const html = await response.text();
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(asset, "built frontend script is present");
    assert.equal((await fetch(new URL(asset, "http://127.0.0.1:3000"))).status, 200);
  }
}
assert.equal((await fetch("http://127.0.0.1:3000/api/me")).status, 401);
await writeFile("/app/uploads/container-smoke-test", "persistent upload");
JS

"${compose[@]}" exec -T worker node --input-type=module -e 'import assert from "node:assert/strict"; assert.notEqual(process.getuid(), 0);'
"${compose[@]}" exec -T worker node dist/scripts/worker-health.js

# Re-running migrations must succeed against an already initialized database.
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" exec -T db psql -U portcullis -d portcullis -v ON_ERROR_STOP=1 -c \
  "INSERT INTO settings(key,value) VALUES ('container.smoke', '\"persistent data\"');"

# Recreate containers and verify both named volumes survive.
"${compose[@]}" down
"${compose[@]}" up --detach --wait --wait-timeout 120 --no-build --pull never app worker
"${compose[@]}" exec -T app node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Database } from "./dist/src/db/index.js";
assert.equal(await readFile("/app/uploads/container-smoke-test", "utf8"), "persistent upload");
const db = new Database(process.env.DATABASE_URL);
try {
  const [row] = await db.query("SELECT value FROM settings WHERE key='container.smoke'");
  assert.equal(row?.value, "persistent data");
} finally {
  await db.close();
}
JS

echo "Container checks passed: migrations, app, worker, authentication, and volume persistence."
