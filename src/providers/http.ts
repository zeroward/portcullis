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
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly provider: string,
    readonly retryable = false,
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
    if (response.status === 204) return schema.parse(undefined);
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
          throw new ProviderError("contract-mismatch", this.provider);
        }
        text += Buffer.from(result.value).toString("utf8");
      }
    try {
      return schema.parse(text ? JSON.parse(text) : undefined);
    } catch {
      throw new ProviderError("contract-mismatch", this.provider);
    }
  }
}
export const pathId = (id: string) =>
  encodeURIComponent(z.string().min(1).max(255).parse(id));
export const writeResult = z.unknown();
