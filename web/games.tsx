import React, { useEffect, useState, useRef } from "react";
import { api } from "./api.js";
import { Modal } from "./ui.js";
import { GameMetadataLookup } from "./forms/editor.js";
type Row = Record<string, any>;
const message = (e: unknown) => (e as Error).message.replaceAll("_", " ");
const address = (e: Row) =>
  `${e.host.includes(":") && !e.host.startsWith("[") ? `[${e.host}]` : e.host}:${e.ports?.[0] ?? e.port}`;
const blankPresentation = () => ({
  name: "",
  summary: "",
  description: "",
  cover: "",
});
let draft: Row | undefined;
function Art({ game }: { game: Row }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [game.cover]);
  return (
    <div className="game-art">
      {game.cover && !failed ? (
        <img
          src={game.cover}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">
          {game.name?.slice(0, 2).toUpperCase() || "PC"}
        </span>
      )}
    </div>
  );
}
export function GamesLibrary({
  user,
  nav,
  editServer,
}: {
  user: Row;
  nav: (page: string) => void;
  editServer: (server: Row, done: () => void) => React.ReactNode;
}) {
  const [games, setGames] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [selected, setSelected] = useState<string>(),
    [setup, setSetup] = useState(false),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [editing, setEditing] = useState<Row>(),
    [presentation, setPresentation] = useState<Row>(),
    [deleting, setDeleting] = useState<Row>(),
    [confirmation, setConfirmation] = useState(""),
    [deleteError, setDeleteError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const canManage = user.roles.some(
    (r: Row) => r.scope === "*" && ["owner", "service-admin"].includes(r.role),
  );
  async function refresh() {
    try {
      setGames(await api("/api/games"));
      setError("");
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, []);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const game = games.find((g) => g.id === selected);
  const rows = games.filter(
    (g) =>
      (canManage || g.servers.length) &&
      `${g.name} ${g.summary} ${g.servers.map((s: Row) => s.name).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "favorites" && g.favorite) ||
        (filter === "mine" &&
          g.servers.some((s: Row) => s.access === "active"))),
  );
  if (setup)
    return (
      <GameSetup
        games={games}
        initialGame={selected}
        cancel={() => setSetup(false)}
        done={async (ids: string[]) => {
          draft = undefined;
          await refresh();
          setSetup(false);
          setSelected(ids.length === 1 ? ids[0] : undefined);
          setNotice(
            `${ids.length} ${ids.length === 1 ? "game" : "games"} ready in your library.`,
          );
        }}
      />
    );
  return (
    <section className="games-experience">
      {error && (
        <div className="banner" role="alert">
          {error} <button onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {game ? (
        <>
          <button
            className="text-button"
            onClick={() => setSelected(undefined)}
          >
            ← Your library
          </button>
          <div className="game-hero">
            <Art game={game} />
            <div>
              <p className="eyebrow">YOUR COMMUNITY · YOUR GAME</p>
              <h1>{game.name}</h1>
              <p>{game.summary}</p>
              <div className="game-actions">
                <button
                  disabled={busy}
                  aria-pressed={game.favorite}
                  onClick={() =>
                    void action(() =>
                      api(`/api/games/${game.id}/favorite`, "PUT", {
                        favorite: !game.favorite,
                      }),
                    )
                  }
                >
                  {game.favorite ? "★ Favorited" : "☆ Favorite"}
                </button>
                {canManage && (
                  <>
                    <button
                      onClick={() => {
                        draft = undefined;
                        setSetup(true);
                      }}
                    >
                      Add server
                    </button>
                    <button
                      onClick={() => setPresentation({ ...game.presentation })}
                    >
                      Edit game
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          api("/api/game-imports/refresh", "POST", {}),
                        )
                      }
                    >
                      Refresh connections
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="game-detail-layout">
            <section>
              <h2>Choose your server</h2>
              <p className="muted">Find your people. Pick a world.</p>
              {!game.servers.length && (
                <div className="game-empty">
                  No servers yet. Add one to make this game available to
                  players.
                </div>
              )}
              {game.servers.map((s: Row) => {
                const unavailable = s.sync?.state === "unavailable";
                return (
                  <article className="server-row" key={s.id}>
                    <div className="server-row-heading">
                      <h3>{s.name}</h3>
                      <span
                        className={`status-dot ${unavailable ? "down" : s.health.state}`}
                      >
                        {unavailable ? "Unavailable" : s.health.state}
                      </span>
                    </div>
                    {s.sync?.state === "stale" && (
                      <p className="muted">
                        Connection sync delayed · showing last known details
                      </p>
                    )}
                    {unavailable && (
                      <p>
                        This server is unavailable.{" "}
                        {s.canManage
                          ? "Check its access and allocation in Pterodactyl."
                          : "Please check back later."}
                      </p>
                    )}
                    {s.metadata ? (
                      s.metadata.endpoints.map((e: Row, i: number) => (
                        <div className="server-connection" key={i}>
                          <code>{address(e)}</code>
                          <button
                            disabled={unavailable}
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(address(e));
                                setNotice(`Copied address for ${s.name}.`);
                              } catch {
                                setError(
                                  "Could not copy. Select the address and copy it manually.",
                                );
                              }
                            }}
                          >
                            Copy address
                          </button>
                          {e.launch && !unavailable && (
                            <a className="button primary" href={e.launch}>
                              Launch game ↗
                            </a>
                          )}
                        </div>
                      ))
                    ) : (
                      <div>
                        <p>Access is required to see connection details.</p>
                        <button onClick={() => nav("access")}>
                          Request access
                        </button>
                      </div>
                    )}
                    {s.metadata?.instructions && (
                      <p className="server-instructions">
                        {s.metadata.instructions}
                      </p>
                    )}
                    {s.canManage && (
                      <div className="game-actions">
                        <button
                          onClick={async () => {
                            try {
                              setEditing(await api(`/api/services/${s.id}`));
                            } catch (e) {
                              setError(message(e));
                            }
                          }}
                        >
                          Server settings
                        </button>
                        {canManage && (
                          <label>
                            Move to game
                            <select
                              value=""
                              disabled={busy}
                              onChange={(e) => {
                                if (e.target.value)
                                  void action(() =>
                                    api(
                                      `/api/game-servers/${s.id}/game`,
                                      "PUT",
                                      { gameId: e.target.value },
                                    ),
                                  );
                              }}
                            >
                              <option value="">Choose game…</option>
                              {games
                                .filter((g) => g.id !== game.id)
                                .map((g) => (
                                  <option value={g.id} key={g.id}>
                                    {g.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                        )}
                        {s.sync && (
                          <ConnectionOverride server={s} done={refresh} />
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </section>
            <aside>
              <h2>About the game</h2>
              <p className="game-description">
                {game.description || "Your next adventure starts here."}
              </p>
              {game.source?.url && (
                <a href={game.source.url} target="_blank" rel="noreferrer">
                  Game information from RAWG ↗
                </a>
              )}
            </aside>
          </div>
        </>
      ) : (
        <>
          <div className="page-heading">
            <div>
              <p className="eyebrow">THE COMMUNITY COLLECTION</p>
              <h1>Your next adventure.</h1>
              <p>Great games. Familiar faces. A place to play together.</p>
            </div>
            {canManage && (
              <button className="primary" onClick={() => setSetup(true)}>
                {draft ? "Resume setup" : "+ Add game"}
              </button>
            )}
          </div>
          <div className="toolbar">
            <div className="tabs" aria-label="Game collection">
              {[
                ["all", "All games"],
                ["mine", "My games"],
                ["favorites", "Favorites"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  aria-pressed={filter === key}
                  className={filter === key ? "selected" : ""}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="search">
              <span className="sr-only">Search games and servers</span>
              <input
                placeholder="Find a game or server…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          {loading ? (
            <div
              className="game-grid"
              aria-label="Loading games"
              aria-busy="true"
            >
              {[1, 2, 3].map((i) => (
                <div key={i} className="game-skeleton" />
              ))}
            </div>
          ) : !rows.length ? (
            <div className="game-empty">
              <h2>
                {query || filter !== "all"
                  ? "No matching games"
                  : "Make room for your next favorite."}
              </h2>
              <p>
                {query || filter !== "all"
                  ? "Try another search or collection."
                  : canManage
                    ? "Add a server manually or bring your worlds over from Pterodactyl."
                    : "Your community’s games will appear here."}
              </p>
            </div>
          ) : (
            <div className="game-grid">
              {rows.map((g) => (
                <article className="game-tile" key={g.id}>
                  <button
                    className="game-open"
                    onClick={() => {
                      setSelected(g.id);
                      setNotice("");
                    }}
                  >
                    <Art game={g} />
                    <div className="game-tile-copy">
                      <h2>{g.name}</h2>
                      <p>{g.summary || "Discover your community’s servers."}</p>
                      <span>
                        {g.servers.length
                          ? `${g.servers.length} ${g.servers.length === 1 ? "server" : "servers"} · ${g.servers.some((s: Row) => s.sync?.state !== "unavailable" && s.health.state === "healthy") ? `${g.servers.filter((s: Row) => s.sync?.state !== "unavailable" && s.health.state === "healthy").length} online` : g.servers.every((s: Row) => s.sync?.state === "unavailable" || s.health.state === "down") ? "Unavailable" : "Status unconfirmed"}`
                          : "No servers yet"}
                      </span>
                    </div>
                  </button>
                  <button
                    className="game-favorite"
                    aria-label={`${g.favorite ? "Unfavorite" : "Favorite"} ${g.name}`}
                    aria-pressed={g.favorite}
                    disabled={busy}
                    onClick={() =>
                      void action(() =>
                        api(`/api/games/${g.id}/favorite`, "PUT", {
                          favorite: !g.favorite,
                        }),
                      )
                    }
                  >
                    {g.favorite ? "★" : "☆"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {editing && (
        <Modal title="Server settings" close={() => setEditing(undefined)}>
          {editServer(editing, () => {
            setEditing(undefined);
            void refresh();
          })}
        </Modal>
      )}
      {presentation && game && (
        <Modal title="Edit game" close={() => setPresentation(undefined)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await api(`/api/games/${game.id}`, "PUT", {
                  presentation,
                  version: game.version,
                });
                setPresentation(undefined);
              });
            }}
          >
            <PresentationFields value={presentation} change={setPresentation} />
            <button disabled={busy} className="primary">
              Save game
            </button>
          </form>
          <section className="setup-panel">
            <h3>Delete game</h3>
            <p>
              Remove this game from the library. Move or remove its server
              entries first.
            </p>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                setDeleting(game);
                setPresentation(undefined);
                setConfirmation("");
                setDeleteError("");
              }}
            >
              Delete game…
            </button>
          </section>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={`Delete ${deleting.name}?`}
          close={() => {
            if (!busy) setDeleting(undefined);
          }}
        >
          {deleting.servers.length ? (
            <>
              <p>
                This game still contains {deleting.servers.length} server{" "}
                {deleting.servers.length === 1 ? "entry" : "entries"}. Move them
                to another game or remove them in Server settings before
                deleting the game.
              </p>
              <button onClick={() => setDeleting(undefined)}>
                Back to game
              </button>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setDeleteError("");
                try {
                  await api(`/api/games/${deleting.id}`, "DELETE", {
                    confirmation,
                    version: deleting.version,
                  });
                  setDeleting(undefined);
                  setSelected(undefined);
                  setNotice(`${deleting.name} was deleted from the library.`);
                  await refresh();
                } catch (e) {
                  const code = (e as Error).message;
                  setDeleteError(
                    code === "game_has_servers"
                      ? "A server was added to this game. Close this dialog and move or remove its servers first."
                      : code === "version_conflict"
                        ? "This game changed. Close this dialog and reopen it to review the latest version."
                        : code === "reauthentication_required"
                          ? "Refresh your sign-in before deleting this game."
                          : message(e),
                  );
                  await refresh();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p>
                This permanently removes the empty game and its favorites from
                Portcullis. It does not delete any actual game server.
              </p>
              <label>
                Type DELETE to confirm
                <input
                  autoComplete="off"
                  required
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  disabled={busy}
                />
              </label>
              {deleteError && <p role="alert">{deleteError}</p>}
              <div className="game-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDeleting(undefined)}
                >
                  Cancel
                </button>
                <button
                  className="danger"
                  disabled={busy || confirmation !== "DELETE"}
                >
                  {busy ? "Deleting…" : "Delete game"}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </section>
  );
}
function ConnectionOverride({
  server,
  done,
}: {
  server: Row;
  done: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [host, setHost] = useState(server.sync.override?.host ?? ""),
    [port, setPort] = useState(server.sync.override?.port ?? 25565),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(value: unknown) {
    setBusy(true);
    try {
      await api(`/api/game-servers/${server.id}/override`, "PUT", value);
      await done();
      setOpen(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button onClick={() => setOpen(true)}>Player address override</button>
      {open && (
        <Modal title="Player-facing address" close={() => setOpen(false)}>
          <p>
            Source allocations stay synchronized. An override controls the
            address shown to players.
          </p>
          {server.sync.source && (
            <p>
              Synced address: <code>{address(server.sync.source)}</code>
            </p>
          )}
          {server.sync.syncedAt && (
            <small>
              Last synchronized{" "}
              {new Date(server.sync.syncedAt).toLocaleString()}
            </small>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save({ host, port });
            }}
          >
            <label>
              Hostname or IP
              <input
                required
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </label>
            <label>
              Port
              <input
                type="number"
                min="1"
                max="65535"
                required
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <button disabled={busy}>Save override</button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(null)}
            >
              Use synced address
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
function PresentationFields({
  value,
  change,
}: {
  value: Row;
  change: (v: Row) => void;
}) {
  return (
    <>
      <label>
        Game title
        <input
          required
          minLength={2}
          maxLength={100}
          value={value.name}
          onChange={(e) => change({ ...value, name: e.target.value })}
        />
      </label>
      <label>
        Short description
        <input
          maxLength={240}
          value={value.summary}
          onChange={(e) => change({ ...value, summary: e.target.value })}
        />
      </label>
      <label>
        Artwork URL
        <input
          type="url"
          value={value.cover}
          onChange={(e) => change({ ...value, cover: e.target.value })}
        />
      </label>
      <label>
        About this game
        <textarea
          value={value.description}
          onChange={(e) => change({ ...value, description: e.target.value })}
        />
      </label>
    </>
  );
}
function GameSetup({
  games,
  initialGame,
  cancel,
  done,
}: {
  games: Row[];
  initialGame?: string;
  cancel: () => void;
  done: (ids: string[]) => Promise<void>;
}) {
  const [state, setState] = useState<Row>(
    () =>
      draft ?? {
        submissionId: crypto.randomUUID(),
        step: 0,
        mode: "manual",
        games: [
          {
            key: "first",
            ...(initialGame ? { id: initialGame } : {}),
            presentation:
              games.find((g) => g.id === initialGame)?.presentation ??
              blankPresentation(),
          },
        ],
        servers: [],
        access: "",
      },
  );
  const [inventory, setInventory] = useState<Row[]>([]),
    [entitlements, setEntitlements] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState("");
  const update = (changes: Row) => setState((s: Row) => ({ ...s, ...changes }));
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [error]);
  useEffect(() => {
    draft = state;
  }, [state]);
  useEffect(() => {
    void api("/api/entitlements")
      .then(setEntitlements)
      .catch(() => {});
    const leave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, []);
  async function browse() {
    setBusy(true);
    setError("");
    try {
      setInventory(await api("/api/game-imports"));
      update({ mode: "pterodactyl", step: 1, servers: [] });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function serverChange(index: number, changes: Row) {
    update({
      servers: state.servers.map((s: Row, i: number) =>
        i === index ? { ...s, ...changes } : s,
      ),
    });
  }
  function select(source: Row) {
    const existing = state.servers.some(
      (s: Row) => s.identifier === source.identifier,
    );
    const allocation = source.allocations.find((a: Row) => a.is_default);
    update({
      servers: existing
        ? state.servers.filter((s: Row) => s.identifier !== source.identifier)
        : [
            ...state.servers,
            {
              name: source.name,
              identifier: source.identifier,
              allocations: source.allocations,
              allocationId: allocation?.id,
              host: allocation?.ip_alias || allocation?.ip || "",
              port: allocation?.port ?? 25565,
              gameKey: "first",
              access: "",
              entitlementIds: [],
              launch: "",
              protocol: "",
              tcp: false,
            },
          ],
    });
  }
  function next() {
    setError("");
    update({ step: state.step + 1 });
  }
  const accessFields = (value: string, onChange: (v: string) => void) => (
    <select required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>
        Choose who can connect…
      </option>
      <option value="everyone">Everyone signed in</option>
      <option value="restricted">Visible, access required</option>
      <option value="entitled">Only entitled users</option>
      <option value="admin">Admins only</option>
    </select>
  );
  async function publish() {
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/game-setups", "POST", {
        submissionId: state.submissionId,
        games: state.games.filter((g: Row) =>
          state.servers.some((s: Row) => s.gameKey === g.key),
        ),
        servers: state.servers.map((s: Row) => ({
          name: s.name,
          gameKey: s.gameKey,
          ...(s.identifier
            ? {
                identifier: s.identifier,
                allocationId: s.allocationId,
                ...(s.useOverride
                  ? { override: { host: s.host, port: Number(s.port) } }
                  : {}),
              }
            : { connection: { host: s.host, port: Number(s.port) } }),
          visibility: ["everyone", "restricted"].includes(s.access)
            ? "discoverable"
            : s.access,
          entitlementIds: ["restricted", "entitled"].includes(s.access)
            ? s.entitlementIds
            : [],
          tcp: !!s.tcp,
          ...(s.protocol ? { protocol: s.protocol } : {}),
          launch: s.launch || "",
        })),
      });
      await done(result.gameIds);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="games-experience game-setup">
      <button className="text-button" disabled={busy} onClick={cancel}>
        ← Save draft and return
      </button>
      <div className="page-heading">
        <div>
          <p className="eyebrow">BUILD YOUR COLLECTION</p>
          <h1>A new place to play.</h1>
        </div>
        <button
          disabled={busy}
          onClick={() => {
            draft = undefined;
            cancel();
          }}
        >
          Discard draft
        </button>
      </div>
      <nav className="setup-progress" aria-label="Setup progress">
        {["Source", "Servers", "Games", "Connections & access", "Review"].map(
          (label, i) => (
            <button
              key={label}
              aria-current={state.step === i ? "step" : undefined}
              disabled={i > state.step || busy}
              onClick={() => update({ step: i })}
            >
              <span>{i + 1}</span>
              {label}
            </button>
          ),
        )}
      </nav>
      {error && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="banner">
          {error}
        </div>
      )}
      <div className="game-setup-layout">
        <div>
          {state.step === 0 && (
            <div className="source-options">
              <button
                onClick={() =>
                  update({
                    mode: "manual",
                    step: 2,
                    servers: [
                      {
                        name: "",
                        host: "",
                        port: 25565,
                        gameKey: "first",
                        access: "",
                        entitlementIds: [],
                        tcp: false,
                        protocol: "",
                        launch: "",
                      },
                    ],
                  })
                }
              >
                <h2>Add manually</h2>
                <p>Any game. Any host. Bring your server address.</p>
              </button>
              <button disabled={busy} onClick={() => void browse()}>
                <h2>{busy ? "Connecting…" : "Import from Pterodactyl"}</h2>
                <p>
                  Choose your servers. We’ll keep connection details in sync.
                </p>
              </button>
            </div>
          )}
          {state.step === 1 && (
            <>
              <h2>Bring your worlds with you.</h2>
              <label>
                Find servers
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search your Pterodactyl servers…"
                />
              </label>
              {!inventory.length && (
                <p>
                  No servers loaded.{" "}
                  <button disabled={busy} onClick={() => void browse()}>
                    Reload servers
                  </button>
                </p>
              )}
              {inventory
                .filter((s) =>
                  s.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((s) => (
                  <label className="import-choice" key={s.identifier}>
                    <input
                      type="checkbox"
                      disabled={!!s.imported}
                      checked={state.servers.some(
                        (v: Row) => v.identifier === s.identifier,
                      )}
                      onChange={() => select(s)}
                    />
                    <span>
                      <strong>{s.name}</strong>
                      <small>
                        {s.imported
                          ? "Already in your library"
                          : s.description || s.identifier}
                      </small>
                    </span>
                  </label>
                ))}
              <button
                className="primary"
                disabled={!state.servers.length}
                onClick={next}
              >
                Continue with {state.servers.length} servers
              </button>
            </>
          )}
          {state.step === 2 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                next();
              }}
            >
              <h2>Give your worlds a home.</h2>
              <p>
                Choose a game for each server. Confirm a RAWG match or create
                your own presentation.
              </p>
              {state.games.map((g: Row, index: number) => (
                <section className="setup-panel" key={g.key}>
                  <label>
                    Game
                    <select
                      value={g.id ?? ""}
                      onChange={(e) =>
                        update({
                          games: state.games.map((v: Row, i: number) =>
                            i === index
                              ? {
                                  key: v.key,
                                  ...(e.target.value
                                    ? { id: e.target.value }
                                    : {}),
                                  presentation:
                                    games.find((x) => x.id === e.target.value)
                                      ?.presentation ?? blankPresentation(),
                                }
                              : v,
                          ),
                        })
                      }
                    >
                      <option value="">Create a new game</option>
                      {games.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!g.id && (
                    <>
                      <GameMetadataLookup
                        name={
                          g.presentation.name ||
                          state.servers[index]?.name ||
                          ""
                        }
                        apply={(v) =>
                          update({
                            games: state.games.map((x: Row, i: number) =>
                              i === index
                                ? {
                                    ...x,
                                    presentation: {
                                      name: v.name,
                                      summary: v.summary,
                                      description: v.description,
                                      cover: v.cover ?? "",
                                      source: v.source,
                                    },
                                  }
                                : x,
                            ),
                          })
                        }
                      />
                      <PresentationFields
                        value={g.presentation}
                        change={(v) =>
                          update({
                            games: state.games.map((x: Row, i: number) =>
                              i === index ? { ...x, presentation: v } : x,
                            ),
                          })
                        }
                      />
                    </>
                  )}
                </section>
              ))}
              <button
                type="button"
                onClick={() =>
                  update({
                    games: [
                      ...state.games,
                      {
                        key: crypto.randomUUID(),
                        presentation: blankPresentation(),
                      },
                    ],
                  })
                }
              >
                + Another game
              </button>
              {state.servers.map((s: Row, i: number) => (
                <label key={s.identifier ?? i}>
                  {s.name || "New server"} belongs to
                  <select
                    value={s.gameKey}
                    onChange={(e) =>
                      serverChange(i, { gameKey: e.target.value })
                    }
                  >
                    {state.games.map((g: Row) => (
                      <option key={g.key} value={g.key}>
                        {g.presentation.name || "Untitled game"}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <button className="primary">Continue</button>
            </form>
          )}
          {state.step === 3 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  state.servers.some(
                    (s: Row) =>
                      ["restricted", "entitled"].includes(s.access) &&
                      !s.entitlementIds.length,
                  )
                ) {
                  setError(
                    "Choose at least one required entitlement for restricted servers.",
                  );
                  return;
                }
                next();
              }}
            >
              <h2>Ready for your players.</h2>
              <label>
                Shared access choice
                {accessFields(state.access, (v) =>
                  update({
                    access: v,
                    servers: state.servers.map((s: Row) => ({
                      ...s,
                      access: v,
                    })),
                  }),
                )}
              </label>
              {state.servers.map((s: Row, i: number) => (
                <section className="setup-panel" key={s.identifier ?? i}>
                  <label>
                    Server nickname
                    <input
                      required
                      minLength={2}
                      maxLength={100}
                      value={s.name}
                      onChange={(e) =>
                        serverChange(i, { name: e.target.value })
                      }
                    />
                  </label>
                  {s.identifier && (
                    <>
                      <label>
                        Synced allocation
                        <select
                          value={s.allocationId ?? ""}
                          onChange={(e) => {
                            const a = s.allocations.find(
                              (v: Row) => v.id === Number(e.target.value),
                            );
                            serverChange(i, {
                              allocationId: a.id,
                              ...(!s.useOverride
                                ? { host: a.ip_alias || a.ip, port: a.port }
                                : {}),
                            });
                          }}
                        >
                          <option value="" disabled>
                            No allocation available
                          </option>
                          {s.allocations.map((a: Row) => (
                            <option key={a.id} value={a.id}>
                              {a.ip_alias || a.ip}:{a.port}
                              {a.is_default ? " · Default" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={!!s.useOverride}
                          onChange={(e) => {
                            const a = s.allocations.find(
                              (a: Row) => a.id === s.allocationId,
                            );
                            serverChange(i, {
                              useOverride: e.target.checked,
                              ...(!e.target.checked
                                ? {
                                    host: a?.ip_alias || a?.ip || "",
                                    port: a?.port ?? 25565,
                                  }
                                : {}),
                            });
                          }}
                        />
                        Use a different address for players
                      </label>
                    </>
                  )}
                  <div className="connection-fields">
                    <label>
                      Hostname or IP
                      <input
                        required
                        disabled={!!s.identifier && !s.useOverride}
                        value={s.host}
                        onChange={(e) =>
                          serverChange(i, { host: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Port
                      <input
                        type="number"
                        min="1"
                        max="65535"
                        required
                        disabled={!!s.identifier && !s.useOverride}
                        value={s.port}
                        onChange={(e) =>
                          serverChange(i, { port: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Access
                    {accessFields(s.access, (v) =>
                      serverChange(i, { access: v }),
                    )}
                  </label>
                  {["restricted", "entitled"].includes(s.access) && (
                    <fieldset>
                      <legend>Required entitlements</legend>
                      {entitlements.map((t) => (
                        <label className="checkbox" key={t.id}>
                          <input
                            type="checkbox"
                            checked={s.entitlementIds.includes(t.id)}
                            onChange={(e) =>
                              serverChange(i, {
                                entitlementIds: e.target.checked
                                  ? [...s.entitlementIds, t.id]
                                  : s.entitlementIds.filter(
                                      (id: string) => id !== t.id,
                                    ),
                              })
                            }
                          />
                          {t.name}
                        </label>
                      ))}
                      {!entitlements.length && (
                        <p>
                          No entitlements available. Create one in
                          Administration before restricting access.
                        </p>
                      )}
                    </fieldset>
                  )}
                  <p>
                    {s.identifier
                      ? "Health is checked through Pterodactyl."
                      : "Monitoring is optional."}
                  </p>
                  {!s.identifier && (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={s.tcp}
                        onChange={(e) =>
                          serverChange(i, { tcp: e.target.checked })
                        }
                      />
                      Check whether the TCP port is reachable
                    </label>
                  )}
                  <details>
                    <summary>Advanced connection settings</summary>
                    <label>
                      Transport
                      <select
                        value={s.protocol}
                        onChange={(e) =>
                          serverChange(i, { protocol: e.target.value })
                        }
                      >
                        <option value="">Unspecified</option>
                        <option>tcp</option>
                        <option>udp</option>
                      </select>
                    </label>
                    <label>
                      Application launch link
                      <input
                        value={s.launch}
                        onChange={(e) =>
                          serverChange(i, { launch: e.target.value })
                        }
                      />
                    </label>
                  </details>
                </section>
              ))}
              <button className="primary">Review before publishing</button>
            </form>
          )}
          {state.step === 4 && (
            <>
              <h2>Make it part of your collection.</h2>
              <p>Review what players will see before publishing.</p>
              {state.servers.map((s: Row, i: number) => (
                <article className="setup-panel" key={i}>
                  <h3>
                    {
                      state.games.find((g: Row) => g.key === s.gameKey)
                        ?.presentation.name
                    }{" "}
                    · {s.name}
                  </h3>
                  <code>{address(s)}</code>
                  <p>
                    Access:{" "}
                    {
                      (
                        {
                          everyone: "Everyone signed in",
                          restricted: "Visible, access required",
                          entitled: "Only entitled users",
                          admin: "Admins only",
                        } as Row
                      )[s.access]
                    }
                  </p>
                  {s.entitlementIds.length > 0 && (
                    <p>
                      Requires:{" "}
                      {s.entitlementIds
                        .map(
                          (id: string) =>
                            entitlements.find((e) => e.id === id)?.name ?? id,
                        )
                        .join(", ")}
                    </p>
                  )}
                  <p>
                    {s.identifier
                      ? "Pterodactyl health and connection sync"
                      : s.tcp
                        ? "TCP reachability check"
                        : "No monitoring"}
                    {s.useOverride ? " · Player address overridden" : ""}
                  </p>
                </article>
              ))}
              <button
                disabled={busy}
                className="primary"
                onClick={() => void publish()}
              >
                {busy
                  ? "Publishing…"
                  : `Publish ${state.servers.length} ${state.servers.length === 1 ? "server" : "servers"}`}
              </button>
            </>
          )}
        </div>
        <aside className="setup-preview">
          <p className="eyebrow">YOUR LIBRARY PREVIEW</p>
          {state.games
            .filter(
              (g: Row) =>
                state.servers.some((s: Row) => s.gameKey === g.key) ||
                state.step === 0,
            )
            .map((g: Row) => (
              <article className="game-tile" key={g.key}>
                <Art game={g.presentation} />
                <div className="game-tile-copy">
                  <h2>{g.presentation.name || "Your next adventure"}</h2>
                  <p>
                    {g.presentation.summary || "A new home for your community."}
                  </p>
                  <small>
                    {
                      state.servers.filter((s: Row) => s.gameKey === g.key)
                        .length
                    }{" "}
                    servers
                  </small>
                </div>
              </article>
            ))}
        </aside>
      </div>
    </section>
  );
}
