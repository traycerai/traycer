/**
 * Registrable-domain ("eTLD+1") derivation for cookie scopes, over the public
 * suffix list.
 *
 * Two callers depend on this split, and they want different things from it:
 *
 * - **Coalescing**: a burst of cookie changes across
 *   `a.example.com`, `www.example.com` and `example.com` must collapse into one
 *   `{ kind: "domain", domain }` capture scope, and both ends of the wire have
 *   to agree on which one. That is why this lives in the protocol package
 *   rather than in either client: the desktop derives the scope, the host
 *   merges against it, and a disagreement would silently split one jar slice
 *   in two.
 * - **Blast radius** ("clear cookies for this site"): the derived
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
  const normalized = canonicalCookieHost(host);
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
  const host = canonicalCookieHost(cookieDomain);
  const scope = canonicalCookieHost(scopeDomain);
  if (host === null || scope === null) return false;
  return host === scope || host.endsWith(`.${scope}`);
}

/**
 * Lowercased, dot-trimmed, IDNA-encoded cookie host, or `null` when nothing
 * usable is left.
 *
 * The ONE canonicaliser every cookie-host spelling goes through - the capture's
 * `readCookieDomain`, the ownership key's `cookieKeyId`, and
 * {@link registrableDomain} itself. They used to carry three near-copies of it,
 * and the callers differed only in policy (throw vs `null`, whether a leading
 * dot survives), which is exactly what stays with them.
 *
 * The punycode step is what makes the two ends of the wire agree on an
 * international domain: `tldts` treats
 * `munchen.de` spelled in Unicode and the same name spelled `xn--mnchen-3ya.de`
 * as two different registrable domains, so a capture scope derived from one
 * form rejected every cookie whose jar spelled it the other way. Chromium's jar
 * always holds the A-label form; a wire domain may carry either.
 *
 * Anything carrying URL structure is refused rather than parsed. Handing
 * `evil.com/../good.com` or `user@good.com` to the URL parser answers with the
 * host it decided the string meant, and a caller asking "what is this cookie's
 * host" would take that answer as the sender's claim - so a claim that is not
 * purely a host is not a claim at all.
 */
export function canonicalCookieHost(host: string): string | null {
  // Deliberately NOT trimmed: whitespace is refused by the syntax gate below
  // rather than normalised away. A sender that wrote `example.test\n` wrote
  // something this is not willing to read as `example.test`.
  let value = host.toLowerCase();
  if (value.startsWith(".")) value = value.slice(1);
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (value.length === 0) return null;
  // An IPv6 literal is the one legitimate host spelling that contains a
  // character the syntax gate refuses, so it is recognised WHOLE before the
  // gate rather than exempted from it, in either of the two spellings a jar
  // hands out. Two colons at least: one colon is a port, and `bad.cafe:80`
  // would otherwise read as an address.
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
