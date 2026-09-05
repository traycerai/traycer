/**
 * The scheme gate every relay dial passes, on BOTH legs.
 *
 * The attach grant rides in the dial URL's query string, and everything after
 * it is Noise ciphertext over that socket - so a `ws:` dial hands the grant to
 * anything on the path, and the E2E channel it protects never gets a chance to
 * matter. Cleartext is allowed only against a loopback relay, which is the
 * local development default (`transport/remote/config.ts` bakes
 * `ws://localhost:8787/attach`).
 *
 * It lives in the protocol package because the host leg and the client leg
 * build the same grant-in-query URL from the same configured base, and a rule
 * two files apart is a rule that drifts.
 */

/**
 * A dial was refused because its attach URL is neither `wss:` nor loopback.
 *
 * Carries the SCHEME only, never the URL: the URL holds the attach grant, and
 * this reason reaches a log on both legs.
 */
export class InsecureRelaySchemeError extends Error {
  readonly scheme: string;

  constructor(scheme: string) {
    super(`the relay attach URL must be wss: (got ${scheme})`);
    this.name = "InsecureRelaySchemeError";
    this.scheme = scheme;
  }
}

/**
 * Loopback literals, plus the NAME `localhost`.
 *
 * The name is not the address, and a hosts-file entry could in principle point
 * it elsewhere - but editing `/etc/hosts` needs root, and a peer with root has
 * strictly better moves than downgrading one WebSocket. What this buys is the
 * developer stack working out of the box, which is the whole reason cleartext
 * is admitted at all.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
]);

/**
 * Throws {@link InsecureRelaySchemeError} unless `attachUrl` is `wss:` or a
 * cleartext loopback URL.
 *
 * Throws rather than degrades on both legs, because both already catch a
 * synchronous throw out of the socket construction and re-arm their backoff
 * loop (`SessionFanOut.dial`, `RemoteSession.beginConnectGuarded`) - so a
 * misconfigured URL parks the uplink instead of leaking the grant.
 */
export function assertRelayAttachUrlSecure(attachUrl: string): void {
  let url: URL;
  try {
    url = new URL(attachUrl);
  } catch {
    throw new InsecureRelaySchemeError("<unparseable>");
  }
  if (url.protocol === "wss:") {
    return;
  }
  if (url.protocol === "ws:" && LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return;
  }
  throw new InsecureRelaySchemeError(url.protocol);
}
