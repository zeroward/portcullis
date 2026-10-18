# Persistent task checklist

Checked implementation stages have passed local acceptance using real PostgreSQL,
signed test OIDC and HTTP provider contracts. This is **not** verification against
the operator's Pocket ID or NetBird deployment. Local Compose acceptance has passed;
live deployment acceptance remains open.
Only the game/server adapters are deliberately deferred.

- [x] 00 Repository review, persistent ordered plan and architectural boundaries.
- [x] 00 Official API/version compatibility research with pinned source revisions.
- [x] 01 Foundation, data model, clean migration and explicit development seed.
- [x] 02 Pocket ID signed OIDC, sessions, bounded identity refresh and authorization.
- [x] 03 Pocket ID directory, managed membership preservation/readback and enrollment.
- [x] 04 Service registry, filtered cards, favorites, connections and responsive gallery.
- [x] 05 Entitlements, versioned bundles, prerequisites, union grants and expiry.
- [x] 06 Tickets, protected attachments, private notes and distinct approvals.
- [x] 07 Durable jobs, reconciliation, crash/lease recovery and in-flight revocation.
- [x] 08 NetBird inventory, explicit verified identity links and owned peer views.
- [x] 09 Narrow NetBird memberships/policies/resources/routers and enrollment keys.
- [x] 10 Devices, enrollment guidance and separate portal/provider/monitor states.
- [x] 11 Manual/mock/unavailable WoW capability contracts and production restrictions.
- [x] 12 HTTP/TCP/Kuma/incoming/manual health, dependencies, SSRF and alert suppression.
- [x] 13 Versioned guides/acknowledgments, invitations and persisted onboarding.
- [x] 14 In-app notifications/notices, incident timeline and optional delivery isolation.
- [x] 15 Administrative views, audit/export and read-only user previews.
- [x] 16 Local deployment acceptance: security, production-mode Compose and isolated restore.
- [x] 17 Local end-to-end verification, UI fixes, documentation and handoff.
  Live production acceptance remains explicitly open in the list below.

## Verification ledger

2026-09-30: inspected repository and ancestors for instructions. No existing code,
no AGENTS.md. Docker CLI reports missing WSL integration; no system Node/Postgres.
Official Pocket ID API uses X-API-KEY. NetBird uses Authorization: Token.
No production calls or mutations made.

2026-10-01: Node 22.22.0 installed in /tmp; isolated embedded PostgreSQL 18.4
available through a pinned dev dependency. Versioned migrations applied successfully.
Typecheck/lint/build passed. The suite grew to 50 passing backend tests and four
passing Chromium workflows. Forged JWT signatures are explicitly checked with
openid-client enableNonRepudiationChecks. Cold database and uploaded-file copies
restored into a separate PostgreSQL process and smoke tested.

2026-10-02: dependency health aggregation and edit preservation, strict NetBird
policy readback, incident timeline, immediate maintenance start/cancellation,
creation-only setup-key secret filtering, identity refresh and administrative
controls implemented. Source formatted with pinned Prettier and a format check.
Final `npm run check` passed: formatting, typecheck, lint, 53/53 backend tests and
production build. All 7/7 Chromium workflows passed (8.9 seconds). The added
onboarding/sign-out test exposed an unreachable sidebar control on a shorter
viewport; scrolling was corrected and the full suite rerun successfully.
The mobile gallery screenshot was inspected. Docker was checked again and still
reports that WSL integration is unavailable.

2026-10-12: Docker is enabled (Engine 29.7.2, Compose 5.5.0). Built the production
Dockerfile with Node 22.22.0 and started PostgreSQL 18.4 in the isolated
`portcullis-rehearsal` project. Clean migrations passed without development seeds;
app, worker and database health checks passed. Verified production config, static
frontend delivery, non-root app/worker execution, no published database port and a
loopback-only application port (33080 for this rehearsal). Created synthetic recovery
records only after confirming the application tables were empty. Uploaded a protected
attachment through the API as UID 1000. Restarted database/app/worker and verified
the records, attachment, encrypted secret, revoked grant and future queued job survived.

Stopped app/worker for a consistent `pg_dump -Fc` and upload copy. Restored with
`pg_restore --no-owner --exit-on-error` into the separate `portcullis-restore` project
(port 33081), using fresh database/upload volumes and the recovered test configuration
and encryption key. Repeated migrations successfully. Restored user/card/ticket/grant,
attachment, secret and upload-audit counts passed; attachment bytes and UID 1000
ownership matched, anonymous download was denied, authenticated API reads passed,
the secret decrypted and the future job remained queued. The restored app/database
became healthy before starting the restored worker; its health check and a repeat
recovery smoke check also passed. Test sessions were inserted
directly into the isolated database; this does **not** verify OIDC login. Provider URLs
and credentials were absent, mock providers disabled, and NODE_ENV was production.
No live provider calls or production deployment occurred. The earlier 53 backend and
7 Chromium tests were not rerun for this documentation/config-example update.
Both rehearsal projects were stopped after verification; their isolated volumes and
test-only backup artifacts were retained. No application implementation fixes were
needed. The restore runbook now explicitly creates the app container before copying
uploads and stops on pg_restore errors; `.env.example` names POSTGRES_PASSWORD.

2026-10-17: replaced portal JSON editors with explicit form fields, resource
selectors, repeatable rows, Markdown previews and readable reviews/results. Added
permission-aware minimal lookup APIs and current-role sources. Editors retain
unavailable references and failed drafts, reload version conflicts explicitly,
and invalidate edited network previews. One-time credentials have separate copy
controls; secret reviews mask their values. Role updates now return a success
response. Local acceptance passed 67 backend/payload tests and 14 Chromium workflows,
including complete service/access payload preservation, lookup authorization,
provider errors/retry, field focus, saved preferences, secret handling and concurrent
edit recovery. Formatting, typecheck, lint and production build passed.

## Environment-dependent acceptance still required

- [x] Build/start the production Compose stack on a Docker-capable host, apply
  migrations without development seeds, restart app/worker/database and verify
  durable state, readiness, non-root uploads and worker health.
- [x] Rehearse the documented pg_dump/pg_restore and uploads restore in an isolated
  Compose project, including recovery of test configuration/encryption keys. Both
  local cold PostgreSQL restoration and the Compose logical restore have passed.
- [ ] Verify the actual HTTPS ingress, production OIDC sign-in and operator backup/key
  custody with the deployment's real configuration.
- [ ] With explicit authorization, use designated test resources to verify the
  deployed Pocket ID/NetBird versions, enrollment, managed group propagation and
  independently measured traffic enforcement. Follow docs/operations.md.
- [ ] Configure and test any desired external notification destinations. Core
  workflows work without SMTP; delivery failures are covered locally.

These are environment-dependent checks, not missing-provider placeholders.
Production deployment and live provider mutation remain separate operator actions.

## Deliberate deferrals

WoW manager live account/control/telemetry adapter awaits the supplied API spec.
No game database, SOAP/RCON/SSH/shell, Docker or Proxmox control was introduced.
Required unavailable fulfillment stays blocked until an explicit audited manual
attestation. No other missing functionality is categorized as this deferral.
