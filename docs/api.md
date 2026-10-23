# HTTP API

All application routes require an authenticated server session and return JSON unless
specified. Writes require the exact configured Origin and X-CSRF-Token returned by
GET /api/me. Cookies are HttpOnly. Roles and object ownership are enforced on the
server even if UI controls are bypassed. UUID inputs and request bodies are validated
with Zod. Errors return {error, message?}; provider errors also include provider and
retryable. Missing objects use 404 to prevent ownership probing. List endpoints are
bounded; ticket search/filtering is over authorized results only.

## Form options

`GET /api/form-options/:kind` returns minimal `{id,label,description?,disabled?,reason?}`
choices for services, users, assignees, entitlements, guides, secret names, failed
jobs, providers, Pocket ID users/groups and NetBird users/groups/peers/networks/resources.
The `purpose` query parameter selects the applicable permission or group restrictions;
resource lists require `networkId`, and assignees require `ticketId`. Service choices
respect visibility or administrative scopes. Assignees must have scoped support/owner
permissions. Provider lookups require the corresponding administrator permission.
Secret lookups return names and references only, never ciphertext or secret values.

`GET /api/admin/users/:id/roles` is owner-only and returns current roles with their
source and an `editable` flag. The UI treats inherited roles as read-only and prevents
self-editing. Successful role writes return `{ok:true}`.

## Authorization and workflow contracts

- Catalog GET responses contain limited metadata for discoverable cards without
  access; protected endpoints/descriptions/links are omitted. Administrative links
  require scoped catalog.manage. Service writes require catalog.manage and an
  optimistic version on PUT. Entitled visibility requires entitlement mappings.
- Entitlement/bundle CRUD and direct grants require access.manage. Approvals require
  access.decide for every affected service; no-self-approval and distinct eligible
  approvers are evaluated again when deciding. Request bodies select one
  entitlementId or bundleId, reason, durationHours. Approval records decision,
  reason, durationHours (may shorten), confirmation=APPROVE. Approval returns queued,
  never immediate external activation. Request snapshots prevent edited mappings
  from expanding approval. Bundle/entitlement updates use version checks.
- Members read/write their own tickets; ticket.staff grants scoped staff access.
  Private comments and private staff notes never appear in member payloads.
  Attachments require their ticket/guide object permission. Multipart upload sends
  one file to /api/files/:id?kind=ticket|guide; download is /files/:id.
- /api/admin aggregate, audit/export, secrets, role changes and preview require owner.
  User lifecycle/directory APIs require identity.manage; network APIs require
  network.manage; mappings require both access.manage and the respective provider
  authority. Preview is read-only and does not create another user's session.
- High-impact actions require authentication within 15 minutes and exact confirmation
  text: GRANT, REVOKE, ATTEST, ATTEST REMOVAL, LINK, MANAGE, CHANGE ROLES, SUSPEND,
  OFFBOARD, DELETE, REMOVE DEVICE, ROTATE SECRET, CREATE USER/GROUP/POLICY/RESOURCE,
  ASSOCIATE ROUTER, CREATE ENROLLMENT KEY, REVOKE KEY, ENROLLMENT as appropriate.
- Network policy preview accepts {name,sourceGroup,destinationGroup,protocol,ports}.
  Creation adds confirmation=CREATE POLICY. Resource preview accepts
  {networkId,serviceId,resource:{name,address,groups,enabled,description?}}. Apply adds
  confirmation=CREATE RESOURCE. Existing resources use explicit MAP INFRASTRUCTURE.
  These operations expose control-plane results and never assert device traffic proof.
- Invitations return a sensitive token once. Redemption requires Pocket ID login;
  possession grants no entitlements/roles. Setup-key secrets are creation-only and
  never used as a substitute for peer removal.
- Guides are Markdown without raw HTML, have immutable numbered revisions and
  version-specific acknowledgments. Guide PDFs are protected. Onboarding progress
  uses profile/rules/network-guidance/devices/browse/service-setup.
- Signed incoming health is a public-authenticated exception: POST a compact object
  {checkId,state,timestamp,nonce,vantage}; sign JSON.stringify of the parsed object,
  preserving property insertion order, with HMAC-SHA256 using HEALTH_WEBHOOK_KEY.
  Send lowercase hex X-Portcullis-Signature. Timestamp is milliseconds, within five
  minutes; nonce is unique (16–100 characters). Only configured incoming checks are
  writable; replay returns 409. No cookie authorization is used on this endpoint.
- Health summaries combine cached component observations and dependency paths.
  A required failure reports down; an optional failure reports degraded. Stale or
  missing observations stay stale/unknown. Measured state remains separate from
  maintenance and dependency state. Dependency identities are admin-only.
- Maintenance start brings a future window forward; end cancels a future window
  immediately or ends a running one. Incident lists include authorized timelines.
- /api/admin/access-configuration provides entitlement prerequisites, bindings and
  bundle contents to access administrators for version-checked edits.
