/**
 * Registrable-domain ("eTLD+1") derivation for cookie scopes, over the public suffix list.
 * **Coalescing**: a burst of cookie changes across `a.example.com`, `www.example.com` and `example.com` must collapse into one `{ kind: "domain", domain }` capture scope, and both ends of the wire have to agree on which.
 */

import { getDomain } from "tldts";

/**
 * The registrable domain of a host, or `null` when there is nothing sensible to derive (empty input).
 * IP literals, `localhost`, and any other host the public suffix list cannot place answer with themselves: they have no registrable parent, and a cookie on one is scoped to exactly it.
 */
export function registrableDomain(host: string): string | null {
  const normalized = canonicalCookieHost(host);
  if (normalized === null) return null;
  // `allowPrivateDomains` keeps a hosting suffix (`github.io`, `vercel.app`, `s3.amazonaws.com`) a suffix, so one tenant's cookies are never in another tenant's clear-site scope.
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
 * RFC 6265 §5.1.3 domain-match, applied with a capture scope as the `domainString`: true when `cookieDomain` names the scope itself or any host beneath it.
 */
export function cookieDomainInScope(
  cookieDomain: string,
  scopeDomain: string,
): boolean {
  const host = canonicalCookieHost(cookieDomain);
  const scope = canonicalCookieHost(scopeDomain);
  if (host === null || scope === null) return false;
  return host === scope || host.endsWith(`.${scope}`);
}

/** Lowercased, dot-trimmed, IDNA-encoded cookie host, or `null` when nothing usable is left. */
export function canonicalCookieHost(host: string): string | null {
  // Deliberately NOT trimmed: whitespace is refused by the syntax gate below rather than normalised away.
  let value = host.toLowerCase();
  if (value.startsWith(".")) value = value.slice(1);
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (value.length === 0) return null;
  const literal =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (IPV6_LITERAL_PATTERN.test(literal) && literal.split(":").length > 2) {
    return literal;
  }
  if (URL_SYNTAX_PATTERN.test(value)) return null;
  if (ASCII_ONLY_PATTERN.test(value)) return value;
  let canonical: string;
  try {
    canonical = new URL(`https://${value}/`).hostname;
  } catch {
    return null;
  }
  return canonical.length === 0 ? null : canonical;
}

const ASCII_ONLY_PATTERN = /^[\x00-\x7F]*$/u;
const IPV6_LITERAL_PATTERN = /^[0-9a-f:.]+$/u;
/**
 * Userinfo, a port, a path, a query, a fragment, a backslash, whitespace, a
 * control character: everything that makes a string more than a host.
 */
const URL_SYNTAX_PATTERN = /[@:/?#\\\s\x00-\x1F\x7F]/u;
