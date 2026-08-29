/**
 * The client-side entry point for cookie-scope domain derivation.
 *
 * The implementation lives in `@traycer/protocol` because the host derives the
 * very same scope for its headless captures and merges every delta against it -
 * two copies of this heuristic would let the desktop and the host disagree
 * about which jar slice a capture covers. Clients import it from here so the
 * protocol dependency stays a single, obvious hop.
 *
 * See the protocol module for why this is a PSL-free heuristic and what an
 * imprecise split does (and does not) cost.
 */
export {
  cookieDomainInScope,
  registrableDomain,
  registrableDomainForUrl,
} from "@traycer/protocol/host/browser/registrable-domain";
