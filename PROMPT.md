# Portcullis — Implementation Brief

## Your assignment

Act as the lead engineer for Portcullis, a self-hosted portal for a private
gaming LAN.

Inspect the repository, create an actionable implementation plan, and then
execute it. Do not stop after producing a plan, scaffolding, static mockups,
or a collection of placeholder pages.

Build and test working vertical slices. Maintain a persistent task checklist
and implementation notes so work can be resumed without rediscovering
architectural decisions.

Make reasonable implementation decisions without repeatedly asking me to
choose libraries or approve routine details. Record your assumptions.

Respect existing repository instructions and preserve unrelated changes.

Missing production credentials are not a reason to stop implementation.
Implement the real integration clients, test them against realistic fixtures
and local mock services, and clearly distinguish automated contract testing
from verification against a real deployment.

Do not modify my production Pocket ID, NetBird, networking, or other services
as part of development or testing without explicit authorization.

---

## 1. Product vision

Portcullis is the front door for my gaming LAN.

Users should be able to:

- Sign in through Pocket ID.
- Browse attractive game/service "baseball cards."
- Open a card to see descriptions, connection information, guides, and links.
- Understand whether they have access and what they must do next.
- Request access to services or administrative capabilities.
- Submit and follow support tickets.
- Enroll and view their NetBird devices.
- See service health, maintenance notices, and announcements.
- Complete onboarding without needing to understand the underlying network.

Administrators should be able to manage services, requests, entitlements,
users, devices, network-access mappings, health, and audit activity from
Portcullis rather than constantly switching between separate interfaces.

This should feel like a polished small service portal, not an enterprise
ITSM product and not merely a prettier NetBird dashboard.

### Existing architectural decisions

- Pocket ID is the identity provider and user/group directory.
- Do not introduce LDAP or LLDAP.
- NetBird handles private connectivity and network enforcement.
- Do not implement a separate VPN or generate raw WireGuard configurations.
- Retain the existing Pangolin deployment for public web ingress.
- Portcullis connects to existing identity and networking installations.
- Do not deploy replacement Pocket ID, NetBird, or Pangolin instances.
- SMTP must be optional.
- A single household/community deployment is sufficient. No multitenancy,
  billing, subscription system, or plugin marketplace.

### Critical scope boundary

Implement Pocket ID and NetBird integrations for real.

For game/server management integrations, implement ONLY an extensible,
capability-based integration framework, a manual provider, and development
mock providers.

My WoW server manager API is still being extended. I will provide its
specification later.

DO NOT invent:
- WoW manager API endpoints or payloads.
- AzerothCore account-provisioning implementations.
- Direct game-database writes.
- SOAP, RCON, SSH, or shell-command workarounds.
- Docker or Proxmox management access.
- Live game-specific restart, console, player-count, or log integrations.

This boundary does NOT defer:
- Manually configured server addresses and connection instructions.
- Service cards and launch/copy actions.
- Generic HTTP/TCP monitoring.
- Uptime Kuma health ingestion.
- NetBird connectivity and access administration.
- Tickets, approvals, entitlements, and manual fulfillment workflows.

---

## 2. Architecture and engineering defaults

If this is a greenfield repository, use these defaults:

- TypeScript throughout.
- React with Vite for the frontend.
- Tailwind and accessible UI primitives.
- Fastify for the backend.
- PostgreSQL with Drizzle ORM and versioned migrations.
- A PostgreSQL-backed durable job queue, preferably pg-boss.
- A separate worker process using the same backend/domain code.
- A maintained OIDC client library; do not implement OIDC cryptography.
- Runtime request/configuration validation.
- Vitest and Playwright, or equivalent established testing tools.
- Docker Compose for deployment.

If the repository already has a suitable stack, preserve it unless there is
a concrete reason to change it.

Use a modular monolith, not microservices. In production, serve the frontend
and API from one browser origin. Keep business rules out of UI components
and HTTP route handlers.

Avoid adding Redis or another infrastructure dependency when PostgreSQL
already solves the requirement.

Select supported compatible versions, pin dependencies and container
versions, and document the versions actually tested.

