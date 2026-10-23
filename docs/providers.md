# Provider extension contract

## Game metadata

Optional game artwork and description lookup uses the RAWG API and never sends its
API key to the browser. Set `RAWG_API_KEY` to enable it; `RAWG_API_URL` defaults to
the official API and exists for contract fixtures. Catalog-management permission is
required for both lookup endpoints. Imported records retain a RAWG source URL, and
the portal displays the required attribution beside cards and details that use the
data or images. Operators remain responsible for complying with the selected RAWG
plan and its usage limits.

## Fulfillment providers

`src/providers/contracts.ts` separates IdentityProvider, NetworkProvider,
ServiceProvider, HealthProvider and NotificationProvider. Service contract v1
defines capabilities as internal operations, not future external API endpoints.
Definitions carry stable IDs, runtime schemas, secret references, timeouts, retry
guidance and declarative authorized actions. Results distinguish unsupported,
missing credentials, manual requirement, awaiting specification and success.

ManualServiceProvider provides metadata and explicit attestation. MockServiceProvider
is test/development only and cannot activate any persisted fulfillment through the
worker. WowManagerProvider implements read-only realm telemetry (`information`,
`status`, `player-count`, `component-health`) against Waygate Management API v1
(`src/providers/waygate.ts`), while administrative/account-provisioning capabilities
remain awaiting a write API specification.
Cards may contain real configured addresses/guides, Waygate realm telemetry and
health immediately.
There are no WoW live controls, game database access, shell commands or fabricated
player counts. Manual game fulfillment/revocation must be separately attested and
audited; unavailable required steps block the grant.

To add an adapter: implement typed validated inputs/outputs, capability availability,
version diagnostics, ownership, stable operation IDs/readback, normalized errors;
register worker dispatch and contract fixtures; expose only declarative actions
with an explicit permission and confirmation. Keep all effects queued, version
checked and audited. Never install code from the web at runtime. Add live opt-in
verification independently of contract testing.
