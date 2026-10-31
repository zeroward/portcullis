export type Values = Record<string, any>;
export type Kind =
  | "text"
  | "textarea"
  | "markdown"
  | "email"
  | "url"
  | "password"
  | "number"
  | "boolean"
  | "select"
  | "object"
  | "list"
  | "datetime-local";
export interface FieldSpec {
  key: string;
  label: string;
  kind: Kind;
  optional?: boolean;
  nullable?: boolean;
  default?: any;
  min?: number;
  max?: number;
  pattern?: string;
  choices?: string[];
  source?: string | ((root: Values) => string | null);
  multiple?: boolean;
  fields?: FieldSpec[];
  item?: FieldSpec;
  show?: (root: Values) => boolean;
  help?: string;
  /** Presentation only; never included in submitted payloads. */
  group?: string;
  advanced?: boolean;
}
const f = (
  key: string,
  label: string,
  kind: Kind = "text",
  extra: Partial<FieldSpec> = {},
): FieldSpec => ({ key, label, kind, ...extra });
const text = (key: string, label: string, max = 200, optional = false) =>
  f(key, label, "text", { max, optional });
const bool = (key: string, label: string, value = false) =>
  f(key, label, "boolean", { default: value });
const num = (
  key: string,
  label: string,
  value: number,
  min?: number,
  max?: number,
) => f(key, label, "number", { default: value, min, max });
const choice = (
  key: string,
  label: string,
  choices: string[],
  value = choices[0],
) => f(key, label, "select", { choices, default: value });
const select = (
  key: string,
  label: string,
  source: FieldSpec["source"],
  extra: Partial<FieldSpec> = {},
) => f(key, label, "select", { source, ...extra });
const multi = (
  key: string,
  label: string,
  source: FieldSpec["source"],
  extra: Partial<FieldSpec> = {},
) => select(key, label, source, { multiple: true, default: [], ...extra });
const object = (key: string, label: string, fields: FieldSpec[]) =>
  f(key, label, "object", { fields });
const list = (
  key: string,
  label: string,
  item: FieldSpec,
  max?: number,
  min = 0,
) => f(key, label, "list", { item, default: [], max, min });
const markdown = (key: string, label: string, max: number, optional = false) =>
  f(key, label, "markdown", { max, optional, default: "" });
const lookup = (kind: string, purpose?: string) =>
  `/api/form-options/${kind}${purpose ? `?purpose=${purpose}` : ""}`;
const service = (purpose: string, nullable = false) =>
  select("serviceId", "Service", lookup("services", purpose), {
    nullable,
    optional: nullable,
    default: nullable ? null : "",
  });
const name = text("name", "Name", 100);
const reason = f("reason", "Reason", "textarea", { min: 5, max: 2000 });
const ports = list("ports", "Ports", num("", "Port", 443, 1, 65535), 16, 1);
const network = select("networkId", "Network", lookup("netbird-networks"));
const entitlement = select(
  "entitlementId",
  "Entitlement",
  lookup("entitlements"),
);
const groups = (purpose: string) =>
  multi("groups", "Groups", lookup("netbird-groups", purpose), {
    max: purpose === "enrollment" ? 5 : undefined,
    min: purpose === "resource" ? 1 : 0,
  });