Suggested domain modules:
identity, authorization, service-catalog, entitlements, requests, tickets,
devices, network-access, providers, monitoring, onboarding, notifications,
incidents, audit, jobs, and settings.

### Sources of truth

Pocket ID owns:
- Authentication and passkeys.
- Canonical identity attributes.
- Native users and identity groups.

Portcullis owns:
- Service metadata and portal permissions.
- Requests, approvals, and access intent.
- Entitlements, grants, expiration, and fulfillment records.
- Provider mappings and orchestration.
- Tickets, documentation, notifications, and audit records.

NetBird owns:
- Network users, peers, groups, resources, and policies.
- Network enforcement and reported peer state.

Keep desired access, observed provider configuration, and observed
connectivity separate. Never collapse them into one boolean.

Provider identifiers belong in mapping records, not throughout business logic.

---

## Task 00 — Repository review, plan, and compatibility research

Inspect the repository and existing AGENTS.md instructions.

Create:
- docs/implementation-plan.md
- docs/task-checklist.md
- docs/architecture.md
- docs/integration-compatibility.md

Break this brief into ordered, testable tasks with dependencies and
acceptance criteria. Then begin implementation.

Consult official documentation and available upstream API schemas before
writing provider clients. Record source URLs, researched versions, supported
capabilities, authentication methods, and unresolved version differences.

Do not assume that the newest documentation exactly matches my deployment.
Allow configured instance versions and explicit capability overrides where
automatic detection is unavailable.

Distinguish:
- Implemented and automatically tested.
- Implemented but awaiting live verification.
- Unsupported by the configured provider.
- Intentionally deferred under this brief.

Do not mislabel missing implementation as "unsupported."

Acceptance:
A persistent plan exists, scope is explicit, and implementation begins.

---

## Task 01 — Application foundation and data model

Implement the repository structure, development environment, migrations,
configuration validation, structured logging, application error handling,
and shared domain types.

Model at least:
- Local users and external identity mappings.
- Roles and scoped permissions.
- Services, endpoints, links, artwork, tags, and dependencies.
- Entitlements, bundles, prerequisites, grants, and provider bindings.
- Access requests, approval decisions, and fulfillment steps.
- Tickets, comments, attachments, and assignment.
- Devices and NetBird resource mappings.
- Health checks, observations, maintenance, and incidents.
- Guides, onboarding progress, and policy acknowledgments.
- Notifications and delivery attempts.
- Audit events, jobs, reconciliation runs, and secret references.

Use foreign keys, uniqueness constraints, appropriate indexes, and UTC
timestamps. Display dates in a configurable user timezone, defaulting to
America/Chicago.

Create an explicit development seed command with fictional example users
and services. Never seed demo users, grants, or provider resources into a
production database automatically.

Acceptance:
A clean checkout can start locally, migrate an empty database, and load
clearly labeled development data.

---

## Task 02 — Pocket ID SSO and portal authorization

Implement OIDC Authorization Code login with PKCE, discovery, state and
nonce validation, and validated issuer, audience, signature, and expiry.

Use secure server-side sessions with HttpOnly cookies, production HTTPS
requirements, session rotation, idle/absolute expiry, and logout.

Do not store provider tokens in browser localStorage.

Identify users by the validated issuer and subject pair. Do not use email
as the permanent identity key.

Require authentication for all application data and private files.
Document narrow exceptions such as login, callbacks, static assets, and
minimal operational health endpoints.

Implement server-enforced permissions, with useful default roles:
- Member.
- Support.
- Approver.
- Service administrator.
- Network administrator.
- Identity administrator.
- Owner.

Allow service-scoped responsibilities where useful.

Keep portal roles separate from game entitlements and NetBird account roles.
A game administrator is not automatically a portal owner or network admin.

Support explicitly configured Pocket ID group-to-portal-role mappings.
Do not trust arbitrary group names or expose privileged mappings as
self-requestable access.

Bootstrap the initial owner through an explicit configured identity or
protected operator procedure. Never make the first arbitrary login an owner.

