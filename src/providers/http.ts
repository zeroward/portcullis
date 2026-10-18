import { z } from "zod";
export type ProviderErrorCode =
  | "missing-credentials"
  | "unsupported"
  | "unavailable"
  | "timeout"
  | "contract-mismatch"
  | "conflict"
  | "forbidden"
  | "not-found";
interface ContractDetails {
  method: string;
  path: string;
  status: number;
  reason: "invalid-json" | "invalid-response" | "response-too-large";
  fields?: string[];
}
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly provider: string,
    readonly retryable = false,
    readonly details?: ContractDetails,
  ) {
    super(`${provider}: ${code}`);
  }
}
export class ProviderHttp {
  constructor(
    readonly provider: string,
    readonly base: string,
    readonly headers: Record<string, string>,
    readonly timeout = 8000,
  ) {
    const url = new URL(base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ProviderError("contract-mismatch", provider);
  }
  async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    if (!Object.values(this.headers).every(Boolean))
      throw new ProviderError("missing-credentials", this.provider);
    let response: Response;
    try {
      response = await fetch(`${this.base.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          ...this.headers,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
        redirect: "error",
      });
    } catch {
      throw new ProviderError("timeout", this.provider, method !== "POST");
    }
    if (!response.ok) {
      const code =
        response.status === 404
          ? "not-found"
          : response.status === 401 || response.status === 403
            ? "forbidden"
            : response.status === 409
              ? "conflict"
              : "unavailable";
      throw new ProviderError(
        code,
        this.provider,
        response.status === 429 || response.status >= 500,
      );
    }
    const mismatch = (reason: ContractDetails["reason"], fields?: string[]) =>
      new ProviderError("contract-mismatch", this.provider, false, {
        method,
        path: path.split("?")[0],
        status: response.status,
        reason,
        ...(fields ? { fields } : {}),
      });
    const reader = response.body?.getReader();
    let text = "";
    let size = 0;
    if (reader)
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw mismatch("response-too-large");
        }
        text += Buffer.from(result.value).toString("utf8");
      }
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      throw mismatch("invalid-json");
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw mismatch(
        "invalid-response",
        // Report locations only, never response values, headers, or Zod messages.
        [
          ...new Set(
            parsed.error.issues.map((issue) => issue.path.join(".") || "$"),
          ),
        ].slice(0, 20),
      );
    return parsed.data;
  }
}
export const pathId = (id: string) =>
  encodeURIComponent(z.string().min(1).max(255).parse(id));
export const writeResult = z.unknown();
