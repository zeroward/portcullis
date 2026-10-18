# Portcullis implementation plan

Source: `PROMPT.md` (the supplied brief uses uppercase on disk). Repository review:
only README/LICENSE existed; no AGENTS.md in repository or parent directories,
and `.agents`/`.codex` are empty. Preserve the supplied, untracked PROMPT.md.

## Ordered execution

Each numbered stage corresponds to the brief and depends on prior stages. Build
domain rules before exposing actions in routes/UI. Every stage must record actual
checks and remaining work in task-checklist.md. A checkbox means the acceptance
criteria were verified, not merely that files exist.

| Stage | Implementation and acceptance |
| --- | --- |
| 00 | Persistent plan, architecture, compatibility research; consult official schemas before clients. |
| 01 | TypeScript/Fastify/React/Vite, PostgreSQL/Drizzle, versioned migration, config, explicit seed; migrate empty DB. |
| 02 | openid-client discovery, code/PKCE, PostgreSQL sessions, CSRF, roles, bounded refresh, owner bootstrap; test signed OIDC and denied access. |
| 03 | Pocket ID API client, managed groups, diagnostics, enrollment; test real HTTP contracts and membership preservation. |
| 04 | Catalog CRUD and filtered card responses, responsive gallery/detail, favorites, connections; test restricted fields and browser workflow. |
| 05 | Entitlements/bundles/prerequisites, union grants, renewals/revoke/expiry; test overlap and cycles. |
| 06 | Tickets/private notes/files and versioned approval snapshots with distinct approvers; exercise request→approval without fake activation. |
| 07 | Transactional durable jobs, retry/readback, versions/locks, reconciliation, heartbeat; exercise duplicate/crash/race/failure. |
| 08 | NetBird client reads/discovery, explicit verified identity links, owned peer views; validate observed fields and nullable telemetry. |
| 09 | Managed NetBird writes, narrow policies, propagation/readback, setup keys/peer removal; test full-replacement preservation and overlap. |
| 10 | Devices/enrollment/troubleshooting; separate desired access, control plane and reported connectivity. |
| 11 | Separate provider interfaces, manual/mock/unavailable WoW; typed capabilities and production mock rejection. |
| 12 | HTTP/TCP/Kuma/manual/incoming health, cached stale observations, SSRF policy; test validation and real local checks. |
| 13 | Versioned guides, acknowledgments, protected PDFs, invitation/onboarding; test persistence and single use. |
| 14 | Persistent notifications, optional channels, announcements/maintenance/incidents; delivery failure independent of fulfillment. |
| 15 | Admin operations, previews, audit/export, retention; inspect provenance and failures end to end. |
| 16 | Harden routes/files/secrets/outbound calls; production Compose, migration, backups/recovery; clean restart/restore test. |
| 17 | Typecheck/lint/unit/contract/DB/browser/build; fix findings, document exact results and live setup. |

## Non-negotiable boundaries

Pocket ID and NetBird use real, server-side HTTP clients with upstream contracts.
Local fixtures are automated contract tests, never claims of live verification.
No production provider mutation, deployment, push, or publishing is authorized.
Game/server adapters have internal extension contracts only. WoW stays unavailable
until its API specification arrives. No game database, SOAP/RCON/SSH, Docker socket,
Proxmox, shell control, or invented WoW endpoints. Unavailable required fulfillment
blocks access; manual attestation is explicit and audited.

## Assumptions and execution constraints

One community; same browser origin; PostgreSQL supplies durable jobs (transactional
outbox and leased queue are acceptable equivalent to pg-boss). UTC storage, Chicago
display default. SMTP optional. Admin supplies neutral artwork and explicit provider
object mappings. No automatic adoption by name/email. Development has a separate
signed OIDC service and isolated database. No dependency on production credentials.
At initial review this host had no Node/PostgreSQL and Docker's WSL integration was
disabled. Docker became available on October 12, 2026; the isolated production-mode
Compose startup/restart and logical backup/restore rehearsal passed. Live identity,
network enforcement and ingress checks remain separate; see task-checklist.md.
