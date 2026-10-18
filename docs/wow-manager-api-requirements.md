# Information required for a future WoW manager adapter

The manager API specification has not been supplied. No endpoints or request
payloads are proposed here. Supply:

- Supported versions, discovery, authentication and least-privilege scopes.
- Stable server/account/component identifiers and identity-link verification.
- Declared operations and their permission/confirmation requirements.
- Actual provisioning, revocation and role semantics; distinction between account
  disabling and deleting; preservation of pre-existing accounts and roles.
- Idempotency keys, async job status, safe readback after ambiguous timeouts,
  concurrency/version checks, error codes, retry/rate limits and pagination.
- Optional genuine health/player-count/log/status sources, time semantics,
  secret redaction and data ownership.
- Test instance/resources/fixtures and API schema/license.

Until these are available, use operator-configured cards, HTTP/TCP/Kuma health and
audited manual fulfillment. No direct database, SOAP, RCON, SSH or shell fallback.