Implement local session invalidation on suspension and role changes.
Define bounded identity/group refresh behavior so old sessions do not retain
privileged portal permissions indefinitely.

Document an operator recovery procedure that does not create a public
password-login bypass.

Acceptance:
Unauthenticated and unauthorized API requests fail even when UI checks are
bypassed. Member/support/admin isolation is tested.

---

## Task 03 — Pocket ID administrative integration

Implement a server-side Pocket ID client separate from OIDC authentication.

Support:
- Connection testing and configuration diagnostics.
- Reading users, groups, and membership.
- Linking Pocket ID identities to local users.
- Creating users and managing designated groups/memberships through
  verified supported APIs.
- Invitation/enrollment assistance using documented provider capabilities.
- Refreshing observed identity state and reporting synchronization failures.

Use supported enrollment/login-code workflows where available. Passkey
registration happens in Pocket ID, not Portcullis.

Offer safe administrative handoff when a lifecycle capability is unavailable.
Do not invent a generic "reset password" operation for a passkey identity.

Separate portal suspension from disabling or deleting the global identity.
Global identity changes require dedicated permission, impact warnings,
confirmation, and audit.

Treat identity-management credentials as highly privileged. Never expose
them to the browser or allow a generic API proxy.

Track which groups and membership edges Portcullis manages. Preserve
unmanaged membership and existing users. Do not silently adopt groups
because their names happen to match.

Use Pocket ID APIs for the initial implementation. SCIM must not be a
required dependency or a second competing synchronization mechanism.

Document Pocket ID OIDC-client allowed-group setup.

Acceptance:
Real API clients and contract tests cover reading and changing managed
membership without removing unrelated memberships or escalating privileges.

---

## Task 04 — Service registry and baseball-card interface

Implement full administrative CRUD for games and services.

Support:
- Name, slug, type, category, tags, owner, and sort order.
- Short description and sanitized Markdown detail.
- Icon, cover/banner artwork, and optional screenshots.
- Version and environment metadata.
- Public-web, LAN, and NetBird connection endpoints.
- Hostname/IP, IPv4/IPv6, protocol, and one or more ports.
- Required client/software, rules, setup instructions, and guides.
- User-facing links and separately protected administrative links.
- Entitlement requirements, health bindings, and dependencies.

Give each service an explicit visibility policy:
- Discoverable to authenticated users with limited metadata.
- Visible only to entitled users.
- Administrative only.

Do not leak restricted IP addresses, links, or descriptions in API responses
or frontend payloads merely because the UI hides them.

Build a responsive card gallery with search, filters, favorites, and
"My services" versus "All available services."

Clicking a card opens an accessible detail panel or page containing:
description, health, access state, connection information, requirements,
guides, related notices, and relevant actions.

Actions include:
- Request access.
- View access/provisioning status.
- Open website or management link.
- Copy hostname, address, or connection instructions.
- Open a configured supported application URI.
- Download a credentials-free .rdp file where applicable.
- Report a problem with the service preselected.

Validate launch schemes and generated files. Do not promise that an OS has
a URI handler installed. No arbitrary executable launch commands.

Acceptance:
Admins can manage real cards; users see only authorized details; the main
experience works on desktop and mobile without mock-only interactions.

---

## Task 05 — Entitlements, bundles, and access lifecycle

Build an entitlement model independent of any provider.

Examples:
- game.wow.player
- game.wow.admin
- service.kasm.user
- service.plex.user
- network.gaming
- network.gameserver-admin

An entitlement can specify:
- Description and requestability.
- Approval policy and eligible approvers.
- Default/max duration and renewal rules.
- Required guides/AUP acknowledgments.
- Prerequisite entitlements.
- Service visibility/access implications.
- Pocket ID group bindings.
- NetBird access bindings.
- Future game-provider fulfillment bindings.
- Manual fulfillment steps.

Support bundles, direct grants, admin-issued grants, temporary grants,
renewals, suspension, revocation, and offboarding.

Prevent prerequisite cycles and unintended privilege escalation through
bundles or edited mappings.

Keep approval state separate from fulfillment state.

Suggested request states:
pending, needs-information, approved, denied, canceled.

