let csrf = "";
export function setCsrfToken(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public fields: string[] = [],
  ) {
    super(message);
  }
}
export async function api(url: string, method = "GET", body?: unknown) {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers:
      method === "GET"
        ? {}
        : { "content-type": "application/json", "x-csrf-token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : { ok: true };
  if (!response.ok)
    throw new ApiError(
      result.message ?? result.error ?? "Request failed",
      response.status,
      result.fields ?? [],
    );
  return result;
}
