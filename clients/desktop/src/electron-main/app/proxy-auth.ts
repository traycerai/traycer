import { app, session, type AuthInfo, type ProxyConfig } from "electron";
import { log } from "./logger";

interface InMemoryCredential {
  readonly username: string;
  readonly password: string;
}

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

export async function setSessionProxy(config: ProxyConfig): Promise<void> {
  await session.defaultSession.setProxy(config);
  log.info("[proxy-auth] proxy config applied", { mode: config.mode });
}

export async function resolveProxyForUrl(url: string): Promise<string> {
  return session.defaultSession.resolveProxy(url);
}
