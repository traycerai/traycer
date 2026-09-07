/**
 * Reads the `exp` claim from a host access token without verifying it.
 * The client decodes `exp` only to schedule a *proactive* refresh shortly before the token would expire, so a long-open session never carries a dead bearer into a live cloud call.
 */

/**
 * Epoch milliseconds at which `token` expires, or `null` when the token is not a decodable JWT or carries no finite numeric `exp` claim.
 * The returned value is in milliseconds (the JWT `exp` claim is seconds since the epoch per rfc 7519; this multiplies into the millisecond clock the schedulers use).
 */
export function readAccessTokenExpiryMs(token: string): number | null {
  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }
  const expSeconds = readExpSeconds(decodeJwtSegment(segments[1]));
  return expSeconds === null ? null : Math.trunc(expSeconds * 1000);
}

function decodeJwtSegment(segment: string): unknown {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let json: string;
  try {
    json = atob(padded);
  } catch {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Extracts a finite numeric `exp` (in seconds) from a decoded JWT payload, or `null` when absent / non-numeric.
 * The `"exp" in value` narrowing lets us read the claim off `unknown` without an unsafe assertion.
 */
function readExpSeconds(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("exp" in value)) {
    return null;
  }
  const exp = value.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}