- Audit filters action and subject; export=true returns an authorized JSON download.
  Notification preferences select smtp/discord/webhook; persistent in-app updates
  work with every external channel disabled. Optional channel failure retries separately.

## Endpoint index

Public exceptions: /auth/login, /auth/callback, minimal /healthz and /readyz, static
assets, and signed /api/health/incoming. /auth/logout requires session and CSRF.
Provider credentials stay server-side; there is no generic provider proxy.

| Method | Endpoint |
| --- | --- |
| GET | `/api/access` |
| GET | `/api/admin` |
| GET | `/api/admin/access-configuration` |
| GET | `/api/admin/audit` |
| GET | `/api/admin/bindings` |
| POST | `/api/admin/bindings` |
| GET | `/api/admin/grants` |
| POST | `/api/admin/jobs/:id/retry` |
| GET | `/api/admin/links` |
| POST | `/api/admin/links` |
| GET | `/api/admin/network` |
| GET | `/api/admin/network/advanced` |
| POST | `/api/admin/network/groups` |
| POST | `/api/admin/network/policies` |
| POST | `/api/admin/network/policy-preview` |
| POST | `/api/admin/network/resource-preview` |
| POST | `/api/admin/network/resources` |
| POST | `/api/admin/network/resources/map` |
| POST | `/api/admin/network/routers` |
| POST | `/api/admin/network/setup-keys` |
| POST | `/api/admin/network/setup-keys/:id/revoke` |
| GET | `/api/admin/pocket-id` |
| POST | `/api/admin/pocket-id/groups` |
| POST | `/api/admin/pocket-id/users` |
| POST | `/api/admin/pocket-id/users/:externalId/enrollment` |
| GET | `/api/admin/preview/:id` |
| POST | `/api/admin/secrets` |
| GET | `/api/admin/steps` |
| POST | `/api/admin/steps/:id/removal-attest` |
| GET | `/api/admin/users` |
| POST | `/api/admin/users/:id/offboard` |
| POST | `/api/admin/users/:id/refresh-identity` |
| GET, PUT | `/api/admin/users/:id/roles` |
| POST | `/api/admin/users/:id/suspend` |
| GET | `/api/admin/waygate` |
| POST | `/api/announcements` |
| GET | `/api/approvals` |
| GET | `/api/bundles` |
| POST | `/api/bundles` |
| PUT | `/api/bundles/:id` |
| GET | `/api/devices` |
| DELETE | `/api/devices/:id` |
| POST | `/api/devices/:id/lost` |
| GET | `/api/entitlements` |
| POST | `/api/entitlements` |
| PUT | `/api/entitlements/:id` |
| POST | `/api/files/:id` |
| POST | `/api/grants` |
| POST | `/api/grants/:id/renew` |
| POST | `/api/grants/:id/revoke` |
| GET | `/api/guides` |
| POST | `/api/guides` |
| PUT | `/api/guides/:id` |
| POST | `/api/guides/:id/accept` |
| GET | `/api/guides/:id/files` |
| GET | `/api/guides/:id/history` |
| GET | `/api/health/checks` |
| POST | `/api/health/checks` |
| POST | `/api/health/checks/:id/manual` |
| POST | `/api/health/incoming` |
| POST | `/api/incidents` |
| POST | `/api/incidents/:id` |
| GET | `/api/incidents/:id/timeline` |
| POST | `/api/invitations` |
| DELETE | `/api/invitations/:id` |
| POST | `/api/invitations/redeem` |
| POST | `/api/maintenance` |
| POST | `/api/maintenance/:id/end` |
| POST | `/api/maintenance/:id/start` |
| GET | `/api/me` |
| PATCH | `/api/me` |
| GET | `/api/notices` |
| GET | `/api/notification-preferences` |
| PUT | `/api/notification-preferences` |
| GET | `/api/notifications` |
| POST | `/api/notifications/:id/read` |
| GET | `/api/onboarding` |
| POST | `/api/onboarding` |
| GET | `/api/providers` |
| POST | `/api/requests` |
| POST | `/api/requests/:id/cancel` |
| POST | `/api/requests/:id/decide` |
| GET | `/api/services` |
| GET | `/api/game-metadata/search?q=:title` |
| GET | `/api/game-metadata/:providerId` |
| POST | `/api/services` |
| DELETE | `/api/services/:id` |
| GET | `/api/services/:id` |
| PUT | `/api/services/:id` |
| PUT | `/api/services/:id/favorite` |
| GET | `/api/services/:id/rdp` |
| GET | `/api/services/:id/waygate` |
| POST | `/api/steps/:id/attest` |
| GET | `/api/tickets` |
| POST | `/api/tickets` |
| GET | `/api/tickets/:id` |
| PATCH | `/api/tickets/:id` |
| POST | `/api/tickets/:id/comments` |
| GET | `/auth/callback` |
| GET | `/auth/login` |
| POST | `/auth/logout` |
| GET | `/files/:id` |
| GET | `/healthz` |
| GET | `/readyz` |
