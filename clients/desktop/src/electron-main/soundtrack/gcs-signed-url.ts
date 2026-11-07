import { createHash, createSign } from "node:crypto";
import type { ServiceAccountKey } from "../auth/google-service-account";

/**
 * A short-lived read link to one object of a private bucket, signed here with
 * the service account's own key: Google's V4 signature (`GOOG4-RSA-SHA256`),
 * with nothing sent to Google to make it.
 *
 * The result is a credential until it expires, and it names the account in its
 * query, so it is handed to the renderer and never logged.
 */

const HOST = "storage.googleapis.com";
const ALGORITHM = "GOOG4-RSA-SHA256";
const LIFETIME_SECONDS = 3600;
/** `host` is the only header a browser can be relied on to send unchanged. */
const SIGNED_HEADERS = "host";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** RFC 3986's unreserved set, which `encodeURIComponent` is four short of. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function signGcsReadUrl(
  key: ServiceAccountKey,
  bucket: string,
  objectName: string,
  nowMs: number,
): string {
  // 2026-11-03T04:05:06.000Z becomes 20261103T040506Z.
  const activeDatetime = new Date(nowMs)
    .toISOString()
    .replace(/[-:]|\.\d{3}/g, "");
  const credentialScope = `${activeDatetime.slice(0, 8)}/auto/storage/goog4_request`;
  const path = `/${bucket}/${objectName.split("/").map(percentEncode).join("/")}`;
  // Written in the code-point order the canonical query string requires.
  const query = [
    ["X-Goog-Algorithm", ALGORITHM],
    ["X-Goog-Credential", `${key.clientEmail}/${credentialScope}`],
    ["X-Goog-Date", activeDatetime],
    ["X-Goog-Expires", String(LIFETIME_SECONDS)],
    ["X-Goog-SignedHeaders", SIGNED_HEADERS],
  ]
    .map(([name, value]) => `${name}=${percentEncode(value)}`)
    .join("&");
  const canonicalRequest = [
    "GET",
    path,
    query,
    `host:${HOST}`,
    "",
    SIGNED_HEADERS,
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const stringToSign = [
    ALGORITHM,
    activeDatetime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = createSign("RSA-SHA256")
    .update(stringToSign)
    .sign(key.privateKey, "hex");
  return `https://${HOST}${path}?${query}&X-Goog-Signature=${signature}`;
}
