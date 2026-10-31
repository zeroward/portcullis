# Games library

Games is the default destination. A game owns its title, artwork, description,
RAWG attribution and favorites; each server retains its own connection details,
access requirements, dependencies and monitoring history. Services is a placeholder
for a later redesign; existing non-game records remain in the database and API.

## Adding games

Choose **Add manually** for a server address or **Import from Pterodactyl** to
select servers from the environment-configured instance. Assign the selected
servers to existing games or create new games, optionally using a confirmed RAWG
match. Choose access explicitly, review the published addresses, and publish.
Bulk publication is transactional and submission IDs make retries safe.
Drafts are retained in memory when returning to the library, not across reloads.

Manual servers may use TCP reachability monitoring or no monitoring. Imported
servers use Pterodactyl health. No power controls or performance monitoring are
provided. Application launch links are optional and validated; arbitrary ports
are never treated as sufficient evidence for a game-specific launch command.

## Connections and synchronization

Set `PTERODACTYL_URL` and `PTERODACTYL_CLIENT_TOKEN` on both the application and
worker. The Client API account must see the servers being imported. Default
allocations populate player addresses, preferring an allocation alias when one
exists. Review the address before publishing: an allocation alone does not prove
public reachability or identify TCP versus UDP.

The worker refreshes imported connection details every five minutes; administrators
can also refresh from a game detail page. Explicit player-facing overrides take
precedence over the source allocation. Titles, artwork, descriptions, access and
overrides are never replaced by synchronization.

A complete inventory response that no longer contains a server marks it unavailable.
Authentication/authorization failure also marks imports unavailable. Connection
actions are disabled until recovery. Transient provider failures retain the last
known address and show delayed synchronization; health observations expire normally.
No sync outcome deletes a server automatically.

## Upgrade

Back up the database, apply migrations with the existing migration command, then
start the updated application and worker. Migration `0005_games.sql` creates one
game per existing game-service record, preserving all server IDs and relationships
and copying game presentation and favorites. Games are not automatically merged.
Use **Move to game** on a server to group existing servers without losing history.

To remove an empty game, open **Edit game → Delete game**, then type `DELETE` to
confirm. Games containing server entries cannot be deleted; move or remove those
entries first. Deletion removes the game and its favorites, records an audit event,
and never sends deletion requests to Pterodactyl. Global catalog management and
a recent sign-in are required.

Existing Pterodactyl health checks are linked during the first browse/sync; existing
published endpoints become explicit overrides to preserve connectivity. Where
multiple old records reference the same panel server, only one receives the import
link; the other records and checks remain intact. Review these duplicates manually.

Old service creation APIs still create a game parent when `metadata.type` is `game`.
Linked server types cannot be changed to generic services. Synced addresses must
be edited through the player-address override instead of the legacy service editor.
Games APIs use the existing catalog and monitor permissions; shared presentation
and server moves require global catalog management.

New endpoints: `/api/games`, `/api/games/:id`, `/api/games/:id/favorite`,
`/api/game-setups`, `/api/game-imports`, `/api/game-imports/refresh`,
`/api/game-servers/:id/game`, and `/api/game-servers/:id/override`.

Keep the migration applied if reverting application binaries; do not drop the
game tables or game relationships as a routine rollback.
