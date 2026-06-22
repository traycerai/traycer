import { app, session, type AuthInfo, type ProxyConfig } from "electron";
import { log } from "./logger";

interface InMemoryCredential {
  readonly username: string;
  readonly password: string;
}

/**
 * Session-scoped proxy credential cache. Keyed on `host:port|realm` so
 * different proxies on the same host can be stored independently. The
 * store is intentionally in-memory only - Traycer's auth tokens use
 * `encrypt-storage` (AES in `localStorage`) in the renderer specifically
 * to avoid an OS-keychain dependency, and proxy credentials should follow
 * the same posture. Users re-enter once per launch through Electron's
 * built-in basic-auth dialog; subsequent challenges in the same session
 * hit this cache.
 */
const memoryStore = new Map<string, InMemoryCredential>();

function keyOf(host: string, realm: string): string {
  return realm.length > 0 ? `${host}|${realm}` : host;
}

function keyOfChallenge(info: AuthInfo): string {
  return keyOf(`${info.host}:${info.port}`, info.realm);
}

export function saveProxyCredentials(
  host: string,
  realm: string,
  username: string,
  password: string,
): boolean {
  const key = keyOf(host, realm);
  memoryStore.set(key, { username, password });
  log.info("[proxy-auth] cached credentials in-memory", { key });
  return true;
}

export function clearProxyCredentials(host: string, realm: string): void {
  const key = keyOf(host, realm);
  memoryStore.delete(key);
  log.info("[proxy-auth] cleared credentials", { key });
}

export function listKnownProxyCredentials(): ReadonlyArray<{
  readonly key: string;
  readonly username: string;
}> {
  return Array.from(memoryStore.entries()).map(([key, value]) => ({
    key,
    username: value.username,
  }));
}

/**
 * Handles HTTP/proxy basic-auth challenges from Chromium. Strategy:
 *
 *   1. If the in-memory cache has matching credentials from this session,
 *      supply them silently - common path for repeat connections.
 *   2. Otherwise let Electron's default credential dialog appear. The
 *      renderer can capture and cache the credentials via
 *      `saveProxyCredentials` so subsequent challenges in the same
 *      session hit step (1).
 *
 * The dialog re-fires once per session boundary. Users behind always-on
 * corporate proxies typically click "Save" once, are good for the session,
 * and re-authenticate at next launch (matching browser-tab behavior).
 */
export function installProductionProxyAuthHandler(): void {
  app.on("login", (event, _webContents, request, authInfo, callback) => {
    const entry = memoryStore.get(keyOfChallenge(authInfo));
    if (entry === undefined) {
      log.warn("[proxy-auth] no cached credentials; system dialog fallback", {
        isProxy: authInfo.isProxy,
        host: authInfo.host,
        realm: authInfo.realm,
        requestUrl: request.url,
      });
      // Do NOT preventDefault - let Electron's built-in dialog handle it.
      return;
    }
    event.preventDefault();
    log.info("[proxy-auth] supplied cached credentials", {
      host: authInfo.host,
    });
    callback(entry.username, entry.password);
  });
}

/**
 * Applies a session-level proxy configuration. Useful when the user wants
 * to override the system proxy (e.g., point through a different upstream
 * for testing, or supply a PAC script).
 */
export async function setSessionProxy(config: ProxyConfig): Promise<void> {
  await session.defaultSession.setProxy(config);
  log.info("[proxy-auth] proxy config applied", { mode: config.mode });
}

/**
 * Returns the proxy URL Chromium would use for a given destination. Useful
 * as a diagnostics surface when corporate-network users report
 * "everything fails" - surfaces whether the request would be direct, go
 * through a PAC-resolved proxy, or hit an unreachable server.
 */
export async function resolveProxyForUrl(url: string): Promise<string> {
  return session.defaultSession.resolveProxy(url);
}
