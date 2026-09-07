/**
 * The scheme gate every relay dial passes, on BOTH legs.
 * The attach grant rides in the dial URL's query string, and everything after it is Noise ciphertext over that socket - so a `ws:` dial hands the grant to anything on the path, and the E2E channel it protects never gets.
 */

/**
 * A dial was refused because its attach URL is neither `wss:` nor loopback.
 * Carries the SCHEME only, never the URL: the URL holds the attach grant, and this reason reaches a log on both legs.
 */
export class InsecureRelaySchemeError extends Error {
  readonly scheme: string;

  constructor(scheme: string) {
    super(`the relay attach URL must be wss: (got ${scheme})`);
    this.name = "InsecureRelaySchemeError";
    this.scheme = scheme;
  }
}

/** Loopback literals, plus the NAME `localhost`. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
]);

/** Throws {@link InsecureRelaySchemeError} unless `attachUrl` is `wss:` or a cleartext loopback URL. */
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
