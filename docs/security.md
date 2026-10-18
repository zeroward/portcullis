# Security model and limits

Trust boundaries: browser → same-origin Fastify → PostgreSQL, existing Pocket ID,
existing NetBird, and explicitly approved monitoring/delivery destinations. Roles,
service scope and object ownership are checked server-side. Browser-hidden fields
are filtered before serialization. Static frontend assets, /auth/login/callback,
/healthz and /readyz are narrow public exceptions. Incoming health requires HMAC
and replay protection. Every other /api or /files request requires a live session.

Opaque session tokens are hashed in PostgreSQL; cookies are HttpOnly, SameSite=Lax
and Secure in production. Login rotates sessions. Idle expiry is 30 minutes; absolute
expiry eight hours; privileged changes require authentication within 15 minutes and
an explicit action confirmation. Identity/group refresh is bounded to five minutes.
Suspension and local role changes delete sessions. Permission mappings are operator
configuration; no email identity keys, forwarded-identity trust or first-user owner.

Cookie writes require matching Origin and per-session CSRF token. CORS is not opened
to other origins. Helmet CSP blocks script/object embedding; Markdown renders via
react-markdown without raw HTML, with safe link transforms. URL configuration rejects
credentials and dangerous schemes. Launch schemes are HTTP(S), steam and rdp only;
generated RDP files include no credentials and reject CR/LF injection.

Provider URLs and outgoing delivery destinations are configured by operators, never
proxied from browser input. Redirects are rejected, API responses capped at 2 MB,
operations bounded by timeout. Non-idempotent POST timeouts are ambiguous and are not
automatically retried. An operator must inspect and map the created object rather
than adopt by name or blindly repeat creation. Managed IDs/edge provenance constrain
reconciliation. Cross-provider effects are not atomic; failed removal remains visible.

Monitoring resolves and checks every DNS answer, pins the approved address for the
connection, limits ports/schemes, blocks redirects/metadata/link-local targets and
caps response size/time. Private ranges require explicit CIDR approval; public
domains require explicit allowlisting unless their address is approved. Production
loopback is forbidden. Card rendering reads cached observations, not live network probes.

Uploads require ticket/guide access, are limited to 5 MB, use UUID storage paths,
validate MIME/signatures, and download as attachments with nosniff. PDF uploads are
restricted to authorized guide editors. There is no malware scanning claim; operators
should use trusted sources. Diagnostics warn users to remove secrets.

Stored secret references use AES-256-GCM with ENCRYPTION_KEY outside the database.
Provider credentials may instead remain in protected environment files. Keep both
out of source control. Request logging is disabled; explicit error/audit output is
sanitized and generic. Creation-only enrollment secrets are not logged or notified.
Audit has an update/delete rejection trigger, but a database administrator can alter
the database or trigger; this is not a tamper-proof ledger.

Remaining deployment responsibilities: TLS/trusted proxy configuration, token scopes,
provider version checks, physical device enforcement tests, OS/browser handlers,
backup key custody and restore rehearsal. No production deployment has been attempted.
