/**
 * R2 through its S3 API, signed with AWS Signature V4 (no SDK). publish.ts uses it when R2_ACCESS_KEY_ID and
 * R2_SECRET_ACCESS_KEY are set: an R2 token scoped to one bucket (Object Read & Write) works only through the
 * S3 API, not the Cloudflare REST API, so this is how contributors publish to a review bucket.
 *
 * Endpoint: https://<account>[.<jurisdiction>].r2.cloudflarestorage.com/<bucket>/<key>, region "auto".
 */
import { createHash, createHmac } from "node:crypto";
import { HOSTING } from "./hosting.ts";

export const s3Keys = () => {
  const id = process.env.R2_ACCESS_KEY_ID, secret = process.env.R2_SECRET_ACCESS_KEY;
  return id && secret ? { id, secret } : null;
};

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();
// RFC 3986 per path segment, as SigV4 wants it
const enc = (key: string) => key.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

/** A signed S3 request to R2 for `key` in HOSTING.bucket. */
export function s3Fetch(method: "PUT" | "DELETE" | "HEAD", key: string, body?: Buffer<ArrayBuffer>, extra: Record<string, string> = {}): Promise<Response> {
  const keys = s3Keys();
  if (!keys) throw new Error("R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not set");
  const host = `${HOSTING.accountId}${HOSTING.jurisdiction ? `.${HOSTING.jurisdiction}` : ""}.r2.cloudflarestorage.com`;
  const path = `/${HOSTING.bucket}/${enc(key)}`;
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""), day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
    host, "x-amz-content-sha256": sha256(body ?? ""), "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonical = [method, path, "", ...names.map((n) => `${n}:${headers[n].trim()}`), "", names.join(";"), headers["x-amz-content-sha256"]].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSign = hmac(hmac(hmac(hmac(`AWS4${keys.secret}`, day), "auto"), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSign).update(toSign).digest("hex");
  const { host: _host, ...send } = headers;
  return fetch(`https://${host}${path}`, {
    method, body,
    headers: { ...send, Authorization: `AWS4-HMAC-SHA256 Credential=${keys.id}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` },
  });
}

/** Upload one object; checked by its ETag (the MD5 of a single-part upload). */
export async function s3Put(key: string, body: Buffer<ArrayBuffer>, contentType: string, cacheControl: string): Promise<void> {
  const r = await s3Fetch("PUT", key, body, { "Content-Type": contentType, "Cache-Control": cacheControl });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  const etag = r.headers.get("etag")?.replace(/"/g, ""), md5 = createHash("md5").update(body).digest("hex");
  if (etag !== md5) throw new Error(`stored ETag ${etag}, local MD5 ${md5}`);
}
