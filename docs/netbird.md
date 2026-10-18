# NetBird configuration and ownership

Use the existing self-hosted management URL. NETBIRD_URL points to the API instance
origin (the client appends /api); NETBIRD_TOKEN is a server-side personal access
token, sent as `Authorization: Token …`. NETBIRD_MANAGEMENT_URL is the native client
management URL shown in enrollment guidance. Never give management tokens to users.

Set NETBIRD_VERSION to the actual deployment version. Optional Networks/Resources
calls require `"netbird.networks":true` after checking the pinned official schema
against the installation. An unavailable optional API returns a capability/error
state, not fake success. Read discovery covers users, peers, groups, policies,
accounts/settings, DNS, events, setup-key metadata, networks, resources and routers.

Network administrators explicitly verify local-user → NetBird-user links. Emails
are labels only; Pocket ID subjects are never assumed to equal NetBird IDs. Only
peers reported under the verified NetBird owner become My devices records. Missing
or stale observations become unknown; telemetry absent from the API remains null.

Create or explicitly designate API-managed source groups and map them to entitlements.
Do not combine API ownership with JWT/SCIM group synchronization. Groups issued by
another mechanism are rejected. Membership operations preserve user role, blocking
state, unrelated auto-groups, unrelated peers and resource associations. Record the
pre-existing state durably before writing, and read back after each operation.
Updating auto-groups applies future-peer intent; existing owned peers are explicitly
added to the group too. Reconciliation discovers newly enrolled peers.

Use a distinct approved destination group containing the server peer, or a narrow
Networks resource reached by an existing routing peer. Prefer mapping existing
infrastructure. Resource creation is limited to a single address/domain; no wildcard
domains, subnets, default routes or host enrollment. Routing associations use existing
peer IDs only. There is no legacy-route migration or host reconfiguration.

Policy preview lists groups and broad-policy warnings. Creation uses accept, explicit
TCP/UDP ports, distinct source/destination groups and bidirectional=false; All groups
are rejected. Existing broad policies are warnings and are never silently deleted.
Consequently removing a managed group is not proof that all independent paths are
blocked. Control-plane readback is explicitly separate from device traffic tests.

Setup keys are an administrator-only special case. Defaults follow the researched
API: one-off, usage_limit=1, minimum expires_in=86400 (one day). The schema does not
permit an invented shorter TTL; verify your version before changing this. Secrets
are returned only at creation and are not persisted. Key revocation preserves its
auto-groups and never removes enrolled peers. Peer removal is a separate confirmed,
audited operation with readback. Revoking an entitlement never blocks the user account.

Opt-in live checks require designated test users/peers/groups and explicit approval;
see operations.md. Local tests establish HTTP behavior and preservation, not actual
traffic enforcement in your deployment.