Suggested fulfillment states:
queued, provisioning, active, partially-failed, blocked, revoking,
revocation-failed, revoked.

Expiration is an explicit desired-access condition with corresponding
fulfillment tracking; do not imply external access vanished merely because
a timestamp passed.

Compute effective access from the union of all valid grants. Removing one
bundle must not remove access still justified by another grant.

Expose a "My Access" page showing what the user has, why, expiration, pending
requests, missing prerequisites, and required next steps.

Acceptance:
Overlapping grants, renewals, prerequisite failures, expiry, and revocation
behave correctly and have unit tests.

---

## Task 06 — Tickets and approval workflows

Implement ticket types:
access request, technical problem, new game request, server problem,
feature request, and account problem.

Support:
- Subject, description, priority, category, and related service.
- Requester, assignee, status, and timestamps.
- User-visible replies and private staff notes.
- Attachments with limits and access controls.
- Filtering, search, assignment, and reopening.
- A chronological activity timeline.

Access requests should be linked to tickets but have structured fields:
requested entitlement/bundle, reason, duration, and approval decisions.

Support approve, approve temporarily, deny with reason, and request
additional information.

Allow optional multiple distinct approvers for privileged entitlements.
Prevent self-approval where configured. Recheck approver permission at the
time of the decision.

Snapshot or version the approved request so changing a bundle or duration
cannot silently expand what was approved.

Approval must enqueue fulfillment. It must not immediately mark access
active.

Acceptance:
A member can request access, an authorized approver can decide, and both
can follow actual provisioning results without seeing private staff notes.

---

## Task 07 — Durable automation and reconciliation

Implement durable background processing for:
provisioning, revocation, expiry, reconciliation, health polling, notification
delivery, and housekeeping.

Use transactions and an outbox or equivalent reliable pattern so a database
commit cannot silently lose its required job.

Implement:
- Idempotent operations and deduplication.
- Bounded retries, backoff, and timeouts.
- Per-user/resource concurrency control.
- Step-level status and sanitized error details.
- Retry/manual-intervention controls.
- Worker heartbeat and failed-job visibility.
- Desired-versus-observed reconciliation.

Jobs must recheck the current desired grant version before applying changes.
A delayed approval/provisioning job must not restore access after revocation.

Assume external operations may succeed even when their responses time out.
Read back state before blindly retrying non-idempotent requests.

Use safe compensation where possible. Do not invent cross-provider atomic
transactions or destructive rollback of unrelated resources.

Revocations take priority. Local portal denial should apply immediately,
while failed external revocation remains visible and retryable.

Detect provider drift. Only reconcile explicitly managed resources and
membership edges. Never rewrite an entire external account to match
Portcullis.

If the worker/provider is unavailable at an expiry deadline, report delayed
external enforcement rather than displaying a false completed revocation.

Acceptance:
Restarted workers, duplicate jobs, API timeouts, partial failures, and
approve/revoke races are covered by automated tests.

---

## Task 08 — NetBird discovery and administrative abstraction

Implement a server-side NetBird management API client with configurable
self-hosted URLs and supported authentication.

Read supported:
- Users.
- Peers and ownership.
- Groups.
- Policies.
- Networks, resources, and routing peers.
- DNS configuration.
- Setup-key metadata.
- Relevant account settings and events.

Present useful labels such as "Gaming access" and "Allowed servers," with
an advanced view exposing underlying NetBird objects.

Show provider-supplied peer metadata where available:
name, owner, OS, addresses, reported status, last seen, and groups.

Fields such as handshake, latency, public endpoint, or connection type must
be nullable and capability-gated. Never manufacture unavailable telemetry.

Persist explicit links between local users and NetBird users. Do not assume
Pocket ID subjects equal NetBird user IDs, especially with an intermediary
identity provider.

Use verified provider identity relationships where available. Otherwise
require an explicit administrative linking workflow. Email may suggest a
candidate, but must not silently authorize account linking.

Users see only their verified devices. Infrastructure/setup-key peers must
not be assigned to a person merely because names or addresses look similar.

