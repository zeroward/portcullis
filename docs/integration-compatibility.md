# Integration compatibility research

Research date: 2026-09-30. Deployment versions unknown; configured version and
capability overrides are required. Official documentation is a contract source,
not proof a production instance supports every feature. Record exact schema
revisions and test evidence below as implementation proceeds.

| Provider | Source | Authentication | Initial boundary |
| --- | --- | --- | --- |
| Pocket ID | https://pocket-id.org/docs/api | X-API-KEY for admin; OIDC for login | Native API, no LDAP/SCIM dependency |
| Pocket ID allowed groups | https://pocket-id.org/docs/configuration/allowed-groups | operator | Configure OIDC client allowed groups explicitly |
| NetBird | https://docs.netbird.io/api/resources/users and https://docs.netbird.io/api/resources/groups | Authorization: Token PAT | Explicit mappings; preserve full-replacement fields |
| Kuma | https://github.com/louislam/uptime-kuma/wiki/Prometheus-Integration and https://github.com/louislam/uptime-kuma/wiki/Prometheus-API-Keys | metrics API key / documented Basic auth | Read-only /metrics, no Socket.IO management |
| OIDC library | https://github.com/panva/openid-client | code + PKCE | Maintained library handles validation/crypto |

Pocket ID OIDC client newly created with no allowed groups permits no users until
operator configures restrictions or explicitly unrestricts. NetBird user PUT
requires role, auto_groups, is_blocked; changing access must retain original role
and blocking state. Updating auto_groups alone is not treated as existing-peer
propagation proof. Neither setup-key expiration nor revocation removes enrolled
peers. All real deployment behavior remains live-verification pending.

## Pinned upstream contracts and tested tooling

Pocket ID source revision: `642ccc80d399af1100bbcf334f29f893a3270f87`.
Routes/DTOs are the API definitions (the current repository has no Swagger file):
https://github.com/pocket-id/pocket-id/tree/642ccc80d399af1100bbcf334f29f893a3270f87/backend/internal/controller
and https://github.com/pocket-id/pocket-id/tree/642ccc80d399af1100bbcf334f29f893a3270f87/backend/internal/dto
plus the one-time-access module under backend/internal/onetimeaccess. Confirmed
native pagination envelope data/pagination, userGroups/group.users, userIds replacement,
non-admin user creation and POST /api/users/{id}/one-time-access-token with optional
TTL and {token} output. Deployment release version remains unverified.

NetBird source revision: `82e5428c2f75469fdbfb133b52d8d5d284734a21`.
Official OpenAPI: https://github.com/netbirdio/netbird/blob/82e5428c2f75469fdbfb133b52d8d5d284734a21/shared/management/http/api/openapi.yml
Confirmed UserRequest role/auto_groups/is_blocked, GroupRequest name/peer IDs/resources,
PolicyRuleCreate sources/destinations/protocol/ports/bidirectional, Networks resource/router
routes, one-off setup keys (expires_in minimum 86400), and setup-key revoke preserving
auto_groups. Legacy routes are not migrated. Creation reads back policies/resources/routers;
access verifies both auto-groups and owned peers. Deployment version remains unverified.

Kuma /metrics uses documented Basic auth with empty username and API key as password.
monitor_status is cached with source/vantage/expiry. No Socket.IO management is used.
Deployment version and live metrics names/authentication remain unverified.

| Capability | Implementation | Automated evidence | Real deployment |
| --- | --- | --- | --- |
| Pocket ID OIDC discovery/code/PKCE/signature | Real maintained library | Signed local issuer; bad signature/state/nonce/audience/issuer/expiry rejection | Awaiting configured instance |
| Pocket ID directory/managed membership | Real HTTP client | Fixture read/replace/readback/unmanaged edge preservation | Awaiting designated resources |
| Pocket ID enrollment/user/group creation | Real version-gated HTTP client | Route/schema fixture coverage | Awaiting version/capability opt-in |
| NetBird discovery and verified links | Real HTTP client/domain | Owned-device/API contract tests | Awaiting instance |
| NetBird access and narrow policies | Real HTTP writes/readback | Grant/overlap/revoke/failure/new-peer preservation tests | Traffic enforcement not tested |
| Networks resources/routing associations | Real gated HTTP client | Create/readback + narrow target tests | Configure netbird.networks after verifying version |
| Setup keys / peer removal | Real distinct APIs | One-use/minimum TTL; key revoke retains peers | Awaiting live enrollment/removal test |
| HTTP/TCP/Kuma monitoring | Real outbound checks | Local network, metrics, SSRF and staleness tests | Configure approved targets |
| Manual game fulfillment | Real audited workflow | Block/attest contracts and portal flow | Operator attestation required |
| Mock service providers | Development/test-only | Production instantiation and worker activation rejected | Prohibited |
| WoW server/account/control/telemetry | Intentionally unavailable scaffold | Typed awaiting-specification; no live control buttons | Deferred until supplied API specification |

Optional capabilities disabled by configuration are reported unavailable/unsupported
for that configuration. Credentials missing from an enabled client are a separate
missing-credentials state. An unimplemented adapter is never labeled supported.
No automatic release detection is assumed; instance versions and capability overrides
are operator settings. Source-main schemas may differ from deployed releases.

Tooling installed and compiled locally: Node 22.22.0, embedded PostgreSQL 18.4.0.
Production-mode Docker validation on October 12, 2026 also passed with
`node:22.22.0-bookworm-slim`, `postgres:18.4-bookworm`, Docker Engine 29.7.2 and
Compose 5.5.0. This does not change the live-provider verification status above.
Exact direct dependencies (also pinned transitively in package-lock.json):

| Package | Version |
| --- | --- |
| @fastify/cookie | 11.1.2 |
| @fastify/helmet | 13.1.1 |
| @fastify/multipart | 10.1.2 |
| @fastify/rate-limit | 11.2.0 |
| @fastify/static | 10.1.5 |
| drizzle-orm | 0.45.3 |
| fastify | 5.12.5 |
| ipaddr.js | 2.5.0 |
| nodemailer | 10.0.13 |
| openid-client | 6.8.8 |
| pg | 8.23.1 |
| react | 19.3.0 |
| react-dom | 19.3.0 |
| react-markdown | 10.1.0 |
| remark-gfm | 4.0.1 |
| zod | 4.6.5 |
| @playwright/test | 1.63.0 |
| @tailwindcss/vite | 4.3.3 |
| @types/node | 26.6.3 |
| @types/nodemailer | 8.0.2 |
| @types/pg | 8.23.1 |
| @types/react | 19.3.0 |
| @types/react-dom | 19.3.0 |
| @vitejs/plugin-react | 6.1.1 |
| embedded-postgres | 18.4.0-beta.17 |
| eslint | 10.11.0 |
| jose | 6.2.12 |
| tailwindcss | 4.3.3 |
| tsx | 4.23.15 |
| typescript | 6.0.3 |
| typescript-eslint | 8.71.0 |
| vite | 8.3.1 |
| vitest | 5.0.3 |

Formatting is pinned to Prettier 3.9.9; `npm run format:check` is part of `npm run check`.
