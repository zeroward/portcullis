# Pocket ID configuration

Use the existing Pocket ID instance. Register a confidential OIDC client with the
exact callback `https://portal.example/auth/callback`, authorization-code flow and
PKCE S256. Configure OIDC_ISSUER to the exact discovery issuer, OIDC_CLIENT_ID and
OIDC_CLIENT_SECRET. Server-side openid-client verifies state, nonce, issuer, audience,
expiry and signature (enableNonRepudiationChecks). No browser token storage.

Set the client's allowed groups explicitly. New clients with no groups allow no
users; select your designated community groups or deliberately unrestrict access.
See https://pocket-id.org/docs/configuration/allowed-groups. Do not use self-requestable
game entitlements as privileged portal role groups.

Set OWNER_SUBJECT to a known Pocket ID subject under the configured issuer before
first use. No arbitrary first user becomes owner. ROLE_GROUP_MAPPINGS is a JSON map
of explicitly trusted Pocket ID group names to portal roles, e.g.
`{"portal-support":["support"]}`. Unknown groups grant no privileges. Administrative
mapping of game groups refuses groups granting privileged portal roles, and workers
recheck that boundary before writes.

`OWNER_SUBJECT` matches the user's OIDC `sub` claim, not a Pocket ID group name.
The development example `dev-owner` is a mock user's subject. For ownership through
a real Pocket ID group named `dev-owner`, add `"dev-owner":["owner"]` to the existing
`ROLE_GROUP_MAPPINGS` JSON object. Use the group's exact name, not its friendly name.
Only include groups whose members should all have full portal administration access.
Restart/recreate the app and worker after changing environment configuration, then
use **Refresh sign-in** to obtain current group claims. With Docker Compose, use
`docker compose up -d app worker`; a plain restart does not reload `.env`.

Administrative integration is separate: POCKET_ID_URL is the instance origin and
POCKET_ID_API_KEY is a privileged API key from Pocket ID settings. The documented
X-API-KEY header is server-only. Configure expiry/rotation in Pocket ID. API schema
research is pinned in integration-compatibility.md. This is native API synchronization;
SCIM and LDAP are not required.

Identity administrators inspect directory users/groups, create non-admin users and
designated groups, and explicitly link provider IDs. Group fulfillment bindings
require both access management and identity management, fresh authentication and
MANAGE confirmation. Explicit managed edges preserve pre-existing memberships and
other users. LDAP-owned groups are rejected. Full-group replacements are serialized
across Portcullis workers; external administrators may still edit concurrently, so
readback reports conflicts instead of asserting atomicity.

One-time access tokens are implemented from the pinned upstream API, gated by
`"pocket.enrollment":true` after version verification. Without this capability the
client returns an administrative handoff. Token creation uses provider-default TTL;
share securely, never log or email automatically. Passkey registration remains in
Pocket ID. No generic password reset or public local-login bypass exists.

Group permissions refresh within five minutes using the directory API. If no API
client is configured, login is required again after this bound. Refresh failures
deny the request; old privileges are not silently reused. Local suspension/role
changes invalidate sessions immediately. Portal suspension does not disable the
global Pocket ID identity. Recovery is an authenticated operator database procedure
in operations.md, not a public password login.