Acceptance:
Provider inventory works against fixtures and real-client code, and device
ownership cannot be spoofed through request parameters.

---

## Task 09 — NetBird access provisioning and revocation

Implement real controlled writes for Portcullis-managed:
- Groups and group memberships.
- User access-group assignments.
- Narrowly scoped policies.
- Network resources and routing associations where supported.
- Setup-key creation and revocation.
- Peer removal or other supported administrative restriction actions.

Prefer the current Networks/Resources model for routed resources.
Preserve existing legacy configuration; do not perform automatic migrations.

Support both:
- A server that is itself a NetBird peer.
- A resource reached through a routing peer.

Prefer mapping existing infrastructure. Do not enroll or reconfigure routing
hosts automatically.

Default managed access to client-source groups reaching approved game/service
destinations on explicit protocols and ports.

No default access to:
the entire home network, arbitrary LAN subnets, management interfaces,
client-to-client traffic, exit-node routing, or unrelated resources.

Detect and warn about broad policies that could independently permit access.
Do not silently delete existing policies.

Default to API-managed NetBird groups for Portcullis entitlements. Do not
simultaneously manage the same membership through JWT/SCIM synchronization.
Detect incompatible ownership or synchronization settings.

Verify user-group propagation to existing peers as well as future peers.
Do not assume updating user auto-groups is sufficient on every deployment.

Preserve unrelated roles, settings, memberships, and peer associations when
updating objects. Test full-replacement API payload behavior.

Before risky writes, show:
- Desired changes.
- Affected users/devices/resources.
- Managed versus unmanaged objects.
- Warnings and unsupported operations.

Revoking one entitlement must not block an entire NetBird user account.
Whole-account blocking is a separate explicit operation.

Never treat setup-key expiry/revocation as device revocation. Track enrolled
peers separately and apply the relevant access-removal operation.

After writes, read back configuration. Distinguish control-plane verification
from proof that traffic is currently reachable or blocked at a device.

Acceptance:
A narrow access grant can be applied and removed through real API clients,
with overlap, existing-peer propagation, broad-policy warnings, and
revocation-failure tests.

---

## Task 10 — My Devices and guided connectivity

Build a user-facing "My Devices" page with:
- Verified owned devices.
- Friendly names and observed NetBird addresses.
- Reported online/offline/unknown state and last observation.
- Relevant approved services.
- Client installation and sign-in guidance.
- Lost-device reporting and permitted removal/request-removal actions.

Prefer interactive NetBird SSO for normal users.

Restrict setup-key workflows to explicitly authorized use cases. Default
generated keys to short-lived, one-use enrollment where supported. Reveal
the secret only at creation and exclude it from logs and notifications.

Do not generate reusable shared keys for ordinary guests.

Provide Windows, macOS, and Linux setup guidance using the configured
management URL. Do not expose privileged management API credentials.

Build troubleshooting that separately reports:
- Portal entitlement.
- Identity/NetBird user linkage.
- Provider-side network configuration.
- Peer-reported state.
- Service monitor state.

A browser cannot be assumed to inspect local NetBird or test arbitrary TCP
ports. Do not claim "this computer is connected" merely because another
owned peer is online.

Offer authorized connection details and safe commands users may run
themselves. Diagnostic submissions should warn about and redact secrets.

Acceptance:
A new user can understand enrollment and connectivity problems without
being shown misleading end-to-end connectivity claims.

---

## Task 11 — Modular game/server integration shell

Create separate interfaces for:
- IdentityProvider.
- NetworkProvider.
- ServiceProvider.
- HealthProvider.
- NotificationProvider.

Do not put unrelated functions into one giant provider interface.

ServiceProvider must support declared capabilities such as:
- Read service information/status.
- Read player counts.
- Read component health.
- Provision or revoke a game account.
- Modify game roles.
- Start/stop/restart.
- Read logs or open a console link.

These are internal extension contracts, NOT assumptions about my future API.

Each provider definition should include:
- Stable identifier and contract version.
- Configuration schema.
- Required secret references.
- Capability declarations.
- Input/output validation.
- Normalized errors.
- Timeout/retry guidance.
- Optional action definitions and authorization requirements.

