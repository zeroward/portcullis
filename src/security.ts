import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "./errors.js";
export const token = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function encrypt(value: string, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), payload]
    .map((x) => x.toString("base64url"))
    .join(".");
}
export function decrypt(value: string, key: string) {
  const [iv, tag, payload] = value
    .split(".")
    .map((x) => Buffer.from(x, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(payload), cipher.final()]).toString(
    "utf8",
  );
}
export function safeUrl(value: string, launch = false) {
  const url = new URL(value);
  if (
    !["http:", "https:", ...(launch ? ["steam:", "rdp:"] : [])].includes(
      url.protocol,
    ) ||
    url.username ||
    url.password
  )
    throw new AppError("unsafe_url");
  return value;
}
export function signedBody(body: string, key: string) {
  return createHmac("sha256", key).update(body).digest("hex");
}
export function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /secret|token|password|authorization|code|cookie|api.?key/i.test(k)
          ? "[REDACTED]"
          : redact(v),
      ]),
    );
  if (typeof value === "string")
    return value
      .replace(/\b(Bearer|Token)\s+[A-Za-z0-9._~+\/-]+/gi, "$1 [REDACTED]")
      .replace(
        /\b(password|secret|api_key|access_token)=([^\s&]+)/gi,
        "$1=[REDACTED]",
      );
  return value;
}
export function stableJson(value: any): string {
  const normalize = (v: any): any =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, normalize(v[k])]),
          )
        : v;
  return JSON.stringify(normalize(value));
}
