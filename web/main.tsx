import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./style.css";
type Row = Record<string, any>;
let csrf = "";
async function api(url: string, method = "GET", body?: unknown) {
  const r = await fetch(url, {
    method,
    credentials: "same-origin",
    headers:
      method === "GET"
        ? {}
        : { "content-type": "application/json", "x-csrf-token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok)
    throw new Error(result.message ?? result.error ?? "Request failed");
  return result;
}
function useData<T = any>(url: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api(url));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, error, loading, refresh };
}
function State({
  error,
  loading,
  retry,
}: {
  error?: string;
  loading?: boolean;
  retry?: () => void;
}) {
  return error ? (
    <div className="error" role="alert">
      {error.replaceAll("_", " ")}{" "}
      {retry && <button onClick={retry}>Try again</button>}
    </div>
  ) : loading ? (
    <p className="muted" role="status">
      Loading…
    </p>
  ) : null;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
function AsyncButton({
  onClick,
  children,
  ...props
}: Omit<React.ComponentProps<"button">, "onClick"> & {
  onClick: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        {...props}
        disabled={props.disabled || busy}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await onClick();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
      </button>
      <State error={error} />
    </>
  );
}
function Pill({ value }: { value: string }) {
  return <span className={`pill ${value}`}>{value.replaceAll("-", " ")}</span>;
}
function Mark({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close} aria-labelledby="dialog-title">
      <div className="dialog-head">
        <h2 id="dialog-title">{title}</h2>
        <button onClick={close} aria-label="Close dialog">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
function date(value: string | null, timezone: string) {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timezone,
      }).format(new Date(value))
    : "No expiry";
}
function Form({
  children,
  onSubmit,
  label = "Save",
}: {
  children: React.ReactNode;
  onSubmit: (form: FormData) => Promise<unknown>;
  label?: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        setBusy(true);
        setError("");
        setSuccess("");
        try {
          await onSubmit(data);
          setSuccess("Saved.");
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      <State error={error} />
      {success && <p role="status">{success}</p>}
      <button className="primary" disabled={busy}>
        {busy ? "Saving…" : label}
      </button>
    </form>
  );
}
function Field({
  name,
  label,
  type = "text",
  value,
  required = true,
}: {
  name: string;
  label: string;
  type?: string;
  value?: string | number;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      {type === "textarea" ? (
        <textarea name={name} defaultValue={value} required={required} />
      ) : (
        <input
          name={name}
          type={type}
          defaultValue={value}
          required={required}
        />
      )}
    </label>
  );
}
function JsonAction({
  title,
  url,
  initial,
  method = "POST",
  done,
}: {
  title: string;
  url: string;
  initial: unknown;
  method?: string;
  done?: () => void;
}) {
  const [result, setResult] = useState<unknown>();
  return (
    <details className="panel">
      <summary>{title}</summary>
      <Form
        label={title}
        onSubmit={async (f) => {
          const result = await api(
            url,
            method,
            JSON.parse(String(f.get("json"))),
          );
          done?.();
          setResult(result);
          return result;
        }}
      >
        <label>
          Configuration (JSON)
          <textarea
            className="code"
            name="json"
            rows={8}
            defaultValue={JSON.stringify(initial, null, 2)}
          />
        </label>
      </Form>
      {result !== undefined && (
        <pre aria-label="Operation result">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </details>
  );
}
function DataTable({ rows, columns }: { rows: Row[]; columns: string[] }) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c.replaceAll("_", " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i}>
              {columns.map((c) => (
                <td key={c}>
                  {typeof r[c] === "object"
                    ? JSON.stringify(r[c])
                    : String(r[c] ?? "Unknown")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>No records to show.</Empty>
  );
}
function Upload({
  id,
  kind,
  done,
}: {
  id: string;
  kind: "ticket" | "guide";
  done: () => void;
}) {
  return (
    <Form
      label="Upload attachment"
      onSubmit={async (f) => {
        const form = new FormData();
        form.append("file", f.get("file")!);
        const r = await fetch(`/api/files/${id}?kind=${kind}`, {
          method: "POST",
          headers: { "x-csrf-token": csrf },
          body: form,
        });
        if (!r.ok) throw new Error((await r.json()).error);
        done();
      }}
    >
      <label>
        Attachment (5 MB max; PDF, PNG, JPEG or plain text)
        <input
          name="file"
          type="file"
          accept={kind === "guide" ? ".pdf" : ".pdf,.png,.jpg,.jpeg,.txt"}
          required
        />
      </label>
      <small>
        Remove passwords, tokens and personal secrets before attaching
        diagnostics.
      </small>
    </Form>
  );
}
function App() {
  const me = useData<Row>("/api/me");
  const [page, setPage] = useState(
    location.pathname === "/" ? "services" : location.pathname.slice(1),
  );
  const [light, setLight] = useState(false);
  useEffect(() => {
    if (me.data) csrf = me.data.csrf;
  }, [me.data]);
  useEffect(() => {
    document.documentElement.dataset.theme = light ? "light" : "dark";
  }, [light]);
  const nav = (next: string) => {
    setPage(next);
    history.pushState({}, "", next === "services" ? "/" : `/${next}`);
  };
  useEffect(() => {
    const pop = () =>
      setPage(
        location.pathname === "/" ? "services" : location.pathname.slice(1),
      );
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  if (me.loading)
    return (
      <main className="login">
        <div className="brand">▥ PORTCULLIS</div>
        <State loading />
      </main>
    );
  if (!me.data)
    return (
      <main className="login">
        <div className="brand">▥ PORTCULLIS</div>
        <h1>
          Your community.
          <br />
          <em>Connected.</em>
        </h1>
        <p>A home for your games, services and people.</p>
        <a className="button primary" href="/auth/login">
          Sign in with Pocket ID →
        </a>
        <small>Use your community account and passkey.</small>
        {me.error &&
          ![
            "unauthenticated",
            "session_expired",
            "identity_refresh_requires_login",
          ].includes(me.error) && <State error={me.error} retry={me.refresh} />}
      </main>
    );
  const user = me.data;
  const admin = user.roles.some((r: Row) => r.role !== "member");
  const roleLabels: Record<string, string> = {
    support: "Support",
    approver: "Approver",
    "service-admin": "Service administrator",
    "network-admin": "Network administrator",
    "identity-admin": "Identity administrator",
    owner: "Owner",
  };
  const roleLabel = user.roles.some((r: Row) => r.role === "owner")
    ? "Owner"
    : [
        ...new Set(
          user.roles.map((r: Row) => roleLabels[r.role]).filter(Boolean),
        ),
      ].join(" · ") || "Community member";
  const pages = [
    ["services", "◫", "Services"],
    ["access", "◇", "My access"],
    ["devices", "▱", "My devices"],
    ["tickets", "☷", "Support"],
    ["guides", "▤", "Guides"],
    ["onboarding", "◎", "Get started"],
    ["notices", "◉", "Community"],
    ["notifications", "♧", "Updates"],
    ...(admin ? [["admin", "⚙", "Administration"]] : []),
  ];
  return (
    <div className="shell">
      <aside>
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            nav("services");
          }}
        >
          ▥ PORTCULLIS
        </a>
        <p className="eyebrow">THE COMMUNITY GATEWAY</p>
        <nav aria-label="Main navigation">
          {pages.map(([id, icon, title]) => (
            <button
              key={id}
              className={page === id ? "selected" : ""}
              onClick={() => nav(id)}
              aria-current={page === id ? "page" : undefined}
            >
              <span aria-hidden>{icon}</span>
              {title}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setLight(!light)}>
            {light ? "◐ Dark theme" : "◑ Light theme"}
          </button>
          <strong>{user.name}</strong>
          <small>{roleLabel}</small>
          {user.development && <small>Development environment</small>}
          <AsyncButton
            onClick={async () => {
              await api("/auth/logout", "POST", {});
              location.assign("/");
            }}
          >
            Sign out
          </AsyncButton>
        </div>
      </aside>
      <div className="workspace">
        <header>
          <span>PRIVATE COMMUNITY / PORTAL</span>
          <a href="/auth/login">Refresh sign-in</a>
        </header>
        <main>
          <ErrorBoundary key={page}>
            {page === "services" ? (
              <Gallery user={user} nav={nav} />
            ) : page === "access" ? (
              <MyAccess user={user} />
            ) : page === "tickets" ? (
              <TicketPage user={user} />
            ) : page === "devices" ? (
              <DevicePage />
            ) : page === "guides" ? (
              <GuidePage />
            ) : page === "onboarding" ? (
              <Onboarding />
            ) : page === "notices" ? (
              <NoticePage />
            ) : page === "notifications" ? (
              <NotificationPage />
            ) : page === "admin" && admin ? (
              <AdminPage user={user} />
            ) : (
              <Empty>Page not found.</Empty>
            )}
          </ErrorBoundary>
        </main>
        <footer>
          Portcullis <span>Built for a community, connected by NetBird.</span>
        </footer>
      </div>
    </div>
  );
}
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    return this.state.error ? (
      <State error={this.state.error} retry={() => location.reload()} />
    ) : (
      this.props.children
    );
  }
}
function Gallery({ user, nav }: { user: Row; nav: (page: string) => void }) {
  const query = useData<Row[]>("/api/services");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [mode, setMode] = useState("all");
  const [detail, setDetail] = useState<Row>();
  const [request, setRequest] = useState<Row>();
  const [edit, setEdit] = useState<Row | null | undefined>();
  const canManage = user.roles.some((r: Row) =>
    ["owner", "service-admin"].includes(r.role),
  );
  const categories = [...new Set(query.data?.map((s) => s.category) ?? [])];
  const rows = (query.data ?? []).filter(
    (s) =>
      (category === "all" || s.category === category) &&
      (mode === "all" ||
        (mode === "mine" && s.access === "active") ||
        (mode === "favorites" && s.favorite)) &&
      `${s.name} ${s.summary} ${s.tags.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">A PLACE TO PLAY & CONNECT</p>
          <h1>Find your next adventure.</h1>
          <p>Everything the community has to offer, in one place.</p>
        </div>
        {canManage && (
          <button onClick={() => setEdit(null)}>+ Add service</button>
        )}
      </div>
      <div className="toolbar">
        <div className="tabs" aria-label="Service collection">
          {[
            ["all", "All available"],
            ["mine", "My services"],
            ["favorites", "Favorites"],
          ].map(([id, name]) => (
            <button
              key={id}
              className={mode === id ? "selected" : ""}
              onClick={() => setMode(id)}
            >
              {name}
            </button>
          ))}
        </div>
        <label className="search">
          <span className="sr-only">Search services</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search games, services, tags…"
          />
        </label>
        <label>
          <span className="sr-only">Category</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <State {...query} retry={query.refresh} />
      <div className="gallery">
        {rows.map((s, i) => (
          <article className="card" key={s.id}>
            <div
              className={`art art-${i % 4}`}
              style={
                s.cover ? { backgroundImage: `url("${s.cover}")` } : undefined
              }
            >
              <span className="art-symbol" aria-hidden>
                {s.type === "game" ? "♜" : "◈"}
              </span>
              <span className="card-type">{s.category}</span>
              <AsyncButton
                className="favorite"
                aria-label={`${s.favorite ? "Remove" : "Add"} ${s.name} favorite`}
                onClick={async () => {
                  await api(`/api/services/${s.id}/favorite`, "PUT", {
                    favorite: !s.favorite,
                  });
                  void query.refresh();
                }}
              >
                {s.favorite ? "★" : "☆"}
              </AsyncButton>
            </div>
            <div className="card-body">
              <div className="card-status">
                <Pill
                  value={
                    s.health.maintenance.length ? "maintenance" : s.health.state
                  }
                />
                <span className="muted">
                  {s.type === "game" ? "GAME" : "SERVICE"}
                </span>
              </div>
              <h2>
                <button className="text-button" onClick={() => setDetail(s)}>
                  {s.name}
                </button>
              </h2>
              <p>{s.summary}</p>
              {s.incidents?.length > 0 && (
                <p className="banner">
                  Active incident: {s.incidents[0].title}
                </p>
              )}
              <div className="tags">
                {s.tags.map((t: string) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <div className="card-bottom">
                <Pill value={s.access} />
                <button onClick={() => setDetail(s)}>Explore →</button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {!query.loading && !rows.length && (
        <Empty>No services match your selection.</Empty>
      )}
      <div className="help-strip">
        <div>
          <strong>Need a hand getting connected?</strong>
          <p>Follow the setup guide or ask the community support team.</p>
        </div>
        <button onClick={() => nav("onboarding")}>Get started →</button>
      </div>
      {detail && (
        <Modal title={detail.name} close={() => setDetail(undefined)}>
          <p>{detail.summary}</p>
          <Pill value={detail.health.state} />
          {detail.health.maintenance.map((m: Row) => (
            <p className="banner" key={m.title}>
              Maintenance: {m.title}
            </p>
          ))}
          <small>{detail.health.meaning}</small>
          {detail.health.dependencyState && (
            <p>
              Direct checks: {detail.health.measuredState}. Dependencies:{" "}
              {detail.health.dependencyState}.
            </p>
          )}
          {detail.incidents?.map((n: Row) => (
            <p className="banner" key={n.id}>
              {n.title} · {n.state}
            </p>
          ))}
          {detail.announcements?.map((n: Row) => (
            <section key={n.id}>
              <h3>{n.title}</h3>
              <Mark>{n.body}</Mark>
            </section>
          ))}
          {detail.metadata ? (
            <>
              <Mark>{detail.metadata.description}</Mark>
              <h3>Connection details</h3>
              {detail.metadata.endpoints.map((e: Row) => (
                <div className="connection" key={e.label}>
                  <strong>{e.label}</strong>
                  <code>
                    {e.host}:{e.ports.join(", ")}
                  </code>
                  <span>
                    {e.network} · {e.protocol}
                  </span>
                  <AsyncButton
                    onClick={() => navigator.clipboard.writeText(e.host)}
                  >
                    Copy address
                  </AsyncButton>
                  {e.launch && (
                    <a className="button" href={e.launch}>
                      Open application
                    </a>
                  )}
                  {e.protocol === "rdp" && (
                    <a href={`/api/services/${detail.id}/rdp`}>
                      Download connection file
                    </a>
                  )}
                </div>
              ))}
              <Mark>{detail.metadata.instructions}</Mark>
              {detail.metadata.requiredClient && (
                <p>Required client: {detail.metadata.requiredClient}</p>
              )}
              {detail.metadata.links.map((l: Row) => (
                <a
                  key={l.url}
                  className="button"
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {l.label} ↗
                </a>
              ))}
              {detail.metadata.provider === "wow-manager" && (
                <p className="banner">
                  Game-account provisioning and server controls: Awaiting API
                  specification. Staff can record manual fulfillment.
                </p>
              )}
            </>
          ) : (
            <p>
              Request access to see protected connection details and setup
              instructions.
            </p>
          )}
          <h3>Access requirements</h3>
          {detail.requirements.map((e: Row) => (
            <div className="row" key={e.id}>
              <span>{e.name}</span>
              {e.requestable === "true" && (
                <button
                  onClick={() => {
                    setRequest(e);
                    setDetail(undefined);
                  }}
                >
                  Request access
                </button>
              )}
            </div>
          ))}
          <button
            onClick={() => {
              sessionStorage.setItem("ticket-service", detail.id);
              nav("tickets");
            }}
          >
            Report a problem
          </button>
          {detail.canManage && (
            <button
              onClick={() => {
                setEdit(detail);
                setDetail(undefined);
              }}
            >
              Edit service
            </button>
          )}
        </Modal>
      )}
      {request && (
        <Modal
          title={`Request ${request.name}`}
          close={() => setRequest(undefined)}
        >
          <RequestForm
            entitlementId={request.id}
            done={() => {
              setRequest(undefined);
              nav("access");
            }}
          />
        </Modal>
      )}
      {edit !== undefined && (
        <Modal
          title={edit ? "Edit service" : "Add service"}
          close={() => setEdit(undefined)}
        >
          <ServiceEditor
            service={edit}
            done={() => {
              setEdit(undefined);
              void query.refresh();
            }}
          />
        </Modal>
      )}
    </>
  );
}
function RequestForm({
  entitlementId,
  done,
}: {
  entitlementId: string;
  done: () => void;
}) {
  return (
    <Form
      label="Submit access request"
      onSubmit={async (f) => {
        await api("/api/requests", "POST", {
          entitlementId,
          reason: String(f.get("reason")),
          durationHours: Number(f.get("duration")),
        });
        done();
      }}
    >
      <Field name="reason" label="Why would you like access?" type="textarea" />
      <Field
        name="duration"
        label="Duration in hours"
        type="number"
        value={168}
      />
      <p>
        Approval queues fulfillment. Required setup steps may still need staff
        assistance.
      </p>
    </Form>
  );
}
function ServiceEditor({
  service,
  done,
}: {
  service: Row | null;
  done: () => void;
}) {
  const [meta, setMeta] = useState(
    JSON.stringify(
      service?.metadata ?? {
        type: "game",
        category: "Games",
        tags: [],
        provider: "manual",
        description: "",
        instructions: "",
        endpoints: [],
        links: [],
        sortOrder: 0,
      },
      null,
      2,
    ),
  );
  const [deleted, setDeleted] = useState("");
  return (
    <>
      <Form
        onSubmit={async (f) => {
          await api(
            `/api/services${service ? `/${service.id}` : ""}`,
            service ? "PUT" : "POST",
            {
              name: String(f.get("name")),
              slug: String(f.get("slug")),
              summary: String(f.get("summary")),
              visibility: String(f.get("visibility")),
              metadata: JSON.parse(meta),
              entitlementIds: String(f.get("entitlements"))
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              dependencies: JSON.parse(String(f.get("dependencies"))),
              version: service?.version,
            },
          );
          done();
        }}
      >
        <Field name="name" label="Name" value={service?.name} />
        <Field name="slug" label="Slug" value={service?.slug} />
        <Field
          name="summary"
          label="Card description"
          value={service?.summary}
        />
        <label>
          Visibility
          <select
            name="visibility"
            defaultValue={service?.visibility ?? "discoverable"}
          >
            <option value="discoverable">
              Discoverable (limited metadata)
            </option>
            <option value="entitled">Entitled users only</option>
            <option value="admin">Administrators only</option>
          </select>
        </label>
        <label>
          Service metadata, artwork, endpoints and links
          <textarea
            className="code"
            value={meta}
            onChange={(e) => setMeta(e.target.value)}
            rows={12}
          />
        </label>
        <Field
          name="entitlements"
          label="Required entitlement IDs (comma separated)"
          value={service?.requirements?.map((e: Row) => e.id).join(",") ?? ""}
          required={false}
        />
        <Field
          name="dependencies"
          label="Dependencies (JSON: id, required)"
          value={JSON.stringify(service?.dependencies ?? [])}
        />
        <p>
          Only configured, validated application links are offered. An operating
          system may need a URI handler installed.
        </p>
      </Form>
      {service && (
        <Form
          label="Delete service"
          onSubmit={async (f) => {
            await api(`/api/services/${service.id}`, "DELETE", {
              confirmation: String(f.get("confirmation")),
            });
            setDeleted("Deleted");
            done();
          }}
        >
          <Field
            name="confirmation"
            label="Type DELETE to remove this service"
          />
        </Form>
      )}
      {deleted}
    </>
  );
}
function MyAccess({ user }: { user: Row }) {
  const q = useData<Row>("/api/access");
  const options = useData<Row[]>("/api/entitlements");
  const [request, setRequest] = useState<Row>();
  return (
    <>
      <h1>My access</h1>
      <button onClick={q.refresh}>Refresh status</button>
      <p>
        Desired access, provider fulfillment and device connectivity are shown
        separately.
      </p>
      <State {...q} retry={q.refresh} />
      <h2>Your grants</h2>
      {q.data?.grants.map((g: Row) => (
        <article className="panel" key={g.id}>
          <div className="row">
            <h3>{g.name}</h3>
            <Pill value={g.fulfillment} />
          </div>
          <p>
            {g.desired ? "Desired access granted" : "Desired access removed"} ·
            Expires {date(g.expires_at, user.timezone)}
          </p>
          <small>Source: {g.source}</small>
          {q.data?.steps
            .filter((s: Row) => s.grant_id === g.id)
            .map((s: Row) => (
              <p key={s.id}>
                <Pill value={s.status} />{" "}
                {s.error ??
                  (s.observed?.unmanagedMembershipRetained
                    ? "Pre-existing provider access retained. Managed grant removed; traffic not tested."
                    : s.observed?.retainedByOtherGrant
                      ? "Provider access retained by another valid grant."
                      : s.observed?.controlPlaneVerified
                        ? "Provider configuration verified. Traffic not tested."
                        : s.observed?.manualAttestation
                          ? "Manual fulfillment attested."
                          : "Awaiting fulfillment")}
              </p>
            ))}
          <Form
            label="Request renewal"
            onSubmit={async (f) => {
              await api(`/api/grants/${g.id}/renew`, "POST", {
                durationHours: Number(f.get("hours")),
              });
              void q.refresh();
            }}
          >
            <Field
              name="hours"
              label="Renewal hours"
              type="number"
              value={168}
            />
          </Form>
        </article>
      ))}
      {q.data && !q.data.grants.length && (
        <Empty>
          You have no grants yet. Browse available entitlements below.
        </Empty>
      )}
      <h2>Requests</h2>
      {q.data?.requests.map((r: Row) => (
        <div className="panel" key={r.id}>
          <div className="row">
            <strong>
              {r.snapshot.items.map((e: Row) => e.name).join(", ")}
            </strong>
            <Pill value={r.status} />
          </div>
          <p>{r.reason}</p>
          {["pending", "needs-information"].includes(r.status) && (
            <Form
              label="Cancel request"
              onSubmit={async () => {
                await api(`/api/requests/${r.id}/cancel`, "POST", {});
                void q.refresh();
              }}
            >
              <span>Cancellation closes this pending request.</span>
            </Form>
          )}
        </div>
      ))}
      <h2>Available entitlements</h2>
      <div className="grid">
        {options.data
          ?.filter((e) => e.policy.requestable)
          .map((e) => (
            <div className="panel" key={e.id}>
              <h3>{e.name}</h3>
              <p>{e.policy.description}</p>
              <small>
                Maximum {e.policy.maxHours} hours · {e.policy.approvals}{" "}
                approval(s)
              </small>
              <button onClick={() => setRequest(e)}>Request access</button>
            </div>
          ))}
      </div>
      {request && (
        <Modal
          title={`Request ${request.name}`}
          close={() => setRequest(undefined)}
        >
          <RequestForm
            entitlementId={request.id}
            done={() => {
              setRequest(undefined);
              void q.refresh();
            }}
          />
        </Modal>
      )}
    </>
  );
}
function TicketPage({ user }: { user: Row }) {
  const q = useData<Row[]>("/api/tickets");
  const [selected, setSelected] = useState<string>();
  const [create, setCreate] = useState(false);
  const [search, setSearch] = useState("");
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Community support</h1>
          <p>Ask for help, share an idea, or follow an access request.</p>
        </div>
        <button className="primary" onClick={() => setCreate(true)}>
          + New ticket
        </button>
      </div>
      <label>
        Search tickets
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <State {...q} retry={q.refresh} />
      {q.data
        ?.filter((t) =>
          `${t.subject} ${t.status}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .map((t) => (
          <button
            className="ticket-row"
            key={t.id}
            onClick={() => setSelected(t.id)}
          >
            <span>
              <strong>{t.subject}</strong>
              <small>
                {t.type} · {date(t.updated_at, user.timezone)}
              </small>
            </span>
            <Pill value={t.status} />
          </button>
        ))}
      {q.data && !q.data.length && (
        <Empty>No tickets yet. We’re here when you need a hand.</Empty>
      )}
      {create && (
        <Modal title="Open a support ticket" close={() => setCreate(false)}>
          <Form
            label="Create ticket"
            onSubmit={async (f) => {
              const t = await api("/api/tickets", "POST", {
                subject: String(f.get("subject")),
                description: String(f.get("description")),
                type: String(f.get("type")),
                priority: String(f.get("priority")),
                serviceId: String(f.get("service")) || null,
              });
              setCreate(false);
              setSelected(t.id);
              void q.refresh();
            }}
          >
            <Field name="subject" label="Subject" />
            <label>
              Type
              <select name="type">
                {[
                  "technical problem",
                  "server problem",
                  "account problem",
                  "new game request",
                  "feature request",
                  "access request",
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Priority
              <select name="priority">
                <option>normal</option>
                <option>low</option>
                <option>high</option>
              </select>
            </label>
            <Field name="description" label="What happened?" type="textarea" />
            <Field
              name="service"
              label="Related service ID (optional)"
              value={sessionStorage.getItem("ticket-service") ?? ""}
              required={false}
            />
          </Form>
        </Modal>
      )}
      {selected && (
        <Modal title="Ticket timeline" close={() => setSelected(undefined)}>
          <TicketDetail id={selected} user={user} />
        </Modal>
      )}
    </>
  );
}
function TicketDetail({ id, user }: { id: string; user: Row }) {
  const q = useData<Row>(`/api/tickets/${id}`);
  return (
    <>
      <State {...q} retry={q.refresh} />
      {q.data && (
        <>
          <h3>{q.data.subject}</h3>
          <Pill value={q.data.status} />
          <Mark>{q.data.description}</Mark>
          <div className="timeline">
            {q.data.comments.map((c: Row) => (
              <article key={c.id}>
                <strong>{c.author}</strong> ·{" "}
                {date(c.created_at, user.timezone)}{" "}
                {c.private && <Pill value="staff note" />}
                <Mark>{c.body}</Mark>
              </article>
            ))}
          </div>
          {q.data.attachments.map((a: Row) => (
            <a className="button" key={a.id} href={`/files/${a.id}`}>
              ↓ {a.name}
            </a>
          ))}
          <Form
            label="Send reply"
            onSubmit={async (f) => {
              await api(`/api/tickets/${id}/comments`, "POST", {
                body: String(f.get("body")),
                private: f.get("private") === "on",
              });
              void q.refresh();
            }}
          >
            <Field name="body" label="Reply" type="textarea" />
            {q.data.canStaff && (
              <label className="checkbox">
                <input name="private" type="checkbox" />
                Private staff note
              </label>
            )}
          </Form>
          <Upload id={id} kind="ticket" done={q.refresh} />
          <Form
            label="Update ticket"
            onSubmit={async (f) => {
              await api(`/api/tickets/${id}`, "PATCH", {
                status: String(f.get("status")),
                ...(q.data?.canStaff
                  ? { assigneeId: String(f.get("assignee")) || null }
                  : {}),
              });
              void q.refresh();
            }}
          >
            <label>
              Status
              <select name="status" defaultValue={q.data.status}>
                {(q.data.canStaff
                  ? [
                      "open",
                      "in-progress",
                      "needs-information",
                      "resolved",
                      "closed",
                    ]
                  : ["open"]
                ).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            {q.data.canStaff && (
              <Field
                name="assignee"
                label="Assignee user ID"
                value={q.data.assignee_id ?? ""}
                required={false}
              />
            )}
          </Form>
        </>
      )}
    </>
  );
}
function DevicePage() {
  const q = useData<Row>("/api/devices");
  return (
    <>
      <h1>My devices</h1>
      <p>Your verified devices and the state reported by NetBird.</p>
      <State {...q} retry={q.refresh} />
      {q.data && (
        <>
          <div className="banner">
            {q.data.linked
              ? "Your NetBird account is linked."
              : "Ask a network administrator to verify and link your NetBird account."}{" "}
            {q.data.verification}
          </div>
          <div className="grid">
            {q.data.devices.map((d: Row) => (
              <article className="panel" key={d.id}>
                <h3>▱ {d.metadata.name}</h3>
                <Pill value={d.metadata.reportedState} />
                <p>
                  <code>{d.metadata.address}</code> ·{" "}
                  {d.metadata.os ?? "Unknown OS"}
                </p>
                <p>Last seen: {d.metadata.lastSeen ?? "Unknown"}</p>
                <small>
                  Observed: {d.observed_at}. Latency and handshake telemetry
                  unavailable.
                </small>
                <Form
                  label="Report lost device"
                  onSubmit={async () => {
                    await api(`/api/devices/${d.id}/lost`, "POST", {});
                    void q.refresh();
                  }}
                >
                  <span>Support will review access removal.</span>
                </Form>
              </article>
            ))}
          </div>
          {!q.data.devices.length && (
            <Empty>
              No verified devices observed. Sign in to NetBird and ask staff to
              verify your account link.
            </Empty>
          )}
          <h2>Connect with NetBird</h2>
          <p>
            Management URL: <code>{q.data.managementUrl}</code>
          </p>
          <a
            className="button"
            href="https://netbird.io/download"
            target="_blank"
            rel="noreferrer"
          >
            Get the official NetBird client ↗
          </a>
          {Object.entries(q.data.guidance).map(([os, guide]) => (
            <details className="panel" key={os}>
              <summary>{os}</summary>
              <p>{String(guide)}</p>
            </details>
          ))}
          <h2>Troubleshooting</h2>
          <h3>Approved services</h3>
          {q.data.services.map((s: Row) => (
            <div className="row" key={s.id}>
              <strong>{s.name}</strong>
              <span>Portal access active</span>
              <Pill value={s.health.state} />
              <small>{s.health.meaning}</small>
            </div>
          ))}
          {!q.data.services.length && (
            <p>
              No active service access. Visit My access to check requests and
              provisioning.
            </p>
          )}
          <h3>Network configuration</h3>
          {q.data.networkSteps.map((s: Row, i: number) => (
            <div className="row" key={i}>
              <span>{s.entitlement}</span>
              <Pill value={s.status} />
              {s.error && <span>{s.error.replaceAll("_", " ")}</span>}
            </div>
          ))}
          {!q.data.networkSteps.length && (
            <p>
              No current network fulfillment steps. This does not establish
              device connectivity.
            </p>
          )}
          <ol>
            <li>
              Check My access for approval, prerequisites and fulfillment.
            </li>
            <li>Confirm your NetBird user link with staff.</li>
            <li>
              Check provider configuration and device reports independently.
            </li>
            <li>Read service monitor state and its vantage point.</li>
            <li>
              This browser cannot test arbitrary private TCP ports or identify
              the local NetBird client.
            </li>
          </ol>
        </>
      )}
    </>
  );
}
function GuidePage() {
  const q = useData<Row[]>("/api/guides");
  const [search, setSearch] = useState("");
  return (
    <>
      <h1>Community guides</h1>
      <label>
        Search guides
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <State {...q} retry={q.refresh} />
      {q.data
        ?.filter((g) =>
          `${g.title} ${g.body}`.toLowerCase().includes(search.toLowerCase()),
        )
        .map((g) => (
          <Guide key={g.id} guide={g} refresh={q.refresh} />
        ))}
      {q.data && !q.data.length && (
        <Empty>No guides are available to your account.</Empty>
      )}
    </>
  );
}
function Guide({ guide: g, refresh }: { guide: Row; refresh: () => void }) {
  const files = useData<Row[]>(`/api/guides/${g.id}/files`);
  return (
    <details className="panel">
      <summary>
        {g.title} · version {g.current_version} {g.required ? "· Required" : ""}
      </summary>
      <Mark>{g.body}</Mark>
      {files.data?.map((a) => (
        <a className="button" key={a.id} href={`/files/${a.id}`}>
          ↓ {a.name}
        </a>
      ))}
      {g.accepted.some((a: Row) => a.version === g.current_version) ? (
        <Pill value="acknowledged" />
      ) : (
        <Form
          label="Acknowledge this version"
          onSubmit={async () => {
            await api(`/api/guides/${g.id}/accept`, "POST", {
              version: g.current_version,
            });
            refresh();
          }}
        >
          <span>
            Records acceptance of this version; it does not prove the document
            was read.
          </span>
        </Form>
      )}
      {g.canManage && (
        <>
          <JsonAction
            title="Publish new guide version"
            url={`/api/guides/${g.id}`}
            method="PUT"
            initial={{
              title: g.title,
              body: g.body,
              visibility: g.visibility,
              serviceId: g.service_id,
              required: g.required,
              version: g.current_version,
            }}
            done={refresh}
          />
          <Upload id={g.id} kind="guide" done={files.refresh} />
        </>
      )}
    </details>
  );
}
function Onboarding() {
  const q = useData<Row>("/api/onboarding");
  return (
    <>
      <h1>Make yourself at home.</h1>
      <p>Pick up where you left off. These steps survive sign-out.</p>
      <State {...q} retry={q.refresh} />
      {q.data && (
        <>
          {q.data.guides.map((g: Row) => (
            <Guide key={g.id} guide={g} refresh={q.refresh} />
          ))}
          {[
            [
              "profile",
              "Confirm your profile",
              "Check your name and account at Pocket ID.",
            ],
            [
              "rules",
              "Review community rules",
              "Acknowledge each required current guide version.",
            ],
            [
              "network-guidance",
              "Install NetBird",
              "Use My devices for the configured URL and sign-in guidance.",
            ],
            [
              "devices",
              "Link your devices",
              "Staff must verify the account link before devices appear.",
            ],
            [
              "browse",
              "Choose your services",
              "Browse cards and request the entitlements you need.",
            ],
            [
              "service-setup",
              "Complete service setup",
              "Read the service instructions and ask staff about blocked manual steps.",
            ],
          ].map(([id, title, help], i) => (
            <div className="panel row" key={id}>
              <div>
                <p className="eyebrow">STEP {i + 1}</p>
                <h3>{title}</h3>
                <p>{help}</p>
              </div>
              {q.data?.steps.some((s: Row) => s.step === id) &&
              (id !== "rules" || !q.data.rulesNeedReview) ? (
                <Pill value="complete" />
              ) : (
                <Form
                  label="Mark complete"
                  onSubmit={async () => {
                    await api("/api/onboarding", "POST", { step: id });
                    void q.refresh();
                  }}
                >
                  <span className="sr-only">{title}</span>
                </Form>
              )}
            </div>
          ))}
          <Form
            label="Redeem invitation"
            onSubmit={(f) =>
              api("/api/invitations/redeem", "POST", {
                invitation: String(f.get("invitation")),
              })
            }
          >
            <Field name="invitation" label="Invitation token from staff" />
            <small>
              You must be signed in. Invitations never grant administrator
              rights.
            </small>
          </Form>
        </>
      )}
    </>
  );
}
function NoticePage() {
  const q = useData<Row>("/api/notices");
  return (
    <>
      <h1>Community news & service notices</h1>
      <State {...q} retry={q.refresh} />
      {q.data &&
        Object.entries(q.data).map(([kind, rows]) => (
          <section key={kind}>
            <h2>{kind}</h2>
            {(rows as Row[]).map((n) => (
              <article className="panel" key={n.id}>
                <h3>{n.title}</h3>
                {n.state && <Pill value={n.state} />}
                {n.updates?.map((u: Row, i: number) => (
                  <section key={i}>
                    <Pill value={u.state} />
                    <small>{u.created_at}</small>
                    <Mark>{u.body}</Mark>
                  </section>
                ))}
                <Mark>
                  {n.body ??
                    (n.updates
                      ? ""
                      : `Scheduled ${n.starts_at ?? ""} to ${n.ends_at ?? ""}`)}
                </Mark>
              </article>
            ))}
            {!(rows as Row[]).length && <Empty>No {kind} to show.</Empty>}
          </section>
        ))}
    </>
  );
}
function NotificationPage() {
  const q = useData<Row[]>("/api/notifications");
  return (
    <>
      <h1>Your updates</h1>
      <State {...q} retry={q.refresh} />
      {q.data?.map((n) => (
        <article className="panel row" key={n.id}>
          <div>
            <Pill value={n.read_at ? "read" : "unread"} />
            <p>{n.body}</p>
            <a href={n.link}>Open in portal →</a>
          </div>
          {!n.read_at && (
            <Form
              label="Mark read"
              onSubmit={async () => {
                await api(`/api/notifications/${n.id}/read`, "POST", {});
                void q.refresh();
              }}
            >
              <span className="sr-only">{n.body}</span>
            </Form>
          )}
        </article>
      ))}
      {q.data && !q.data.length && <Empty>You’re all caught up.</Empty>}
      <h2>Optional delivery</h2>
      <JsonAction
        title="Update delivery preference"
        url="/api/notification-preferences"
        method="PUT"
        initial={{ channel: "smtp", enabled: false }}
      />
    </>
  );
}
function AdminPage({ user }: { user: Row }) {
  const [tab, setTab] = useState("overview");
  const owner = user.roles.some((r: Row) => r.role === "owner");
  const roles = user.roles.map((r: Row) => r.role);
  const allowed = (...rs: string[]) =>
    owner || rs.some((r) => roles.includes(r));
  const tabs = [
    ...(owner ? ["overview", "audit", "settings"] : []),
    ...(allowed("approver") ? ["approvals"] : []),
    ...(allowed("service-admin")
      ? ["services", "access", "monitoring", "notices"]
      : []),
    ...(allowed("identity-admin") ? ["users"] : []),
    ...(allowed("network-admin") ? ["network"] : []),
    ...(allowed("support") ? ["tickets"] : []),
  ];
  useEffect(() => {
    if (!tabs.includes(tab)) setTab(tabs[0] ?? "");
  }, [tabs.join(",")]);
  return (
    <>
      <p className="eyebrow">COMMUNITY OPERATIONS</p>
      <h1>Administration</h1>
      <div className="tabs wrap">
        {tabs.map((t) => (
          <button
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <AdminSection key={tab} tab={tab} user={user} />
    </>
  );
}
function AdminSection({ tab, user }: { tab: string; user: Row }) {
  const url =
    (
      {
        overview: "/api/admin",
        approvals: "/api/approvals",
        users: "/api/admin/users",
        access: "/api/admin/grants",
        network: "/api/admin/network",
        monitoring: "/api/health/checks",
        audit: "/api/admin/audit",
        services: "/api/services",
        tickets: "/api/tickets",
        notices: "/api/notices",
        settings: "/api/providers",
      } as Row
    )[tab] ?? "/api/providers";
  const q = useData<any>(url);
  const [result, setResult] = useState<any>();
  const done = q.refresh;
  return (
    <>
      <State {...q} retry={done} />
      {tab === "overview" && q.data && (
        <>
          {[
            "health",
            "incidents",
            "tickets",
            "requests",
            "failures",
            "expiring",
            "workers",
            "jobs",
            "devices",
            "reconciliation",
            "audit",
          ].map((key) => (
            <section key={key}>
              <h2>{key}</h2>
              <DataTable
                rows={q.data[key]}
                columns={
                  key === "health"
                    ? [
                        "name",
                        "state",
                        "measuredState",
                        "dependencyState",
                        "maintenance",
                      ]
                    : key === "incidents"
                      ? ["title", "state", "created_at"]
                      : key === "tickets"
                        ? ["subject", "status", "priority", "assignee_id"]
                        : key === "audit"
                          ? ["action", "target", "outcome", "created_at"]
                          : key === "workers"
                            ? ["id", "seen_at"]
                            : key === "reconciliation"
                              ? ["id", "provider", "status", "details"]
                              : ["id", "name", "status", "fulfillment"]
                }
              />
            </section>
          ))}
          <p>Provider versions: {JSON.stringify(q.data.providers)}</p>
          <JsonAction
            title="Retry failed job"
            url={`/api/admin/jobs/${result?.jobId ?? "replace-with-job-id"}/retry`}
            initial={{}}
          />
          <Form
            label="Select job"
            onSubmit={async (f) => setResult({ jobId: String(f.get("job")) })}
          >
            <Field name="job" label="Failed job ID" />
          </Form>
        </>
      )}
      {tab === "approvals" && (
        <>
          {q.data?.map((r: Row) => (
            <article className="panel" key={r.id}>
              <h3>{r.snapshot.items.map((e: Row) => e.name).join(", ")}</h3>
              <p>
                Requester: {r.user_id} · {r.duration_hours} hours
              </p>
              <Mark>{r.reason}</Mark>
              <Form
                label="Record decision"
                onSubmit={async (f) => {
                  await api(`/api/requests/${r.id}/decide`, "POST", {
                    decision: String(f.get("decision")),
                    reason: String(f.get("reason")),
                    durationHours: Number(f.get("hours")),
                    confirmation: String(f.get("confirmation")) || undefined,
                  });
                  void done();
                }}
              >
                <label>
                  Decision
                  <select name="decision">
                    <option value="approved">Approve</option>
                    <option value="denied">Deny</option>
                    <option value="needs-information">
                      Request more information
                    </option>
                  </select>
                </label>
                <Field name="reason" label="Decision reason" type="textarea" />
                <Field
                  name="confirmation"
                  label="Type APPROVE when approving access"
                  required={false}
                />
                <Field
                  name="hours"
                  label="Approved duration (hours; cannot expand request)"
                  type="number"
                  value={r.duration_hours}
                />
              </Form>
            </article>
          ))}
          {q.data && !q.data.length && <Empty>No pending approvals.</Empty>}
        </>
      )}
      {tab === "users" && (
        <>
          <AsyncButton
            onClick={async () => setResult(await api("/api/admin/pocket-id"))}
          >
            Inspect Pocket ID directory
          </AsyncButton>
          {result?.users && (
            <>
              <h2>Pocket ID users</h2>
              <DataTable
                rows={result.users}
                columns={[
                  "id",
                  "username",
                  "displayName",
                  "disabled",
                  "userGroups",
                ]}
              />
              <h2>Identity groups</h2>
              <DataTable
                rows={result.groups}
                columns={["id", "name", "friendlyName"]}
              />
              {result.users.map((u: Row) => (
                <JsonAction
                  key={u.id}
                  title={`Enrollment assistance for ${u.displayName}`}
                  url={`/api/admin/pocket-id/users/${u.id}/enrollment`}
                  initial={{ confirmation: "ENROLLMENT" }}
                />
              ))}
            </>
          )}
          <DataTable
            rows={q.data ?? []}
            columns={["id", "name", "email", "suspended", "subject"]}
          />
          <JsonAction
            title="Verify identity link"
            url="/api/admin/links"
            initial={{
              userId: "",
              provider: "netbird",
              externalId: "",
              reason: "Verified with operator",
              confirmation: "LINK",
            }}
          />
          <JsonAction
            title="Create Pocket ID user"
            url="/api/admin/pocket-id/users"
            initial={{
              username: "",
              displayName: "",
              email: "",
              confirmation: "CREATE USER",
            }}
          />
          <JsonAction
            title="Create Pocket ID group"
            url="/api/admin/pocket-id/groups"
            initial={{
              name: "",
              friendlyName: "",
              confirmation: "CREATE GROUP",
            }}
          />
          <Form
            label="Create onboarding invitation"
            onSubmit={async (f) => {
              setResult(
                await api("/api/invitations", "POST", {
                  hours: Number(f.get("hours")),
                }),
              );
            }}
          >
            <Field
              name="hours"
              label="Invitation validity (hours, max 168)"
              type="number"
              value={24}
            />
          </Form>
          {result?.invitation && (
            <div className="panel">
              <strong>Copy and share securely</strong>
              <code>{result.invitation}</code>
              <AsyncButton
                onClick={() => navigator.clipboard.writeText(result.invitation)}
              >
                Copy invitation
              </AsyncButton>
            </div>
          )}
          {q.data?.map((u: Row) => (
            <details className="panel" key={u.id}>
              <summary>{u.name}</summary>
              <JsonAction
                title="Refresh identity observation"
                url={`/api/admin/users/${u.id}/refresh-identity`}
                initial={{}}
              />
              <JsonAction
                title="Change portal suspension"
                url={`/api/admin/users/${u.id}/suspend`}
                initial={{ suspended: !u.suspended, confirmation: "SUSPEND" }}
              />
              {user.roles.some((r: Row) => r.role === "owner") && (
                <>
                  <JsonAction
                    title="Change portal roles"
                    url={`/api/admin/users/${u.id}/roles`}
                    method="PUT"
                    initial={{
                      roles: [{ role: "member", scope: "*" }],
                      confirmation: "CHANGE ROLES",
                    }}
                  />
                  <JsonAction
                    title="Offboard user"
                    url={`/api/admin/users/${u.id}/offboard`}
                    initial={{ confirmation: "OFFBOARD" }}
                  />
                  <AsyncButton
                    onClick={async () =>
                      setResult(await api(`/api/admin/preview/${u.id}`))
                    }
                  >
                    Read-only preview
                  </AsyncButton>
                </>
              )}
            </details>
          ))}
          {result?.readOnly && (
            <div className="banner">
              <strong>{result.banner}</strong>
              {result.cards.map((s: Row) => (
                <p key={s.id}>
                  {s.name} · {s.access}
                </p>
              ))}
            </div>
          )}
        </>
      )}
      {tab === "services" && (
        <>
          <p>Use Services in the main navigation to create and edit cards.</p>
          <DataTable
            rows={q.data ?? []}
            columns={["id", "name", "visibility", "access"]}
          />
          <JsonAction
            title="Create guide"
            url="/api/guides"
            initial={{
              title: "",
              body: "",
              required: false,
              visibility: "members",
              serviceId: null,
            }}
          />
        </>
      )}
      {tab === "access" && (
        <>
          <AccessConfiguration />
          <DataTable
            rows={q.data ?? []}
            columns={[
              "id",
              "name",
              "entitlement_name",
              "desired",
              "fulfillment",
              "expires_at",
            ]}
          />
          <JsonAction
            title="Create entitlement"
            url="/api/entitlements"
            initial={{
              key: "service.example.user",
              name: "",
              policy: {
                requestable: true,
                approvals: 1,
                noSelfApproval: true,
                maxHours: 720,
                defaultHours: 168,
              },
              prerequisites: [],
            }}
            done={done}
          />
          <JsonAction
            title="Create bundle"
            url="/api/bundles"
            initial={{ name: "", requestable: true, entitlementIds: [] }}
          />
          <JsonAction
            title="Manage fulfillment binding"
            url="/api/admin/bindings"
            initial={{
              entitlementId: "",
              provider: "manual",
              configuration: { instructions: "Staff fulfillment instructions" },
              confirmation: "MANAGE",
            }}
          />
          <JsonAction
            title="Grant access"
            url="/api/grants"
            initial={{
              userId: "",
              entitlementId: "",
              durationHours: 168,
              reason: "Administrator issued access",
              confirmation: "GRANT",
            }}
            done={done}
          />
          {q.data?.map((g: Row) => (
            <details className="panel" key={g.id}>
              <summary>
                {g.name} · {g.entitlement_name}
              </summary>
              <JsonAction
                title="Revoke grant"
                url={`/api/grants/${g.id}/revoke`}
                initial={{ confirmation: "REVOKE" }}
                done={done}
              />
            </details>
          ))}
          <Steps />
        </>
      )}
      {tab === "network" && q.data && (
        <>
          <AsyncButton
            onClick={async () =>
              setResult({ advanced: await api("/api/admin/network/advanced") })
            }
          >
            Inspect advanced NetBird objects
          </AsyncButton>
          {result?.advanced && (
            <pre>{JSON.stringify(result.advanced, null, 2)}</pre>
          )}
          <div className="banner">
            Provider configuration is distinct from traffic enforcement.
            Existing broad policies are preserved.
          </div>
          {q.data.warnings.map((w: Row) => (
            <p className="error" key={w.id}>
              {w.warning} ({w.id})
            </p>
          ))}
          {["users", "groups", "peers", "policies"].map((k) => (
            <section key={k}>
              <h2>{k}</h2>
              <DataTable
                rows={q.data[k]}
                columns={
                  k === "peers"
                    ? ["id", "name", "user_id", "connected", "ip"]
                    : ["id", "name", "role", "auto_groups"]
                }
              />
            </section>
          ))}
          <JsonAction
            title="Create managed group"
            url="/api/admin/network/groups"
            initial={{
              name: "Portcullis gaming clients",
              confirmation: "CREATE GROUP",
            }}
            done={done}
          />
          <h2>Verified devices</h2>
          {q.data.devices.map((d: Row) => (
            <details className="panel" key={d.id}>
              <summary>
                {d.metadata.name} · {d.owner}
              </summary>
              <p>
                Remove the observed peer {d.external_id} ({d.metadata.address})
                from NetBird. Setup-key revocation alone does not remove a peer.
              </p>
              <JsonAction
                title="Remove device"
                url={`/api/devices/${d.id}`}
                method="DELETE"
                initial={{ confirmation: "REMOVE DEVICE" }}
                done={done}
              />
            </details>
          ))}
          <h2>Managed enrollment keys</h2>
          {q.data.managedSetupKeys.map((k: Row) => (
            <details className="panel" key={k.id}>
              <summary>
                {k.metadata.name} · {k.revoked_at ? "revoked" : "created"}
              </summary>
              <p>
                Revocation stops enrollment with this key. Existing devices
                remain enrolled.
              </p>
              {!k.revoked_at && (
                <JsonAction
                  title="Revoke enrollment key"
                  url={`/api/admin/network/setup-keys/${k.id}/revoke`}
                  initial={{ confirmation: "REVOKE KEY" }}
                  done={done}
                />
              )}
            </details>
          ))}
          <Form
            label="Preview narrow policy"
            onSubmit={async (f) =>
              setResult(
                await api(
                  "/api/admin/network/policy-preview",
                  "POST",
                  JSON.parse(String(f.get("policy"))),
                ),
              )
            }
          >
            <Field
              name="policy"
              label="Policy configuration (JSON)"
              type="textarea"
              value={JSON.stringify({
                name: "Gaming access",
                sourceGroup: "",
                destinationGroup: "",
                protocol: "tcp",
                ports: [3724],
              })}
            />
          </Form>
          {result?.desired?.sourceGroup && (
            <>
              <pre>{JSON.stringify(result, null, 2)}</pre>
              <JsonAction
                title="Apply previewed policy"
                url="/api/admin/network/policies"
                initial={{ ...result.desired, confirmation: "CREATE POLICY" }}
                done={done}
              />
            </>
          )}
          <JsonAction
            title="Map existing routed resource"
            url="/api/admin/network/resources/map"
            initial={{
              networkId: "",
              serviceId: "",
              externalId: "",
              confirmation: "MAP INFRASTRUCTURE",
            }}
          />
          <Form
            label="Preview routed resource"
            onSubmit={async (f) =>
              setResult(
                await api(
                  "/api/admin/network/resource-preview",
                  "POST",
                  JSON.parse(String(f.get("resource"))),
                ),
              )
            }
          >
            <Field
              name="resource"
              label="Single-host resource (JSON)"
              type="textarea"
              value={JSON.stringify({
                networkId: "",
                serviceId: "",
                resource: {
                  name: "",
                  address: "192.168.10.5",
                  groups: [],
                  enabled: true,
                },
              })}
            />
          </Form>
          {result?.desired?.resource && (
            <>
              <pre>{JSON.stringify(result, null, 2)}</pre>
              <JsonAction
                title="Apply previewed resource"
                url="/api/admin/network/resources"
                initial={{ ...result.desired, confirmation: "CREATE RESOURCE" }}
              />
            </>
          )}
          <JsonAction
            title="Associate existing routing peer"
            url="/api/admin/network/routers"
            initial={{
              networkId: "",
              router: {
                peer: "",
                metric: 100,
                masquerade: true,
                enabled: true,
              },
              confirmation: "ASSOCIATE ROUTER",
            }}
          />
          <Form
            label="Create enrollment key"
            onSubmit={async (f) =>
              setResult(
                await api(
                  "/api/admin/network/setup-keys",
                  "POST",
                  JSON.parse(String(f.get("key"))),
                ),
              )
            }
          >
            <Field
              name="key"
              label="Authorized special-case enrollment (JSON)"
              type="textarea"
              value={JSON.stringify({
                userId: "",
                name: "One device",
                groups: [],
                confirmation: "CREATE ENROLLMENT KEY",
              })}
            />
          </Form>
          {result?.key && (
            <div className="panel">
              <code>{result.key}</code>
              <p>{result.reveal}</p>
            </div>
          )}
        </>
      )}
      {tab === "monitoring" && (
        <>
          <DataTable
            rows={q.data ?? []}
            columns={["id", "service_id", "kind", "enabled", "next_run"]}
          />
          <JsonAction
            title="Create health check"
            url="/api/health/checks"
            initial={{
              serviceId: "",
              kind: "http",
              intervalSeconds: 60,
              config: {
                url: "https://approved.example/health",
                expectedStatus: 200,
                vantage: "Portcullis worker",
              },
            }}
            done={done}
          />
          {q.data
            ?.filter((c: Row) => c.kind === "manual")
            .map((c: Row) => (
              <JsonAction
                key={c.id}
                title={`Set manual status ${c.id}`}
                url={`/api/health/checks/${c.id}/manual`}
                initial={{ state: "healthy", reason: "Verified by operator" }}
              />
            ))}
        </>
      )}
      {tab === "notices" && (
        <>
          <JsonAction
            title="Publish announcement"
            url="/api/announcements"
            initial={{ title: "", body: "", serviceId: null }}
          />
          <JsonAction
            title="Schedule maintenance"
            url="/api/maintenance"
            initial={{
              title: "",
              serviceId: null,
              startsAt: new Date().toISOString(),
              endsAt: new Date(Date.now() + 3600000).toISOString(),
            }}
          />
          <JsonAction
            title="Create incident"
            url="/api/incidents"
            initial={{
              title: "",
              body: "",
              state: "investigating",
              serviceId: null,
            }}
          />
          {q.data?.incidents.map((n: Row) => (
            <JsonAction
              key={n.id}
              title={`Update ${n.title}`}
              url={`/api/incidents/${n.id}`}
              initial={{
                title: n.title,
                body: "",
                state: "monitoring",
                serviceId: n.service_id,
              }}
            />
          ))}
          {q.data?.maintenance.map((m: Row) => (
            <section key={m.id}>
              <h3>{m.title}</h3>
              <JsonAction
                title={`Start ${m.title}`}
                url={`/api/maintenance/${m.id}/start`}
                initial={{}}
                done={done}
              />
              <JsonAction
                title={`End ${m.title}`}
                url={`/api/maintenance/${m.id}/end`}
                initial={{}}
                done={done}
              />
            </section>
          ))}
        </>
      )}
      {tab === "tickets" && <TicketPage user={user} />}{" "}
      {tab === "audit" && (
        <>
          <a className="button" href="/api/admin/audit?export=true">
            Export authorized audit
          </a>
          <DataTable
            rows={q.data ?? []}
            columns={[
              "actor_id",
              "subject_id",
              "action",
              "target",
              "outcome",
              "created_at",
            ]}
          />
        </>
      )}
      {tab === "settings" && (
        <>
          <DataTable
            rows={q.data ?? []}
            columns={["id", "availability", "capabilities"]}
          />
          <p>
            Provider URLs, versions, capability overrides, trusted ingress and
            outbound destinations are configured by the operator in environment
            settings.
          </p>
          <JsonAction
            title="Rotate stored secret"
            url="/api/admin/secrets"
            initial={{
              name: "kuma.metrics",
              value: "",
              confirmation: "ROTATE SECRET",
            }}
          />
          <p>
            Keys are stored encrypted; retain the encryption key separately for
            recovery.
          </p>
        </>
      )}
    </>
  );
}
function AccessConfiguration() {
  const q = useData<Row>("/api/admin/access-configuration");
  return (
    <section>
      <h2>Entitlements and bundles</h2>
      <State {...q} retry={q.refresh} />
      {q.data?.entitlements.map((e: Row) => (
        <details className="panel" key={`${e.id}:${e.version}`}>
          <summary>
            {e.name} · version {e.version}
          </summary>
          <p>
            Updates apply to new requests. Existing grants retain their approved
            snapshots.
          </p>
          <JsonAction
            title={`Edit entitlement ${e.name}`}
            url={`/api/entitlements/${e.id}`}
            method="PUT"
            initial={{
              key: e.key,
              name: e.name,
              policy: e.policy,
              prerequisites: e.prerequisites,
              version: e.version,
            }}
            done={q.refresh}
          />
          <DataTable
            rows={e.bindings}
            columns={[
              "id",
              "provider",
              "external_id",
              "managed",
              "configuration",
            ]}
          />
        </details>
      ))}
      {q.data?.bundles.map((b: Row) => (
        <JsonAction
          key={`${b.id}:${b.version}`}
          title={`Edit bundle ${b.name}`}
          url={`/api/bundles/${b.id}`}
          method="PUT"
          initial={{
            name: b.name,
            requestable: b.requestable,
            entitlementIds: b.entitlementIds,
            version: b.version,
          }}
          done={q.refresh}
        />
      ))}
    </section>
  );
}
function Steps() {
  const q = useData<Row[]>("/api/admin/steps");
  return (
    <>
      <h2>Fulfillment steps</h2>
      <State {...q} retry={q.refresh} />
      {q.data
        ?.filter((s) =>
          ["blocked", "partially-failed", "revocation-failed"].includes(
            s.status,
          ),
        )
        .map((s) => (
          <details className="panel" key={s.id}>
            <summary>
              {s.id} · {s.status}
            </summary>
            <p>{s.error}</p>
            {s.error?.includes("Manual") ||
            s.error?.includes("specification") ? (
              <JsonAction
                title={
                  s.status === "revocation-failed"
                    ? "Attest manual removal"
                    : "Attest manual fulfillment"
                }
                url={
                  s.status === "revocation-failed"
                    ? `/api/admin/steps/${s.id}/removal-attest`
                    : `/api/steps/${s.id}/attest`
                }
                initial={{
                  reason: "",
                  confirmation:
                    s.status === "revocation-failed"
                      ? "ATTEST REMOVAL"
                      : "ATTEST",
                }}
                done={q.refresh}
              />
            ) : (
              <p>
                Correct the provider configuration and retry the failed job.
              </p>
            )}
          </details>
        ))}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
