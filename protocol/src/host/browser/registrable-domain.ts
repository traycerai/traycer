/**
 * Registrable-domain ("eTLD+1") derivation for cookie scopes, over the public
 * suffix list.
 *
 * Two callers depend on this split, and they want different things from it:
 *
 * - **Coalescing** (ticket 06): a burst of cookie changes across
 *   `a.example.com`, `www.example.com` and `example.com` must collapse into one
 *   `{ kind: "domain", domain }` capture scope, and both ends of the wire have
 *   to agree on which one. That is why this lives in the protocol package
 *   rather than in either client: the desktop derives the scope, the host
 *   merges against it, and a disagreement would silently split one jar slice
 *   in two.
 * - **Blast radius** (ticket 07's "clear cookies for this site"): the derived
 *   domain is the set of cookies the user is about to destroy, here and in
 *   every other live context for them. Over-coalescing there is not a wasted
 *   window, it is signing the user out of somebody else's site:
 *   `user.github.io` collapsed to `github.io` would clear every GitHub Pages
 *   login on the machine. That is what buys the public suffix list.
 *
 * So `tldts` decides, with `allowPrivateDomains` on: the private section of the
 * list is exactly the "these subdomains are separate sites" registry
 * (`github.io`, `s3.amazonaws.com`, ...) that the blast radius has to respect.
 */

import { getDomain } from "tldts";

/**
 * The registrable domain of a host, or `null` when there is nothing sensible to
 * derive (empty input). IP literals, `localhost`, and any other host the public
 * suffix list cannot place answer with themselves: they have no registrable
 * parent, and a cookie on one is scoped to exactly it.
 *
 * A leading dot - the RFC 6265 wire form of a domain cookie (`.example.com`) -
 * is stripped, as is one trailing root dot.
 */
export function registrableDomain(host: string): string | null {
  const normalized = normalizeHost(host);
  if (normalized === null) return null;
  // `allowPrivateDomains` keeps a hosting suffix (`github.io`, `vercel.app`,
  // `s3.amazonaws.com`) a suffix, so one tenant's cookies are never in another
  // tenant's clear-site scope.
  return getDomain(normalized, { allowPrivateDomains: true }) ?? normalized;
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

/**
 * Lowercased, dot-trimmed, IDNA-encoded host, or `null` when nothing is left.
 *
 * The punycode step is what makes the two ends of the wire agree on an
 * international domain (browser-security-hardening H11): `tldts` treats
 * `munchen.de` spelled in Unicode and the same name spelled `xn--mnchen-3ya.de`
 * as two different registrable domains, so a capture scope derived from one
 * form rejected every cookie whose jar spelled it the other way. Chromium's
 * jar always holds the A-label form; a wire domain may carry either. Applied
 * only when the host is not already ASCII, so the ordinary case pays nothing.
 */
function normalizeHost(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (host.startsWith(".")) host = host.slice(1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.length === 0) return null;
  if (!ASCII_ONLY_PATTERN.test(host)) {
    try {
      host = new URL(`https://${host}/`).hostname;
    } catch {
      return null;
    }
  }
  return host.length === 0 ? null : host;
}

const ASCII_ONLY_PATTERN = /^[\x00-\x7F]*$/u;
