# Waygate Management API v1 integration (`wow-manager`)

Portcullis integrates with Waygate's read-only Management API v1 (`src/providers/waygate.ts`):

- **Authentication**: Dedicated `MANAGEMENT_API_TOKEN` (or `WAYGATE_TOKEN`), minimum 32 printable ASCII characters without spaces (`/^[\x21-\x7e]{32,}$/`), sent via `Authorization: Bearer <token>` to `WAYGATE_URL`.
- **Supported read-only endpoints** (`GET` and `HEAD`, exact paths, 10s collection budget):
  - `/api/v1/dashboard` (`status`, `players`, `leaderboards`, `modules`, `partial`, `errors`, `cache_ttl_seconds`, `demo`)
  - `/api/v1/status` (realm reachability `realm_up`, core/expansion/world version, public host/ports, population counts)
  - `/api/v1/players` (online human character roster including GMs, ordered by level desc, name asc)
  - `/api/v1/leaderboards` (`playtime`, `kills`, `honor`, `arena`, `gold`)
  - `/api/v1/modules` (detected module IDs and titles)
- **Health monitoring (`kind: "waygate"`)**: Polls `/api/v1/dashboard` (minimum interval 5s, recommended 20s), mapping `realm_up: false` to `down`, `partial: true` to `degraded`, `status: null` to `unknown`, and full collection with `realm_up: true` to `healthy`.
- **Write/control boundary**: Management API v1 is strictly read-only and does not expose account provisioning, revocation, or server control actions. Game-account fulfillment and removal continue to require audited manual attestation.
