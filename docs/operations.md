# Operations, backup and recovery

Run migrations explicitly before app/worker startup. Readiness checks database schema
presence. Workers persist heartbeats and reconciliation outcomes; inspect failed jobs
and grants in Administration. Correct provider settings, then retry failed jobs.
Retries re-evaluate current desired state and cannot resurrect revoked grants.
Revocation takes higher queue priority than provisioning; portal access denies at
expiry even if external enforcement is delayed. Never clear failure flags merely
to make a dashboard green.

## Backup and restore

For a consistent whole-deployment backup, stop app and worker during the database /
upload snapshot. Keep `.env` and ENCRYPTION_KEY in a separately secured encrypted
backup; database/uploads alone cannot recover encrypted secrets. Do not print those
files into logs. Keep at least a daily copy, weekly offsite copy and quarterly restore
rehearsal, adjusted to the household's acceptable data loss.

Using the pinned production Compose PostgreSQL tooling:

```sh
docker compose stop app worker
docker compose exec -T db pg_dump -U portcullis -d portcullis -Fc > portcullis.dump
docker compose cp app:/app/uploads ./portcullis-uploads
docker compose start app worker
```

Store those artifacts with checksums and the application revision. Copy the upload
directory contents, not just a listing. For a cold physical backup, stop PostgreSQL
too and snapshot the complete volume; restore only with a compatible PostgreSQL major
version. Never copy a live data directory without PostgreSQL backup tooling.

Restore into an **isolated** Compose project/host with provider credentials removed
and worker stopped. Create an empty database, then:

```sh
docker compose exec -T db pg_restore -U portcullis -d portcullis --no-owner --exit-on-error < portcullis.dump
docker compose create app
docker compose cp ./portcullis-uploads/. app:/app/uploads
docker compose run --rm migrate
```

Restore `.env`/encryption key via the secret custody procedure. Ensure uploads belong
to the non-root app user. Before enabling the worker, smoke test /readyz, Pocket ID
test login, user/card/ticket/audit counts, a protected attachment, encrypted secret
decryption, grants and pending jobs. Check provider URLs against the target environment.
Only then enable orchestration with authorization. The automated suite tests a cold
physical PostgreSQL 18.4 copy and uploaded-file restore into a separate process.
On October 12, 2026, a separate production-mode Compose rehearsal also passed logical
pg_dump/pg_restore, upload recovery, record counts, protected attachment retrieval and
encrypted-secret decryption with a recovered test key. It used synthetic records and
database-inserted test sessions, with no live identity/network providers configured;
actual Pocket ID login and operator key custody remain deployment acceptance checks.

## Owner recovery

The operator can change OWNER_SUBJECT to a known identity under the configured issuer,
restart app, and log in through Pocket ID. To restore local roles or clear erroneous
suspension without opening a public password route, use a protected database console:

```sql
BEGIN;
SELECT id,issuer,subject,name FROM users WHERE issuer='https://id.example' AND subject='verified-subject';
-- Substitute only the UUID you just verified.
INSERT INTO roles(user_id,role,scope,source) VALUES ('verified-local-uuid','owner','*','operator') ON CONFLICT DO NOTHING;
UPDATE users SET suspended=false,auth_version=auth_version+1 WHERE id='verified-local-uuid';
DELETE FROM sessions WHERE user_id='verified-local-uuid';
COMMIT;
```

Record operator recovery in audit via the portal afterward. Pocket ID passkey/identity
recovery uses its documented procedure, not an invented password reset. When rotating
ENCRYPTION_KEY, stop writes, decrypt every secret with the old key and re-encrypt with
the new key under a protected maintenance procedure; keep old backups' keys. Do not
simply change the environment key and discard the previous one.

## Retention

Worker housekeeping expires sessions/login flows, removes webhook nonces after a day,
health observations after 90 days and completed jobs after 30 days. Failed jobs remain
until investigated. Audit, tickets, attachments and grants are retained by default;
operator-approved archival must preserve relationships and audit provenance. Runtime
structured logs use external bounded rotation (e.g. 30 days); no secret-bearing request
logs. Define local storage limits and review upload volume periodically.

## Opt-in live contract/enforcement checks

1. Obtain explicit authorization and name the existing deployment versions, designated
   test identities, peers, groups, resource addresses and allowed ports.
2. Read provider configuration and export the existing policies/group memberships.
   Confirm API-group ownership, OIDC allowed groups and indirect NetBird identity links.
3. Link only verified test users. Map only designated groups; preview a narrow TCP/UDP
   policy and review all independent broad-policy warnings.
4. Grant one test entitlement. Verify both directory membership and user auto-groups,
   existing-peer membership and newly enrolled-peer membership. Do not treat API success
   as a device traffic test. Test reachability from designated actual devices separately.
5. Revoke one of overlapping grants; confirm access justified by the other remains.
   Revoke/expire the last grant; verify control plane and independently test traffic.
   Report failed removal or broad-policy access paths without deleting unrelated policies.
6. Revoke a one-use setup key and show its enrolled peer remains; separately authorize
   peer removal if needed. Confirm unrelated users/resources/roles/memberships survive.
7. Record observed version differences and verification evidence in integration-compatibility.md.

No live mutation steps have been run. No credentials are required for local automated
contracts. Game controls remain unavailable pending the WoW API specification.
