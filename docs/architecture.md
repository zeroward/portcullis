# Architecture

Modular TypeScript monolith: Fastify API serves built Vite/React frontend on one
origin; a separate worker imports the same domain and provider modules. PostgreSQL
owns persistent state, sessions, outbox/jobs and locks. Drizzle defines schema;
versioned SQL migrations retain constraints and indexes. No Redis.

Pocket ID owns canonical identities/passkeys/native groups. Local identity keys
are validated issuer+subject. Portal role grants are independent of entitlements
and NetBird roles. NetBird identity links require explicit operator verification.
Portcullis owns requests, desired grants, mappings and audit. NetBird owns actual
control-plane objects. Desired access, observed configuration, peer report and
monitor reachability are independent states in storage and API responses.

Domain modules perform authorization/invariants inside database transactions.
Routes validate input and delegate. Approval creates a grant and durable job in
one commit. Per-user advisory locks serialize approvals and provider writes.
Revocation/suspension commit local denial without waiting for a provider call;
workers reload desired state before each step and version-guard final status updates.
Jobs recheck effective grant union and suspension before external writes.
External effects are not atomic with the database: readback and retries reconcile
uncertain results; managed-edge records prevent deleting pre-existing access.

Server sessions use random opaque hashed tokens, HttpOnly/SameSite cookies, absolute
and idle expiry, local role version validation and bounded provider group refresh.
CSRF requires matching session token plus same Origin on writes. Tokens never reach
browser storage. Initial owner is a configured issuer+subject, never first login.

Provider clients use configured trusted instance URLs and typed validated responses.
Provider capabilities and configured versions are explicit. Managed IDs live in
bindings. No generic provider proxy. Secrets encrypted with AES-256-GCM and an
external key; no secrets in audit, error messages or ordinary UI responses.

Catalog responses filter fields before serialization. Files require object access.
Sanitized Markdown, safe URL schemes, protected uploads, security headers, bounded
requests/rate limits and network target approval apply throughout.

Game provider contracts declare available operations. Manual fulfillment blocks
until attested. Development mocks cannot be enabled in production. The WoW provider
returns awaiting-specification, never fake success. Health uses generic authorized
HTTP/TCP or documented Kuma metrics, not invented game telemetry.

Catalog health uses cached observations across required/optional dependency paths;
optional failures degrade rather than take down a service. It exposes measured
state separately and does not reveal protected dependency identities to members.
Graph edits take a transaction advisory lock before cycle validation. Admin service
responses include dependency mappings so editing metadata preserves them.