const body = markdown("body", "Body (Markdown)", 20000);
const title = f("title", "Title", "text", { min: 3, max: 200 });
const state = choice("state", "State", [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
]);
export const roleFields = [
  list(
    "roles",
    "Operator roles",
    object("", "Role assignment", [
      choice("role", "Role", [
        "member",
        "support",
        "approver",
        "service-admin",
        "network-admin",
        "identity-admin",
        "owner",
      ]),
      select("scope", "Scope", lookup("services", "role-scope"), {
        default: "*",
      }),
    ]),
    30,
    1,
  ),
];
export const serviceFields: FieldSpec[] = [
  { ...name, min: 2 },
  f("slug", "Slug", "text", {
    pattern: "[a-z0-9\\-]{2,80}",
    help: "Lowercase letters, numbers and hyphens; 2–80 characters.",
  }),
  text("summary", "Card description", 240, true),
  choice("visibility", "Visibility", ["discoverable", "entitled", "admin"]),
  object("metadata", "Service details", [
    choice("type", "Type", ["service", "game"]),
    { ...text("category", "Category", 80), default: "Community" },
    list("tags", "Tags", text("", "Tag", 40), 12),
    markdown("description", "Description (Markdown)", 40000, true),
    markdown("instructions", "Instructions (Markdown)", 20000, true),
    text("owner", "Owner", 100, true),
    num("sortOrder", "Sort order", 0),
    select("provider", "Fulfillment provider", lookup("providers", "service"), {
      default: "manual",
    }),
    text("version", "Service version", 100, true),
    text("environment", "Environment", 100, true),
    f("icon", "Icon URL", "url", { optional: true, max: 2048 }),
    f("cover", "Cover URL", "url", { optional: true, max: 2048 }),
    list(
      "screenshots",
      "Screenshots",
      f("", "Image URL", "url", { max: 2048 }),
      6,
    ),
    {
      ...object("source", "Game metadata source", [
        choice("provider", "Provider", ["rawg"]),
        f("url", "Source URL", "url", { max: 2048 }),
      ]),
      optional: true,
      show: (root) => !!root.metadata?.source,
    },
    text("requiredClient", "Required client", 500, true),
    markdown("rules", "Rules (Markdown)", 10000, true),
    list(
      "endpoints",
      "Connection endpoints",
      object("", "Endpoint", [
        text("label", "Label", 100, true),
        f("host", "Host", "text", { pattern: "[a-zA-Z0-9.:\\[\\]\\-]{1,253}" }),
        choice("protocol", "Protocol", [
          "tcp",
          "udp",
          "https",
          "http",
          "rdp",
          "unknown",
        ]),
        ports,
        choice("network", "Network access", ["public", "lan", "netbird"]),
        text("launch", "Application launch URL", 2048, true),
      ]),
      12,
    ),
    list(
      "links",
      "Links",
      object("", "Link", [
        text("label", "Label", 100, true),
        f("url", "URL", "url", { max: 2048 }),
        bool("admin", "Administrators only"),
      ]),
      12,
    ),
  ]),
  multi("entitlementIds", "Required entitlements", lookup("entitlements")),
  list(
    "dependencies",
    "Dependencies",
    object("", "Dependency", [
      select("id", "Service", lookup("services", "catalog.manage")),
      bool("required", "Required", true),
    ]),
  ),
];
export const policyFields = [
  name,
  select("sourceGroup", "Source group", lookup("netbird-groups", "policy")),
  select(
    "destinationGroup",
    "Destination group",
    lookup("netbird-groups", "policy"),
  ),
  choice("protocol", "Protocol", ["tcp", "udp"]),
  ports,
];
export const resourceFields = [
  network,
  service("network.manage"),
  object("resource", "Routed resource", [
    name,
    text("address", "Single host or domain", 253),
    groups("resource"),
    bool("enabled", "Enabled", true),
    text("description", "Description", 2000, true),
  ]),
];
export function fieldsFor(url: string): FieldSpec[] {
  if (/\/api\/requests\/[^/]+\/decide$/.test(url))
    return [
      choice("decision", "Decision", [
        "approved",
        "denied",
        "needs-information",
      ]),
      reason,
      num("durationHours", "Approved duration (hours)", 168, 1, 8760),
    ];
  if (/\/api\/services(?:\/[^/]+)?$/.test(url)) return serviceFields;
  if (/\/api\/entitlements(?:\/[^/]+)?$/.test(url))
    return [
      f("key", "Key", "text", { pattern: "[a-z][a-z0-9.\\-]{2,100}" }),
      { ...name, min: 2 },
      object("policy", "Request policy", [
        markdown("description", "Description (Markdown)", 2000, true),
        bool("requestable", "Members may request", true),
        num("approvals", "Approvals required", 1, 1, 3),
        bool("noSelfApproval", "Prevent self approval", true),
        num("maxHours", "Maximum duration (hours)", 720, 1, 8760),
        num("defaultHours", "Default duration (hours)", 168, 1, 8760),
        multi("requiredGuides", "Required guides", lookup("guides")),
        bool("renewable", "Renewable", true),
      ]),
      multi(
        "prerequisites",
        "Prerequisite entitlements",
        lookup("entitlements"),
      ),
    ];
  if (/\/api\/bundles(?:\/[^/]+)?$/.test(url))
    return [
      { ...name, min: 2 },
      bool("requestable", "Members may request", true),
      multi("entitlementIds", "Entitlements", lookup("entitlements"), {
        min: 1,
      }),
    ];
  if (url === "/api/admin/bindings")
    return [
      entitlement,
      select("provider", "Provider", lookup("providers", "binding"), {
        default: "manual",
      }),
      select(
        "externalId",
        "Provider group",
        (r) =>
          r.provider === "pocket-id"
            ? lookup("pocket-groups")
            : r.provider === "netbird"
              ? lookup("netbird-groups", "binding")
              : null,
        { show: (r) => ["pocket-id", "netbird"].includes(r.provider) },
      ),
      object("configuration", "Fulfillment instructions", [
        markdown("instructions", "Instructions (Markdown)", 10000, true),
      ]),
    ];
  if (url === "/api/admin/links")
    return [
      select("provider", "Provider", lookup("providers", "link")),
      select("userId", "Portal user", (r) =>
        r.provider
          ? lookup(
              "users",
              r.provider === "netbird" ? "network.manage" : "identity.manage",
            )
          : null,
      ),
      select("externalId", "Provider account", (r) =>
        r.provider
          ? lookup(r.provider === "netbird" ? "netbird-users" : "pocket-users")
          : null,
      ),
      reason,
    ];
  if (url === "/api/admin/pocket-id/users")
    return [
      f("username", "Username", "text", { min: 1, max: 50 }),
      text("firstName", "First name", 50, true),
      text("lastName", "Last name", 50, true),
      text("displayName", "Display name", 100, true),
      f("email", "Email", "email", { optional: true }),
    ];
  if (url === "/api/admin/pocket-id/groups")
    return [
      f("name", "Group name", "text", { min: 2, max: 255 }),
      f("friendlyName", "Display name", "text", { min: 2, max: 50 }),
    ];
  if (/\/roles$/.test(url)) return roleFields;
  if (/\/suspend$/.test(url))
    return [bool("suspended", "Suspend portal access")];
  if (/\/api\/guides(?:\/[^/]+)?$/.test(url))
    return [
      title,
      markdown("body", "Body (Markdown)", 100000),
      choice("visibility", "Visibility", ["members", "staff"]),
      service("guides.manage", true),
      bool("required", "Acknowledgement required"),
    ];
  if (url === "/api/grants")
    return [
      select("userId", "Portal user", lookup("users", "access.manage")),
      entitlement,
      num("durationHours", "Duration (hours)", 168, 1, 8760),
      reason,
    ];
  if (/\/(?:removal-)?attest$/.test(url)) return [reason];
  if (url === "/api/admin/network/groups") return [{ ...name, min: 2 }];
  if (url === "/api/admin/network/policies") return policyFields;
  if (url === "/api/admin/network/resources") return resourceFields;
  if (url === "/api/admin/network/resources/map")
    return [
      network,
      service("network.manage"),
      select("externalId", "Existing resource", (r) =>
        r.networkId
          ? `${lookup("netbird-resources")}?networkId=${encodeURIComponent(r.networkId)}`
          : null,
      ),
    ];
  if (url === "/api/admin/network/routers")
    return [
      network,
      object("router", "Routing peer", [
        select("peer", "Peer", lookup("netbird-peers")),
        num("metric", "Metric", 100, 1, 9999),
        bool("masquerade", "Masquerade", true),
        bool("enabled", "Enabled", true),
      ]),
    ];
  if (url === "/api/admin/network/setup-keys")
    return [
      select("userId", "Portal user", lookup("users", "network.manage")),
      { ...name, min: 2 },
      groups("enrollment"),
    ];
  if (url === "/api/health/checks")
    return [
      service("monitor.manage"),
      choice("kind", "Check type", [
        "http",
        "tcp",
        "manual",
        "kuma",
        "waygate",
        "incoming",
        "pterodactyl",
      ]),
      num("intervalSeconds", "Interval (seconds)", 60, 5, 86400),
      object("config", "Check settings", [
        f("url", "URL", "url", {
          show: (r) => ["http", "kuma", "waygate"].includes(r.kind),
        }),
        { ...text("host", "Host", 253), show: (r) => r.kind === "tcp" },
        {
          ...num("port", "Port", 443, 1, 65535),
          show: (r) => r.kind === "tcp",
        },
        {
          ...num("expectedStatus", "Expected HTTP status", 200, 100, 599),
          show: (r) => r.kind === "http",
        },
        {
          ...text("monitorName", "Monitor name", 200, true),
          show: (r) => r.kind === "kuma",
        },
        select(
          "serverIdentifier",
          "Pterodactyl server",
          lookup("pterodactyl-servers"),
          { show: (r) => r.kind === "pterodactyl" },
        ),
        select("secretReference", "Stored secret", lookup("secrets"), {
          optional: true,
          show: (r) => ["http", "kuma", "waygate", "incoming"].includes(r.kind),
        }),
        {
          ...text("vantage", "Observation location", 120),
          default: "Portcullis worker",
        },
      ]),
    ];
  if (/\/api\/health\/checks\/[^/]+\/manual$/.test(url))
    return [
      choice("state", "State", ["healthy", "degraded", "down", "unknown"]),
      reason,
    ];
  if (url === "/api/announcements")
    return [title, body, service("incident.manage", true)];
  if (url === "/api/maintenance")
    return [
      title,
      service("incident.manage", true),
      f("startsAt", "Starts at", "datetime-local"),
      f("endsAt", "Ends at", "datetime-local"),
    ];
  if (/\/api\/incidents(?:\/[^/]+)?$/.test(url))
    return [title, body, state, service("incident.manage", true)];
  if (url === "/api/notification-preferences")
    return [
      choice("channel", "Delivery channel", ["smtp", "discord", "webhook"]),
      bool("enabled", "Enable delivery"),
    ];
  if (url === "/api/admin/secrets")
    return [
      text("name", "Secret name", 100),
      f("value", "Secret value", "password", { max: 9999 }),
    ];
  if (
    /\/(?:refresh-identity|offboard|revoke|enrollment|start|end|retry)$/.test(
      url,
    ) ||
    /\/api\/devices\/[^/]+$/.test(url)
  )
    return [];
  throw new Error(`No form defined for ${url}`);
}
export function defaults(fields: FieldSpec[], initial: Values = {}): Values {
  const result = { ...initial };
  for (const field of fields) {
    if (field.kind === "object")
      result[field.key] =
        field.optional && initial[field.key] === undefined
          ? undefined
          : defaults(field.fields!, initial[field.key]);
    else if (initial[field.key] === undefined)
      result[field.key] =
        field.default ??
        (field.multiple || field.kind === "list"
          ? []
          : field.kind === "boolean"
            ? false
            : "");
  }
  return result;
}
// Only declared fields and concurrency/confirmation tokens cross the write boundary.
export function payload(
  fields: FieldSpec[],
  values: Values,
  root = values,
): Values {
  const result: Values = {};
  for (const field of fields) {
    if (field.show && !field.show(root)) continue;
    let value = values[field.key];
    if (field.kind === "object")
      value =
        field.optional && value === undefined
          ? undefined
          : payload(field.fields!, value ?? {}, root);
    else if (field.kind === "list")
      value = (value ?? []).map(
        (v: any) =>
          payload([{ ...field.item!, key: "value" }], { value: v }, root).value,
      );
    else if (field.kind === "number")
      value = value === "" ? undefined : Number(value);
    else if (field.kind === "datetime-local")
      value = value ? new Date(value).toISOString() : undefined;
    if (field.nullable && (value === "" || value == null)) value = null;
    else if (field.optional && value === "") value = undefined;
    result[field.key] = field.key === "summary" ? (value ?? "") : value;
  }
  for (const key of ["version", "confirmation"])
    if (values[key] !== undefined && !fields.some((f) => f.key === key))
      result[key] = values[key];
  return result;
}
export function validate(values: Values): string | undefined {
  if (values.policy?.defaultHours > values.policy?.maxHours)
    return "Default duration must not exceed maximum duration.";
  if (
    values.startsAt &&
    values.endsAt &&
    new Date(values.endsAt) <= new Date(values.startsAt)
  )
    return "End time must be after start time.";
  if (values.sourceGroup && values.sourceGroup === values.destinationGroup)
    return "Source and destination groups must differ.";
  if (values.roles) {
    const keys = values.roles.map((r: Values) => `${r.role}:${r.scope}`);
    if (new Set(keys).size !== keys.length)
      return "Each role and scope may only be assigned once.";
  }
}