Implement:
1. ManualServiceProvider:
   Real metadata, links, instructions, and explicit manual fulfillment.

2. MockServiceProvider:
   Development/test-only realistic responses, delays, and failures.

3. WowManagerProvider scaffold:
   Registered but unavailable for live operations, with a clear
   "Awaiting API specification" explanation.

Unsupported capabilities must return typed unsupported results. Missing
credentials are a different state. Neither can masquerade as success.

Do not show live restart/account-provisioning buttons unless the configured
provider genuinely supports them.

Provider-specific actions must use safe declarative UI schemas. Do not
load arbitrary JavaScript, accept arbitrary commands, or install plugins
from the web at runtime.

Keep future provider operations queued and audited through the existing
orchestration framework.

A future WoW adapter should be addable without rewriting cards, tickets,
entitlements, notifications, or onboarding.

Important fulfillment rule:
A grant requiring an unavailable game-account step stays blocked/incomplete.
An administrator may explicitly attest manual fulfillment with an audit
record, but a mock response must never activate a production grant.

Create docs/providers.md and docs/wow-manager-api-requirements.md listing
the future API information needed, without prescribing invented endpoints.

Acceptance:
Contract tests prove that manual, mock, unavailable, and future-capability
states behave consistently. Production cannot activate mock providers.

---

## Task 12 — Service health and monitoring

Implement real:
- HTTP/HTTPS checks with configurable expected status.
- TCP connection checks.
- Manual status with attribution.
- Authenticated incoming health updates.
- Read-only Uptime Kuma metrics ingestion.

Treat ICMP, Docker health, game-query protocols, and game-specific component
checks as future capabilities unless supplied by an existing health source.
Do not require privileged containers just to provide monitoring.

Support per-service component checks and required/optional dependencies,
but do not fabricate WoW database or Playerbots health.

Represent healthy, degraded, down, unknown, and stale observations.
Represent maintenance separately from underlying measured health.

Every observation includes:
source, timestamp, check location/vantage point, and expiry/staleness.

Use scheduled polling with jitter, limits, and flapping suppression.
The browser reads cached results; card rendering must not trigger a network
check per request.

Protect against SSRF:
only privileged admins configure targets; allow explicitly approved private
network ranges and domains; restrict ports/schemes; block metadata and
unapproved loopback/link-local targets; validate DNS and redirects; enforce
response-size and timeout limits.

Health checks report reachability from the monitoring location, not from
the current user's machine.

Use documented Kuma metrics and authentication. Do not depend on an
unsupported Socket.IO management interface or expose Kuma credentials.

Acceptance:
Cards display real check results with staleness and maintenance behavior.
SSRF, unavailable monitors, and misleading connectivity states are tested.

---

## Task 13 — Guides, invitations, and onboarding

Implement an authenticated guides/documentation area with:
- Sanized Markdown.
- Controlled PDF uploads/downloads.
- Version history.
- Service/entitlement associations.
- Required acknowledgments.
- Search and appropriate visibility.

Track acceptance against a specific document version and timestamp.
Do not claim an acknowledgment proves the document was actually read.

Build a resumable onboarding wizard:
1. Confirm profile.
2. Review required community rules/AUP.
3. Follow NetBird enrollment guidance when needed.
4. Link/observe enrolled devices.
5. Browse/request desired services.
6. Complete service-specific setup.

Support admin-generated onboarding invitations with expiration, revocation,
and appropriate single-use behavior.

Invitation possession must not bypass Pocket ID login or grant admin rights.
Treat invitation and identity-enrollment links as sensitive secrets.

Allow administrators to copy/share invitations without requiring SMTP.

Acceptance:
An invited user can complete onboarding without email integration, and
progress/acknowledgments survive logout and document updates.

---

## Task 14 — Notifications, announcements, incidents, and maintenance

Implement persistent in-app notifications as the baseline.

Add optional:
- SMTP email.
- Discord webhook delivery.
- Generic signed outgoing webhook delivery.

Use a provider interface for future notification channels. Do not require
Matrix, Discord, or email for core workflows.

