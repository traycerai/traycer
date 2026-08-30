/**
 * The client-side entry point for cookie-scope domain derivation.
 *
 * The implementation lives in `@traycer/protocol` because the host derives the
 * very same scope for its headless captures and merges every delta against it -
 * two copies of this heuristic would let the desktop and the host disagree
 * about which jar slice a capture covers. Clients import it from here so the
 * protocol dependency stays a single, obvious hop.
 *
 * See the protocol module for how the split is decided (the public suffix list
 * via `tldts`, with the pre-PSL heuristic as the fallback for hosts the list
 * cannot place) and why the private section of the list is honoured.
 */
export {
  cookieDomainInScope,
  registrableDomain,
  registrableDomainForUrl,
} from "@traycer/protocol/host/browser/registrable-domain";
