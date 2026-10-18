# Portcullis

[![CI and containers](https://github.com/zeroward/portcullis/actions/workflows/ci.yml/badge.svg)](https://github.com/zeroward/portcullis/actions/workflows/ci.yml)

Source: [zeroward/portcullis](https://github.com/zeroward/portcullis).
Clone with `git clone git@github.com:zeroward/portcullis.git`.

A self-hosted community gaming portal. Pocket ID handles sign-in and identity;
NetBird handles network enforcement. Portcullis manages cards, requests, grants,
tickets, onboarding, monitoring and audit.

Pocket ID and NetBird are real server-side API integrations. Automated tests call
isolated HTTP services using upstream request contracts. Production integrations
have **not** been verified against your installations. The WoW manager adapter is
deliberately unavailable pending its API specification; manual fulfillment is
explicit and audited. There are no fabricated game controls or game database writes.

## Develop

Use Node 22.22.0+ and PostgreSQL 18.4. Dependencies are exact-pinned with a lockfile.

```sh
npm ci
cp .env.example .env
docker compose -f compose.dev.yml up -d
# Alternative when Docker is unavailable (separate terminal, dev only):
# node --import tsx scripts/local-db.ts
node --env-file=.env --import tsx scripts/migrate.ts
node --env-file=.env --import tsx scripts/seed.ts
npm run build
```

In separate terminals:

```sh
npm run dev:oidc
node --env-file=.env --import tsx src/server.ts
node --env-file=.env --import tsx src/worker.ts
```

Open http://localhost:3000. The signed development issuer offers fictional member,
owner, support and approver accounts. The seed is explicit, idempotent and forbidden
in production; it creates no external provider resources or grants. Provider URLs
are unset by default. For frontend hot reload run `npm run dev:web`, set BASE_URL
to http://localhost:5173, and use that URL for OIDC callbacks. Use one browser origin.

## Validate

```sh
npm run check
npx playwright install --with-deps chromium
npm run test:e2e
```

Backend tests create their own PostgreSQL cluster, signed OIDC issuer and Pocket ID /
NetBird HTTP fixtures. Browser tests use a separate test database and built frontend.
No production credentials or resource writes are needed. Ports 4100, 4200, 4300,
55432–55434 must be free; stop the development issuer before running tests.
`npm run build` is required before browser tests after frontend changes.
`npm run format` applies the source formatter; `npm run check` checks formatting too.

Latest local verification: 67 backend/payload tests and 14 Chromium workflows passed, plus
formatting, typecheck, lint and production build. See the persistent
[checklist](docs/task-checklist.md) for evidence and outstanding deployment checks.

## Portal forms

Administrative editors use named fields, dropdowns and repeatable rows, including
service metadata, dependencies, access policies, identity links, network resources,
monitoring and notices. Markdown fields have rendered previews. Resource choices
load when an editor opens and are filtered by permission; unavailable current
references remain visible and are retained until explicitly changed.

Actions requiring confirmation show a review before applying. Network policy and
resource previews are invalidated by edits. Role changes, offboarding, service
deletion and secret rotation also require typed confirmation. Failed saves retain
the draft, and version conflicts offer an explicit reload. Enrollment credentials
appear in a separate copy-and-hide display; secret values never appear in reviews.

## Deploy behind existing ingress

Copy `.env.example` to `.env`, change NODE_ENV to production, set HTTPS BASE_URL,
real OIDC configuration, explicit OWNER_SUBJECT, unique encryption key and a strong
POSTGRES_PASSWORD (URL-safe characters). Set provider instance versions and only
capabilities verified for those versions. Never point development tests at production.

The [CI and containers workflow](https://github.com/zeroward/portcullis/actions/workflows/ci.yml)
runs formatting, type checks, lint, backend and browser tests, then builds and tests
the production Compose services. Successful pushes to `main` publish the tested
Linux amd64 image as `ghcr.io/zeroward/portcullis:main`, `:latest`, and
`:sha-<full-commit>`. Tags starting with `v` also publish their exact tag (for example
`:v0.1.0`). Pull requests validate without publishing. Actions are pinned to commits
and Dependabot proposes updates. Publishing uses GitHub's automatic `GITHUB_TOKEN`
with package write permission; no registry password needs to be stored in the repo.

The `app`, `worker`, and one-shot `migrate` containers share this image with different
commands. The `db` container uses upstream `postgres:18.4-bookworm`. Pocket ID,
NetBird, and ingress remain your existing services. CI uses disposable test data
and does not connect to your deployment.

To deploy a published image, set `PORTCULLIS_IMAGE` in `.env` to the desired
`ghcr.io/zeroward/portcullis:sha-<full-commit>` tag (or an image digest), then run:

```sh
docker compose pull
docker compose up -d --wait --wait-timeout 120 --no-build app worker
```

For a private GHCR package, authenticate the deployment host using `docker login ghcr.io`
with a token allowed to read that package, or make the package public in GitHub.
Before upgrading an existing deployment, take a backup, pull the selected image,
stop `app worker`, run `docker compose run --rm migrate`, then use the `up` command
above. Do not automatically roll back application images across incompatible database
migrations; restore a compatible backup when required.

For a local source build, set `PORTCULLIS_IMAGE=portcullis:local` in `.env`, run
`docker compose build app`, then
`docker compose up -d --wait --no-build --pull never app worker`.
Run `bash scripts/test-containers.sh portcullis:local` to smoke-test that image in
an isolated Compose project; it creates and removes only its own test volumes.

Migrations run idempotently; app/worker depend on their successful completion in
Compose. CI/CD publishes deployable images; host deployment is an operator action.
No production seeds or replacement identity/VPN/ingress
instances are deployed. PostgreSQL has no published port; app listens on loopback.
Production-mode Compose build, clean migration, restart persistence and isolated
database/uploads restoration passed on this host on October 12, 2026. App and worker
run as the non-root `node` user. Live identity, network enforcement and ingress
acceptance remain pending; see [the checklist](docs/task-checklist.md).

Route existing Pangolin HTTPS ingress to Portcullis port 3000. If Pangolin runs in a
separate container network, attach the app to its existing internal network instead
of publishing it broadly. Trust only the actual ingress proxy addresses via
TRUSTED_PROXIES; do not accept arbitrary forwarded identity headers. OIDC callbacks
must reach Portcullis without a second authentication gateway. Keep existing
NetBird native endpoints and VPN ingress unchanged.

See [Pocket ID setup](docs/pocket-id.md), [NetBird setup](docs/netbird.md),
[API](docs/api.md), [compatibility](docs/integration-compatibility.md),
[security](docs/security.md), [backup/recovery](docs/operations.md),
[provider extensions](docs/providers.md), and [future WoW requirements](docs/wow-manager-api-requirements.md).
The [plan](docs/implementation-plan.md) and [checklist](docs/task-checklist.md) record
progress, verification and outstanding environment-dependent checks.