Notify on relevant events:
ticket replies, approvals/denials, provisioning failures, access readiness,
upcoming expiry, renewal, matenance, incidents, and recovery.

Support preferences, read/unread state, deduplication, retry history, and
notification links that still enforce authentication/authorization.

Never include credentials or disclose restricted services to unauthorized
recipients.

Implement:
- Global or service-targeted announcements.
- Scheduled maintenance windows.
- Start/end maintenance actions.
- Incident creation and update timeline.
- Investigating, identified, monitoring, and resolved states.
- Optional subscriber notifications.
- Clear banners on affected cards and dashboards.

Preserve measured health during maintenance; suppress alerts according to
configured policy rather than erasing failure observations.

Acceptance:
Users receive authorized in-app updates without SMTP, and optional delivery
failures do not break access or ticket workflows.

---

## Task 15 — Administrative operations and audit

Build an administrative landing page showing:
- Health summary and active incidents.
- Pending approvals and open tiets.
- Provisioning/revocation failures.
- Expiring access.
- Recent/stale devices.
- Provider connection status.
- Worker/reconciliation health.
- Recent administrative activity.

Player counts and similar metrics appear only with a real supported source.
Unknown is not zero.

Provide focused views for users, services, access, networking, tickets,
monitoring, audit, and settings.

Useful actions:
grant/revoke access, retry failed fulfillment, suspend portal access, start
offboarding, manage service visibility, open management links, announce
maintenance, and inspect provider drift.

Implement a read-only "view as user" preview for authorized administrators,
with a visible banner and audit trail. Do not create an impersonated login
session or allow actions to be attributed to the other user.

Record audit events for:
logins, role/mapping changes, approvals, grants, provider writes, secret
changes, device actions, manual attestations, and privileged previews.

Include actor, subject, target, action, timestamp, outcome, correlation ID,
and sanitized before/after details where useful.

Audit records are append-only through the application. Do not claim they
are tamper-proof against a database administrator.

Implement filters and authorized export. Define retention for logs,
observations, tickets, and attachments.

Acceptance:
An administrator can answer "Who granted this access, why, what changed,
and did the provider operation succeed?" from the application.

---

## Task 16 — Security, deployment, and operatis

Apply security throughout implementation, not only at the end.

Required:
- Server-side object authorization and response-field filtering.
- CSRF protection for cookie-authenticated writes.
- Appropriate CORS, security headers, and trusted-proxy configuration.
- No trusting arbitrary forwarded identity headers.
- Request validation and rate limits.
- Sanitized Markdown and restricted upload types/sizes.
- Protected attachment delivery and path-traversal prevention.
- No embedded passwords in links or generated connection files.
- Encrypted stored provider secrets with the key outside the database.
- Redacted logs, diagnostics, exports, and error responses.
- Secret rotation and documented backup requirements.
- Allowlisted destinations for outbound integrations.
- Signed incoming webhooks with replay protection.
- Confirmation and fresh authorization for destructive/high-impact actions.

Use explicit ownership/management boundaries for all external mutations.

Production Compose should include:
- Application/API serving the frontend.
- Worker.
- PostgreSQL.
- Persistent uploads/storage.
- Explicit migration procedure.
- Health/readiness checks and restart policies.

Do not expose PostgreSQL publicly, mount the Docker socket, or require
privileged application containers.

Default deployment is behind my existing ingress. Document how Pangolin
routes HTTPS to Portcullis and how trusted proxy headers are configured.

Do not add a second authentication gateway in front of OIDC callbacks or
NetBird native endpoints. Do not attempt to redesign my VPN ingress.

Keep provider credentials server-side and administrative endpoints internal
where feasible.

Provide separate development configuration with mock services and signed
test OIDC flows. Production must reject mock authentication/providers.

Provide an actionable backup-and-restore procedure covering database,
uploads, configuration, and encryption keys, plus a restore smoke test.

Acceptance:
A clean production-style Compose deployment works, preserves data across
restarts, and does not depend on development authentication or live seeds.

---

## Task 17 — End-to-end validation, polish, and handoff

Implement automated tests for at least:

