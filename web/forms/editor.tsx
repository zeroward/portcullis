import React, { useEffect, useId, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { revealField } from "../ui.js";
import { presentFields } from "./presentation.js";
import { api, ApiError } from "../api.js";
import {
  defaults,
  fieldsFor,
  payload,
  validate,
  type FieldSpec,
  type Values,
} from "./schema.js";
// Drafts live only in this page session, never in browser storage.
const drafts = new Map<string, Values>();

export const DraftValuesContext = React.createContext<Record<string, string>>(
  {},
);

export const LookupStatusContext = React.createContext<
  (id: string, ready: boolean) => void
>(() => {});
export interface Option {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  reason?: string;
}
const human = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ");
export function ReadableResult({
  value,
  labels = {},
}: {
  value: any;
  labels?: Record<string, string>;
}) {
  if (value == null) return <span className="muted">None</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value !== "object")
    return <span>{labels[String(value)] ?? String(value)}</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ul>
        {value.map((v, i) => (
          <li key={i}>
            <ReadableResult value={v} labels={labels} />
          </li>
        ))}
      </ul>
    ) : (
      <span className="muted">None</span>
    );
  return (
    <dl className="readable-result">
      {Object.entries(value)
        .filter(
          ([k]) => !/^(token|secret|password|ciphertext|invitation)$/i.test(k),
        )
        .map(([k, v]) => (
          <div key={k}>
            <dt>{human(k)}</dt>
            <dd>
              <ReadableResult value={v} labels={labels} />
            </dd>
          </div>
        ))}
    </dl>
  );
}
export function ResourceSelect({
  source,
  value,
  onChange,
  multiple = false,
  optional = false,
  label,
  name,
  onReady,
  onOptions,
  min,
  max,
  invalid,
}: {
  source: string | null;
  value: any;
  onChange: (v: any) => void;
  multiple?: boolean;
  optional?: boolean;
  label: string;
  name?: string;
  onReady?: (ready: boolean) => void;
  onOptions?: (options: Option[]) => void;
  min?: number;
  max?: number;
  invalid?: boolean;
}) {
  const [options, setOptions] = useState<Option[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0),
    [search, setSearch] = useState("");
  const id = useId();
  const readyRef = useRef(onReady),
    optionsRef = useRef(onOptions);
  readyRef.current = onReady;
  optionsRef.current = onOptions;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setOptions([]);
    readyRef.current?.(false);
    if (!source) {
      setLoading(false);
      return () => {
        active = false;
        readyRef.current?.(true);
      };
    }
    api(source).then(
      (rows: Option[]) => {
        if (active) {
          setOptions(rows);
          optionsRef.current?.(rows);
          setLoading(false);
          readyRef.current?.(true);
        }
      },
      (e) => {
        if (active) {
          setLoading(false);
          setError(e.message);
        }
      },
    );
    return () => {
      active = false;
      readyRef.current?.(true);
    };
  }, [source, attempt]);
  const selected: string[] = multiple
    ? (value ?? [])
    : value == null || value === ""
      ? []
      : [String(value)];
  const missing = selected.filter((v) => !options.some((o) => o.id === v));
  const displayed = options.filter(
    (o) =>
      selected.includes(o.id) ||
      `${o.label} ${o.description ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="resource-select">
      <label id={`${id}-label`} htmlFor={multiple ? undefined : id}>
        {label}
        {optional ? " (optional)" : ""}
      </label>
      {(multiple || options.length > 8) && (
        <input
          aria-label={`Search ${label}`}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name"
        />
      )}
      {loading ? (
        <p role="status">Loading {label.toLowerCase()}…</p>
      ) : error ? (
        <p role="alert" className="error">
          Could not load {label.toLowerCase()}: {human(error)}{" "}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry {label.toLowerCase()}
          </button>
        </p>
      ) : !source ? (
        <p className="muted">Choose the related field first.</p>
      ) : options.length === 0 ? (
        <p className="muted">No available {label.toLowerCase()}.</p>
      ) : null}
      {multiple ? (
        <fieldset
          className="checkbox-picker"
          aria-labelledby={`${id}-label`}
          aria-invalid={invalid || undefined}
          tabIndex={-1}
          disabled={loading || !!error || !source}
        >
          <div
            className="selected-items"
            aria-label={`Selected ${label.toLowerCase()}`}
          >
            <small>
              {selected.length} selected{max ? ` · Up to ${max}` : ""}
            </small>
            {selected.map((v) => (
              <button
                type="button"
                key={v}
                aria-label={`Remove ${options.find((o) => o.id === v)?.label ?? "unavailable selection"}`}
                onClick={() => onChange(selected.filter((s) => s !== v))}
              >
                {options.find((o) => o.id === v)?.label ??
                  `Unavailable current selection (${v.slice(0, 8)}) — retained`}{" "}
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
          <div className="picker-options">
            {displayed.map((o) => (
              <label className="checkbox" key={o.id}>
                <input
                  type="checkbox"
                  name={name}
                  value={o.id}
                  checked={selected.includes(o.id)}
                  disabled={
                    !selected.includes(o.id) &&
                    (o.disabled ||
                      (max !== undefined && selected.length >= max))
                  }
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...selected, o.id]
                        : selected.filter((v) => v !== o.id),
                    )
                  }
                />
                <span>
                  {o.label}
                  {o.description && <small>{o.description}</small>}
                  {o.disabled && <small>{o.reason ?? "Unavailable"}</small>}
                </span>
              </label>
            ))}
            {!displayed.length && search && <small>No matching options.</small>}
          </div>
        </fieldset>
      ) : (
        <select
          id={id}
          aria-invalid={invalid || undefined}
          name={name}
          value={value ?? ""}
          disabled={loading || !!error || !source}
          required={!optional}
          onChange={(e) => onChange(e.target.value)}
        >
          {!options.some((o) => o.id === "") && (
            <option value="">{optional ? "None" : "Choose…"}</option>
          )}
          {missing.map((v) => (
            <option key={v} value={v}>
              Unavailable current selection ({v.slice(0, 8)}) — retained
            </option>
          ))}
          {displayed.map((o) => (
            <option
              key={o.id}
              value={o.id}
              disabled={o.disabled && !selected.includes(o.id)}
            >
              {o.label}
              {o.description ? ` · ${o.description}` : ""}
              {o.disabled ? ` — ${o.reason ?? "Unavailable"}` : ""}
            </option>
          ))}
        </select>
      )}
      {invalid && <p className="error">Check {label.toLowerCase()}.</p>}
      {((min !== undefined && selected.length < min) ||
        (max !== undefined && selected.length > max)) && (
        <p role="alert">
          Choose {min ?? 0}–{max ?? "any number of"} items.
        </p>
      )}
      {missing.length > 0 && (
        <p className="muted">
          Existing references are retained until you explicitly change them.
        </p>
      )}
    </div>
  );
}
export function LookupField({
  name,
  label,
  source,
  value = "",
  required = false,
}: {
  name: string;
  label: string;
  source: string;
  value?: string;
  required?: boolean;
}) {
  const draft = React.useContext(DraftValuesContext);
  const [selected, setSelected] = useState(draft[name] ?? value);
  const status = React.useContext(LookupStatusContext),
    id = useId();
  return (
    <>
      <input name={name} type="hidden" value={selected} />
      <ResourceSelect
        label={label}
        source={source}
        value={selected}
        onChange={setSelected}
        optional={!required}
        onReady={(ready) => status(id, ready)}
      />
    </>
  );
}
function LocalDate({
  value,
  onChange,
  ...props
}: Omit<React.ComponentProps<"input">, "value" | "onChange"> & {
  value: string;
  onChange: (s: string) => void;
}) {
  let display = value ?? "";
  if (display.endsWith("Z")) {
    const d = new Date(display);
    display = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }
  return (
    <>
      <input
        {...props}
        type="datetime-local"
        value={display}
        onChange={(e) => onChange(e.target.value)}
      />
      <small>
        Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}
      </small>
    </>
  );
}
interface FieldProps {
  field: FieldSpec;
  value: any;
  root: Values;
  path: string;
  change: (v: any) => void;
  status: (path: string, ready: boolean) => void;
  labels: (options: Option[]) => void;
  errors: string[];
}
function EditorField({
  field: f,
  value,
  root,
  path,
  change,
  status,
  labels,
  errors,
}: FieldProps) {
  const id = useId();
  if (f.show && !f.show(root)) return null;
  const shared = {
    id,
    name: path,
    required: !f.optional && !f.nullable,
    minLength: f.min,
    maxLength: f.max,
    "aria-invalid": errors.includes(path) || undefined,
  };
  const label = (
    <label htmlFor={id}>
      {f.label}
      {f.optional ? " (optional)" : ""}
    </label>
  );
  if (f.kind === "object")
    return (
      <fieldset aria-invalid={errors.includes(path) || undefined} tabIndex={-1}>
        <legend>{f.label}</legend>
        {f.fields!.map((child) => (
          <EditorField
            key={child.key}
            field={child}
            value={value?.[child.key]}
            root={root}
            path={`${path}.${child.key}`}
            change={(v) => change({ ...value, [child.key]: v })}
            status={status}
            labels={labels}
            errors={errors}
          />
        ))}
      </fieldset>
    );
  if (f.kind === "list")
    return (
      <fieldset aria-invalid={errors.includes(path) || undefined} tabIndex={-1}>
        <legend>{f.label}</legend>
        {(value ?? []).map((v: any, i: number) => (
          <details className="repeated-row" key={i} open>
            <summary>
              {f.item!.label || f.label} {i + 1}
              {typeof v === "object"
                ? ` · ${v.label || v.name || v.host || v.role || "New entry"}`
                : v
                  ? ` · ${v}`
                  : ""}
            </summary>
            <EditorField
              field={f.item!}
              value={v}
              root={root}
              path={`${path}.${i}`}
              change={(next) =>
                change(
                  value.map((old: any, j: number) => (j === i ? next : old)),
                )
              }
              status={status}
              labels={labels}
              errors={errors}
            />
            <button
              type="button"
              onClick={() =>
                change(value.filter((_: any, j: number) => i !== j))
              }
            >
              Remove {f.item!.label} {i + 1}
            </button>
          </details>
        ))}
        <button
          type="button"
          disabled={f.max !== undefined && value?.length >= f.max}
          onClick={() =>
            change([
              ...(value ?? []),
              defaults([{ ...f.item!, key: "item" }]).item,
            ])
          }
        >
          Add {f.item!.label}
        </button>
        {f.min && (!value || value.length < f.min) ? (
          <p className="error">
            Add at least {f.min} {f.label.toLowerCase()}.
          </p>
        ) : null}
      </fieldset>
    );
  if (f.kind === "select" && f.source)
    return (
      <ResourceSelect
        key={typeof f.source === "function" ? f.source(root) : f.source}
        source={typeof f.source === "function" ? f.source(root) : f.source}
        label={f.label}
        name={path}
        value={value}
        onChange={change}
        multiple={f.multiple}
        optional={f.optional || f.nullable}
        onReady={(ready) => status(path, ready)}
        onOptions={labels}
        min={f.min}
        max={f.max}
        invalid={errors.includes(path)}
      />
    );
  if (f.kind === "boolean")
    return (
      <label className="checkbox">
        <input
          name={path}
          type="checkbox"
          checked={!!value}
          onChange={(e) => change(e.target.checked)}
        />
        {f.label}
      </label>
    );
  return (
    <div className="form-field">
      {label}
      {f.kind === "select" ? (
        <select
          {...shared}
          value={value ?? ""}
          onChange={(e) => change(e.target.value)}
        >
          {f.choices!.map((c) => (
            <option key={c} value={c}>
              {human(c)}
            </option>
          ))}
        </select>
      ) : f.kind === "markdown" || f.kind === "textarea" ? (
        <>
          <textarea
            {...shared}
            rows={4}
            value={value ?? ""}
            onChange={(e) => change(e.target.value)}
          />
          {f.kind === "markdown" && (
            <details>
              <summary>
                Preview {f.label.replace(" (Markdown)", "").toLowerCase()}
              </summary>
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]}>
                  {value || "Nothing to preview yet."}
                </Markdown>
              </div>
            </details>
          )}
        </>
      ) : f.kind === "datetime-local" ? (
        <LocalDate {...shared} value={value} onChange={change} />
      ) : (
        <input
          {...shared}
          type={f.kind}
          value={value ?? ""}
          autoComplete={f.kind === "password" ? "new-password" : undefined}
          min={f.kind === "number" ? f.min : undefined}
          max={f.kind === "number" ? f.max : undefined}
          step={f.kind === "number" ? 1 : undefined}
          pattern={f.pattern}
          onChange={(e) =>
            change(
              f.kind === "number" && e.target.value !== ""
                ? Number(e.target.value)
                : e.target.value,
            )
          }
        />
      )}
      {f.help && <small>{f.help}</small>}
      {errors.includes(path) && (
        <p className="error">Check {f.label.toLowerCase()}.</p>
      )}
    </div>
  );
}
function collectionError(
  fields: FieldSpec[],
  values: Values,
  root = values,
): string | undefined {
  for (const f of fields) {
    if (f.show && !f.show(root)) continue;
    const v = values[f.key];
    if (
      (f.multiple || f.kind === "list") &&
      ((f.min !== undefined && (v?.length ?? 0) < f.min) ||
        (f.max !== undefined && (v?.length ?? 0) > f.max))
    )
      return `Check the number of ${f.label.toLowerCase()}.`;
    if (f.multiple && new Set(v).size !== v.length)
      return `Remove duplicate ${f.label.toLowerCase()}.`;
    if (f.kind === "object") {
      const e = collectionError(f.fields!, v ?? {}, root);
      if (e) return e;
    }
    if (f.kind === "list" && f.item?.kind === "object")
      for (const row of v ?? []) {
        const e = collectionError(f.item.fields!, row, root);
        if (e) return e;
      }
  }
}
function collectionInvalidPaths(
  fields: FieldSpec[],
  values: Values,
  root = values,
  prefix = "",
): string[] {
  return fields.flatMap((f) => {
    if (f.show && !f.show(root)) return [];
    const v = values[f.key],
      path = `${prefix}${f.key}`;
    const paths =
      (f.multiple || f.kind === "list") &&
      ((f.min !== undefined && (v?.length ?? 0) < f.min) ||
        (f.max !== undefined && (v?.length ?? 0) > f.max))
        ? [path]
        : [];
    if (f.kind === "object")
      paths.push(
        ...collectionInvalidPaths(f.fields!, v ?? {}, root, `${path}.`),
      );
    if (f.kind === "list" && f.item?.kind === "object")
      (v ?? []).forEach((row: Values, i: number) =>
        paths.push(
          ...collectionInvalidPaths(
            f.item!.fields!,
            row,
            root,
            `${path}.${i}.`,
          ),
        ),
      );
    return paths;
  });
}
interface Props {
  title: string;
  url: string;
  initial: Values;
  method?: string;
  done?: () => void;
  fields?: FieldSpec[];
  previewUrl?: string;
  inline?: boolean;
  inheritedRoles?: Values[];
  channelPreferences?: Values[];
}
export function StructuredForm({
  title,
  url,
  initial,
  method = "POST",
  done,
  fields = fieldsFor(url),
  previewUrl,
  inheritedRoles = [],
  channelPreferences = [],
}: Props) {
  const draftKey = `${method}:${url}:${title}`;
  const [values, setValues] = useState(
      () => drafts.get(draftKey) ?? defaults(fields, initial),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [errors, setErrors] = useState<string[]>([]),
    [result, setResult] = useState<any>(),
    [review, setReview] = useState<{ body: Values; preview?: any }>(),
    [typed, setTyped] = useState(""),
    [blocked, setBlocked] = useState<Record<string, boolean>>({}),
    [labels, setLabels] = useState<Record<string, string>>({}),
    [conflict, setConflict] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const baseline = useRef(JSON.stringify(defaults(fields, initial)));
  const dirty = JSON.stringify(values) !== baseline.current;
  useEffect(() => {
    if (dirty) drafts.set(draftKey, values);
    else drafts.delete(draftKey);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, draftKey, values]);
  useEffect(() => {
    if (!busy && errors.length) {
      const invalid = form.current?.querySelector<HTMLElement>(
        "[aria-invalid=true]",
      );
      if (invalid) revealField(invalid);
    }
  }, [busy, errors]);
  const presented = presentFields(
    fields,
    /^\/api\/services(?:\/[^/]+)?$/.test(url),
  );
  const confirmation =
    url.endsWith("/decide") && values.decision !== "approved"
      ? undefined
      : initial.confirmation;
  const needsTyped = [
    "OFFBOARD",
    "CHANGE ROLES",
    "DELETE",
    "ROTATE SECRET",
  ].includes(confirmation);
  const addLabels = (options: Option[]) =>
    setLabels((prev) => ({
      ...prev,
      ...Object.fromEntries(
        options.map((o) => [
          o.id,
          `${o.label}${o.description ? ` · ${o.description}` : ""}`,
        ]),
      ),
    }));
  const status = (path: string, ready: boolean) =>
    setBlocked((prev) => ({ ...prev, [path]: !ready }));
  async function submit() {
    setBusy(true);
    setError("");
    setErrors([]);
    try {
      const body = review?.body ?? {
        ...payload(fields, values),
        ...(initial.confirmation ? { confirmation } : {}),
      };
      const invalidPaths = collectionInvalidPaths(fields, values);
      if (invalidPaths.length) setErrors(invalidPaths);
      const message =
        collectionError(fields, values) ||
        validate(body) ||
        (body.roles?.some((r: Values) =>
          inheritedRoles.some((i) => i.role === r.role && i.scope === r.scope),
        )
          ? "This role and scope are already inherited. Remove the duplicate operator assignment."
          : undefined);
      if (message) throw new Error(message);
      if (!review && (confirmation || previewUrl)) {
        const preview = previewUrl
          ? await api(
              previewUrl,
              "POST",
              Object.fromEntries(
                Object.entries(body).filter(([key]) => key !== "confirmation"),
              ),
            )
          : undefined;
        setReview({ body: structuredClone(body), preview });
        return;
      }
      if (needsTyped && typed !== confirmation)
        throw new Error(`Type ${confirmation} to confirm.`);
      const response = await api(url, method, body);
      setResult(response);
      drafts.delete(draftKey);
      baseline.current = JSON.stringify({
        ...values,
        ...(values.version !== undefined &&
        (response?.version !== undefined ||
          response?.current_version !== undefined)
          ? { version: response.current_version ?? response.version }
          : {}),
        ...(url === "/api/admin/secrets" ? { value: "" } : {}),
      });
      if (
        values.version !== undefined &&
        (response?.version !== undefined ||
          response?.current_version !== undefined)
      )
        setValues((v) => ({
          ...v,
          version: response.current_version ?? response.version,
        }));
      setReview(undefined);
      setTyped("");
      if (url === "/api/admin/secrets") setValues((v) => ({ ...v, value: "" }));
      done?.();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError) {
        setErrors(e.fields);
        setConflict(e.status === 409 && initial.version !== undefined);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      ref={form}
      className="structured-form"
      data-dirty={dirty}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const invalid = Array.from(e.currentTarget.elements).find(
          (el) => "validity" in el && !(el as HTMLInputElement).validity.valid,
        ) as HTMLInputElement | undefined;
        if (invalid) {
          revealField(invalid);
          invalid.reportValidity();
          return;
        }
        void submit();
      }}
    >
      <fieldset disabled={busy} className="form-body">
        {[...new Set(presented.map((p) => p.group))].map((group) => (
          <details
            className="form-section"
            key={group}
            open={!presented.find((p) => p.group === group)?.advanced}
          >
            <summary>
              {group}
              <span>
                {presented.filter((p) => p.group === group).length} fields
              </span>
            </summary>
            <div className="section-fields">
              {presented
                .filter((p) => p.group === group)
                .map(({ field: f, path }) => (
                  <EditorField
                    key={path}
                    field={f}
                    value={path.split(".").reduce((v, k) => v?.[k], values)}
                    root={values}
                    path={path}
                    change={(v) => {
                      setValues((prev) => {
                        const next = structuredClone(prev);
                        const keys = path.split(".");
                        const key = keys.pop()!;
                        const target = keys.reduce(
                          (obj, k) => (obj[k] ??= {}),
                          next,
                        );
                        target[key] = v;
                        if (f.key === "channel")
                          next.enabled =
                            channelPreferences.find((p) => p.channel === v)
                              ?.enabled ?? false;
                        if (
                          ["provider", "networkId"].includes(f.key) &&
                          "externalId" in prev
                        )
                          next.externalId = "";
                        return next;
                      });
                      setReview(undefined);
                      setTyped("");
                      setResult(undefined);
                    }}
                    status={status}
                    labels={addLabels}
                    errors={errors}
                  />
                ))}
            </div>
          </details>
        ))}
      </fieldset>
      {review && (
        <section className="review panel" aria-label="Review changes">
          <h3>Review {title.toLowerCase()}</h3>
          <ReadableResult
            value={Object.fromEntries(
              Object.entries(review.body)
                .filter(([k]) => k !== "confirmation" && k !== "version")
                .map(([k, v]) => [
                  k,
                  url === "/api/admin/secrets" && k === "value"
                    ? "••••••••"
                    : v,
                ]),
            )}
            labels={labels}
          />
          {review.preview && (
            <ReadableResult value={review.preview} labels={labels} />
          )}
          <p>Confirm to apply these values.</p>
          {needsTyped && (
            <label>
              Type {confirmation} to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
          )}
          <button
            type="button"
            onClick={() => {
              setReview(undefined);
              setTyped("");
            }}
          >
            Back to editing
          </button>
        </section>
      )}
      {error && (
        <div className="error" role="alert">
          {human(error)}
          {errors.length > 0 && <p>Check: {errors.map(human).join(", ")}.</p>}
        </div>
      )}
      {conflict && (
        <p>
          This record changed while you were editing. Your draft is retained.{" "}
          <button
            type="button"
            onClick={() =>
              void (async () => {
                try {
                  let latest: Values;
                  if (url.startsWith("/api/services/")) {
                    const s = await api(url);
                    latest = {
                      ...s,
                      entitlementIds: s.requirements.map((e: Values) => e.id),
                    };
                  } else if (url.startsWith("/api/guides/")) {
                    const g = (await api("/api/guides")).find((g: Values) =>
                      url.endsWith(`/${g.id}`),
                    );
                    latest = {
                      ...g,
                      serviceId: g.service_id,
                      version: g.current_version,
                    };
                  } else {
                    const all = await api("/api/admin/access-configuration");
                    latest = (
                      url.includes("/bundles/") ? all.bundles : all.entitlements
                    ).find((r: Values) => url.endsWith(`/${r.id}`));
                  }
                  if (!latest)
                    throw new Error("Record is no longer available.");
                  baseline.current = JSON.stringify(defaults(fields, latest));
                  drafts.delete(draftKey);
                  setValues(defaults(fields, latest));
                  setConflict(false);
                  setReview(undefined);
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                }
              })()
            }
          >
            Reload latest values
          </button>
        </p>
      )}
      <div className="form-actions">
        {dirty && (
          <button
            type="button"
            onClick={() => {
              if (
                !window.confirm(
                  "Discard this draft and restore the last saved values?",
                )
              )
                return;
              drafts.delete(draftKey);
              setValues(JSON.parse(baseline.current));
              setReview(undefined);
              setTyped("");
              setErrors([]);
              setError("");
            }}
          >
            Discard draft
          </button>
        )}
        <small>
          {dirty ? "Unsaved changes · draft kept in memory" : "Ready to edit"}
        </small>
        <button
          className="primary"
          disabled={
            busy ||
            Object.values(blocked).some(Boolean) ||
            !!(review && needsTyped && typed !== confirmation)
          }
        >
          {busy
            ? "Working…"
            : review
              ? `Confirm ${title.toLowerCase()}`
              : previewUrl
                ? `Preview ${title.toLowerCase()}`
                : confirmation
                  ? `Review ${title.toLowerCase()}`
                  : title}
        </button>
      </div>
      {result !== undefined && (
        <section aria-label="Operation result">
          <p role="status">Saved.</p>
          <ReadableResult
            value={Object.fromEntries(
              Object.entries(result ?? {}).filter(
                ([k]) =>
                  ![
                    "token",
                    "invitation",
                    ...(url.includes("setup-keys") ? ["key"] : []),
                    ...(url.includes("enrollment") ? ["url"] : []),
                  ].includes(k),
              ),
            )}
            labels={labels}
          />
          {["key", "token", "invitation", "url"]
            .filter(
              (k) =>
                typeof result?.[k] === "string" &&
                (k !== "key" || url.includes("setup-keys")),
            )
            .map((k) => (
              <OneTimeValue key={k} value={result[k]} />
            ))}
        </section>
      )}
    </form>
  );
}
function OneTimeValue({ value }: { value: string }) {
  const [hidden, setHidden] = useState(false),
    [message, setMessage] = useState("");
  return hidden ? (
    <p>Credential hidden.</p>
  ) : (
    <div className="panel">
      <strong>Copy and store securely</strong>
      <p>
        <code>{value}</code>
      </p>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(
            () => setMessage("Copied."),
            () => setMessage("Copy failed; select and copy the value above."),
          )
        }
      >
        Copy credential
      </button>
      <button type="button" onClick={() => setHidden(true)}>
        Hide credential
      </button>
      <p role="status">{message}</p>
    </div>
  );
}
function RoleEditor(props: Props) {
  const [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api(props.url).then(
      (v) => {
        if (active) {
          setData(v);
          setError("");
        }
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [props.url, attempt]);
  if (error)
    return (
      <p role="alert">
        {human(error)}{" "}
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          Retry roles
        </button>
      </p>
    );
  if (!data) return <p role="status">Loading current roles…</p>;
  const inherited = data.roles.filter((r: Values) => r.source !== "operator");
  return (
    <>
      <h4>Inherited roles (read only)</h4>
      <ReadableResult value={inherited} />
      {data.editable ? (
        <StructuredForm
          {...props}
          inheritedRoles={inherited}
          initial={{
            roles: data.roles
              .filter((r: Values) => r.source === "operator")
              .map(({ role, scope }: Values) => ({ role, scope })),
            confirmation: "CHANGE ROLES",
          }}
        />
      ) : (
        <p>You cannot change your own roles.</p>
      )}
    </>
  );
}
function PreferenceEditor(props: Props) {
  const [preferences, setPreferences] = useState<Values[]>(),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api(props.url).then(
      (rows) => {
        if (active) {
          setPreferences(rows);
          setError("");
        }
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [props.url, attempt]);
  if (error)
    return (
      <p role="alert">
        {human(error)}{" "}
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          Retry preferences
        </button>
      </p>
    );
  if (!preferences) return <p role="status">Loading delivery preferences…</p>;
  return (
    <StructuredForm
      {...props}
      initial={{
        ...props.initial,
        enabled:
          preferences.find((p) => p.channel === props.initial.channel)
            ?.enabled ?? false,
      }}
      channelPreferences={preferences}
      done={() => {
        setAttempt((n) => n + 1);
        props.done?.();
      }}
    />
  );
}
export function ActionForm(props: Props) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className="panel"
      onToggle={(e) => {
        if (e.currentTarget.open) setOpened(true);
      }}
    >
      <summary>{props.title}</summary>
      {opened &&
        (props.url === "/api/notification-preferences" ? (
          <PreferenceEditor {...props} />
        ) : /\/roles$/.test(props.url) ? (
          <RoleEditor {...props} />
        ) : (
          <StructuredForm {...props} />
        ))}
    </details>
  );
}
