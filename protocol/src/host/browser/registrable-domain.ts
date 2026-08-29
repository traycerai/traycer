/**
 * Registrable-domain ("eTLD+1") derivation for cookie scopes, without a public
 * suffix list.
 *
 * The one job here is **coalescing**: a burst of cookie changes across
 * `a.example.com`, `www.example.com` and `example.com` must collapse into one
 * `{ kind: "domain", domain }` capture scope, and both ends of the wire have to
 * agree on which one. That is why this lives in the protocol package rather
 * than in either client: the desktop derives the scope, the host merges against
 * it, and a disagreement would silently split one jar slice in two.
 *
 * It is deliberately a heuristic. A domain-scoped capture always carries the
 * complete picture of its scope (every cookie the scope subtree holds), so
 * getting the split wrong is a coalescing loss, never a correctness loss:
 *
 * - **Over-splitting** (`user.github.io` treated as `github.io`, or
 *   `a.example.com` never collapsed with `example.com`) costs an extra capture
 *   window, nothing more.
 * - **Under-splitting** onto a public suffix (`co.uk`) would widen the scope to
 *   a whole registry - still safe, because the cookies sent are exactly the
 *   cookies that scope holds, but wasteful. The two-label-suffix rule below is
 *   what keeps that from happening for the common ccTLD shapes.
 *
 * Ticket 07 ("clear cookies for this site") is the first caller whose blast
 * radius depends on the split, and it is the ticket that decides whether a real
 * PSL is vendored. Until then: no PSL.
 */

/**
 * Generic second-level labels that act as a public suffix under a two-letter
 * ccTLD (`co.uk`, `com.au`, `ne.jp`, ...). Under those, the registrable domain
 * is the last *three* labels.
 */
const CCTLD_SECOND_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  "ac",
  "biz",
  "co",
  "com",
  "edu",
  "gen",
  "go",
  "gov",
  "govt",
  "info",
  "int",
  "mil",
  "ne",
  "net",
  "nhs",
  "nom",
  "or",
  "org",
  "plc",
  "sch",
  "web",
]);

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/**
 * The registrable domain of a host, or `null` when there is nothing sensible to
 * derive (empty input). IP literals, `localhost`, and any other single-label
 * host answer with themselves: they have no registrable parent, and a cookie on
 * one is scoped to exactly it.
 *
 * A leading dot - the RFC 6265 wire form of a domain cookie (`.example.com`) -
 * is stripped, as is one trailing root dot.
 */
export function registrableDomain(host: string): string | null {
  const normalized = normalizeHost(host);
  if (normalized === null) return null;
  if (isIpLiteral(normalized)) return normalized;
  const labels = normalized.split(".");
  if (labels.some((label) => label.length === 0)) return null;
  if (labels.length <= 2) return normalized;
  const tld = labels[labels.length - 1];
  const secondLevel = labels[labels.length - 2];
  if (tld === undefined || secondLevel === undefined) return normalized;
  const takesThree =
    tld.length === 2 && CCTLD_SECOND_LEVEL_SUFFIXES.has(secondLevel);
  return labels.slice(takesThree ? -3 : -2).join(".");
}

/** The registrable domain of a URL's host; `null` for anything unparseable. */
export function registrableDomainForUrl(url: string): string | null {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * RFC 6265 §5.1.3 domain-match, applied with a capture scope as the
 * `domainString`: true when `cookieDomain` names the scope itself or any host
 * beneath it.
 *
 * This is the "belongs to this scope" predicate on both ends. The desktop uses
 * it to prove its `cookies.get({ domain })` result is the complete picture of
 * the scope; the host uses the same rule to decide which stored cookies a
 * domain-scoped capture is allowed to tombstone. They must not drift.
 */
export function cookieDomainInScope(
  cookieDomain: string,
  scopeDomain: string,
): boolean {
  const host = normalizeHost(cookieDomain);
  const scope = normalizeHost(scopeDomain);
  if (host === null || scope === null) return false;
  return host === scope || host.endsWith(`.${scope}`);
}

/** Lowercased, dot-trimmed host, or `null` when nothing is left. */
function normalizeHost(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (host.startsWith(".")) host = host.slice(1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host.length === 0 ? null : host;
}

function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true;
  const octets = IPV4_PATTERN.exec(host);
  if (octets === null) return false;
  return octets.slice(1).every((octet) => Number.parseInt(octet, 10) <= 255);
}