1. OIDC validation, session expiry, and authorization.
2. Protected cards, files, tickets, notes, and device ownership.
3. A request progressing through approval to real provider-client calls.
4. Privileged requests requiring distinct approvers.
5. Shared entitlements not being removed prematurely.
6. Temporary access expiry andelayed/failed external revocation.
7. Worker crash/retry and ambiguous provider responses.
8. Stale provisioning jobs not resurrecting revoked access.
9. Preservation of unmanaged Pocket ID/NetBird membership.
10. NetBird access propagation to existing and newly enrolled peers.
11. Setup-key revocation not being mistaken for peer removal.
12. Health stale/unknown/maintenance distinctions and SSRF controls.
13. Missing server-provider capabilities not producing fake success.
14. Optional SMTP and unavailable providers not breaking the portal.
15. Mock authentication/providers being rejected in production.
16. Backup restoration and clean database migration.

Provide a documented, opt-in live integration test procedure that uses
clearly designated test resources and never broadens production policies
without explicit approval.

Polish loading, empty, error, retry, and permission-denied states.
Ensure keyboard navigation, accessible dialogs, readable contrast, responsive
layouts, and clear non-color-only status indicators.

Use a restrained dark-friendly visual design with optional light mode.
Artwork should be admin-provided or neutral placeholders, not scraped
copyrighted assets.

Deliver:
- README with development and deployment instructions.
- .env.example with no real secrets.
- Dockerfiles and Compose configuration.
- Versioned database migrations.
- Working seed/test commands.
- Portable lint/typecheck/test/build scripts.
- CI configuration appropriate to the repository.
- API documentation.
- Pocket ID and NetBird setup guides.
- Integration compatibility matrix.
- Provider extension guide and future WoW API requirements.
- Security/threat-model notes.
- Backup/restore and recovery runbooks.
- Accurate completed/blocked/deferred task checklist.

### Final acceptance scenario

A new user signs in through Pocket ID, acknowledges required rules, browses
service cards, requests an entitlement, receives approval, enrolls a NetBird
device, and sees their actual provisioning state and connection instructions.

An administrator can inspect the request, resulting provider mappings,
device ownership, service health, and audit trail.

The user can open a service-specific ticket.

The administrator can revoke or expire access and see whether external
revocation was verified or is still failing.

A WoW card can exist immediately with real manually configured connection
information and generic health, while game-account provisioning and server
control clearly remain unavailable pending the future manager API.

---

## Execution rules

Complete these tasks incrementally and keep the application runnable.

For every task:
- Implement the feature.
- Add meaningful tests.
- Run relevant checks.
- Update the persistent checklist.
- Record assumptions, limitations, and actual verification results.

Do not replace required workflows with "coming soon" pages.

The only intentional integration shells are those explicitly deferred above.

Do not claim real-world integration testing when only mocks were used.
Do not claim network enforcement solely from a database flag.
Do not claim completion when the build/tests have not been run successfully.

Do not push commits, publish containers, or deploy to production unless
explicitly requested.

At the end, summarize implemented behavior, tests actually run, remaining
environment-dependent setup, and the intentionally deferred server adapters.

## Reference documentation

Verify against the targeted versions and follow linked official API schemas:

Pocket ID:
https://pocket-id.org/docs/api
https://pocket-id.org/docs/configuration/allowed-groups
https://pocket-id.org/docs/setup/user-management
https://pocket-id.org/docs/configuration/scim

NetBird:
https://docs.netbird.io/api
https://docs.netbird.io/api/resources/users
https://docs.netbird.io/api/resources/accounts
https://docs.netbird.io/manage/access-control
https://docs.netbird.io/manage/peers/register-machines-using-setup-keys

Uptime Kuma:
https://github.com/louislam/uptime-kuma/wiki/Prometheus-Integration
https://github.com/louislam/uptime-kuma/wiki/Prometheus-API-Keys

Engineering defaults:
https://vite.dev/guide/
https://fastify.dev/docs/latest/
https://orm.drizzle.team/docs/overview
https://github.com/timgit/pg-boss
https://github.com/panva/openid-client
