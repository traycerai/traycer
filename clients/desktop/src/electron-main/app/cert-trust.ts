import { app, dialog, type BrowserWindow, type Certificate } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { log } from "./logger";
import { createJsonFileStore } from "./json-file-store";
import {
  handleBrowserViewCertificateError,
  isBrowserViewWebContents,
} from "../browser-view/browser-session";

const STORE_FILE_NAME = "trusted-certificates.json";

type CertificateTrustScope = "app-shell" | "browser";

interface TrustEntry {
  readonly scope: CertificateTrustScope;
  readonly fingerprint: string;
  readonly hostname: string;
  readonly subject: string;
  readonly issuer: string;
  readonly trustedAt: number;
}

interface TrustStorePayload {
  readonly entries: TrustEntry[];
}

const FALLBACK_PAYLOAD: TrustStorePayload = { entries: [] };

function parsePayload(value: unknown): TrustStorePayload {
  if (!isRecord(value)) return FALLBACK_PAYLOAD;
  const entries = Reflect.get(value, "entries");
  if (!Array.isArray(entries)) return FALLBACK_PAYLOAD;
  return {
    entries: entries.flatMap((entry): TrustEntry[] => {
      const parsed = parseTrustEntry(entry);
      return parsed === null ? [] : [parsed];
    }),
  };
}

let storeFactory: JsonFileStoreHandle | null = null;

interface JsonFileStoreHandle {
  readonly memory: TrustEntry[];
  load(): Promise<void>;
  flush(): Promise<void>;
}

function getStore(): JsonFileStoreHandle {
  if (storeFactory !== null) return storeFactory;
  const store = createJsonFileStore<TrustStorePayload>(
    join(app.getPath("userData"), STORE_FILE_NAME),
    FALLBACK_PAYLOAD,
    parsePayload,
  );
  const memory: TrustEntry[] = [];
  let loaded = false;
  storeFactory = {
    memory,
    async load() {
      if (loaded) return;
      loaded = true;
      const payload = await store.load();
      memory.push(...payload.entries);
    },
    flush() {
      return store.save({ entries: memory });
    },
  };
  return storeFactory;
}

function computeFingerprint(certificate: Certificate): string {
  const der = Buffer.from(certificate.data, "utf8");
  const hash = createHash("sha256").update(der).digest("hex");
  const formatted = (hash.match(/.{2}/g) ?? []).join(":").toUpperCase();
  return `sha256/${formatted}`;
}

function parseTrustEntry(value: unknown): TrustEntry | null {
  if (!isRecord(value)) return null;
  const fingerprint = readStringProperty(value, "fingerprint");
  const hostname = readStringProperty(value, "hostname");
  const subject = readStringProperty(value, "subject");
  const issuer = readStringProperty(value, "issuer");
  const trustedAt = readNumberProperty(value, "trustedAt");
  if (
    fingerprint === null ||
    hostname === null ||
    subject === null ||
    issuer === null ||
    trustedAt === null
  ) {
    return null;
  }
  return {
    scope: readTrustScope(Reflect.get(value, "scope")),
    fingerprint,
    hostname,
    subject,
    issuer,
    trustedAt,
  };
}

function readTrustScope(value: unknown): CertificateTrustScope {
  return value === "browser" ? "browser" : "app-shell";
}

function readStringProperty(
  record: Record<string, unknown>,
  property: string,
): string | null {
  const value = Reflect.get(record, property);
  return typeof value === "string" ? value : null;
}

function readNumberProperty(
  record: Record<string, unknown>,
  property: string,
): number | null {
  const value = Reflect.get(record, property);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findTrustEntryIndex(
  entries: readonly TrustEntry[],
  scope: CertificateTrustScope,
  fingerprint: string,
  hostname: string,
): number {
  return entries.findIndex(
    (entry) =>
      entry.scope === scope &&
      entry.fingerprint === fingerprint &&
      entry.hostname === hostname,
  );
}

function hasTrustedCertificate(
  entries: readonly TrustEntry[],
  scope: CertificateTrustScope,
  fingerprint: string,
  hostname: string,
): boolean {
  return findTrustEntryIndex(entries, scope, fingerprint, hostname) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function trustCertificate(
  hostname: string,
  certificate: Certificate,
): Promise<TrustEntry> {
  return trustCertificateForScope("app-shell", hostname, certificate);
}

export async function trustBrowserCertificate(
  hostname: string,
  certificate: Certificate,
): Promise<TrustEntry> {
  return trustCertificateForScope("browser", hostname, certificate);
}

async function trustCertificateForScope(
  scope: CertificateTrustScope,
  hostname: string,
  certificate: Certificate,
): Promise<TrustEntry> {
  const store = getStore();
  await store.load();
  const fingerprint = computeFingerprint(certificate);
  const idx = findTrustEntryIndex(store.memory, scope, fingerprint, hostname);
  const entry: TrustEntry = {
    scope,
    fingerprint,
    hostname,
    subject: certificate.subject.commonName,
    issuer: certificate.issuer.commonName,
    trustedAt: Date.now(),
  };
  if (idx >= 0) {
    store.memory.splice(idx, 1, entry);
  } else {
    store.memory.push(entry);
  }
  await store.flush();
  log.info("[cert-trust] trust added", {
    scope,
    hostname,
    fingerprint,
    issuer: entry.issuer,
  });
  return entry;
}

export async function untrustCertificate(
  fingerprint: string,
  hostname: string,
): Promise<void> {
  const store = getStore();
  await store.load();
  const idx = findTrustEntryIndex(
    store.memory,
    "app-shell",
    fingerprint,
    hostname,
  );
  if (idx >= 0) {
    store.memory.splice(idx, 1);
    await store.flush();
    log.info("[cert-trust] trust removed", { hostname, fingerprint });
  }
}

export async function listTrustedCertificates(): Promise<
  ReadonlyArray<TrustEntry>
> {
  const store = getStore();
  await store.load();
  return store.memory.filter((entry) => entry.scope === "app-shell");
}

/**
 * Corporate-MITM proxies and self-signed cloud endpoints both produce
 * certificate errors Chromium rejects by default. Without this handler,
 * every HTTPS call through such a proxy fails. Trust decisions are
 * never granted silently - only an entry in the user-managed allowlist
 * (added through the renderer settings UI via `trustCertificate`) lets
 * a cert through.
 */
export function installCertificateErrorHandler(): void {
  app.on(
    "certificate-error",
    (event, webContents, url, error, certificate, callback) => {
      if (isBrowserViewWebContents(webContents)) {
        void (async () => {
          const store = getStore();
          await store.load();
          const fingerprint = computeFingerprint(certificate);
          let hostname: string;
          try {
            hostname = new URL(url).hostname;
          } catch {
            callback(false);
            return;
          }
          const trusted = hasTrustedCertificate(
            store.memory,
            "browser",
            fingerprint,
            hostname,
          );
          if (trusted) {
            event.preventDefault();
            callback(true);
            log.info("[cert-trust] browser allowed via allowlist", {
              scope: "browser",
              hostname,
              fingerprint,
              error,
            });
            return;
          }
          callback(false);
          handleBrowserViewCertificateError({
            webContentsId: webContents.id,
            url,
            hostname,
            error,
            fingerprint,
            certificate,
          });
        })();
        return;
      }
      void (async () => {
        const store = getStore();
        await store.load();
        const fingerprint = computeFingerprint(certificate);
        let hostname: string;
        try {
          hostname = new URL(url).hostname;
        } catch {
          callback(false);
          return;
        }
        const trusted = hasTrustedCertificate(
          store.memory,
          "app-shell",
          fingerprint,
          hostname,
        );
        if (trusted) {
          event.preventDefault();
          callback(true);
          log.info("[cert-trust] allowed via allowlist", {
            scope: "app-shell",
            hostname,
            fingerprint,
            error,
          });
          return;
        }
        log.warn("[cert-trust] rejected (no matching trust)", {
          hostname,
          fingerprint,
          error,
          subject: certificate.subject.commonName,
          issuer: certificate.issuer.commonName,
        });
        callback(false);
        enqueuePendingError({
          fingerprint,
          hostname,
          subject: certificate.subject.commonName,
          issuer: certificate.issuer.commonName,
          error,
          url,
        });
      })();
    },
  );
}

export interface PendingCertificateError {
  readonly id: string;
  readonly hostname: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly issuer: string;
  readonly error: string;
  readonly url: string;
  readonly observedAt: number;
}

// Coalesced by `${fingerprint}|${hostname}` so a thundering herd of
// failed requests against the same MITM cert spams neither the renderer
// nor this Map. Bounded to MAX_PENDING entries (FIFO eviction) so a
// misconfigured app can't grow the Map unbounded over time.
const MAX_PENDING = 64;
const pendingByCompositeKey = new Map<string, PendingCertificateError>();
let pendingEmitter: ((entry: PendingCertificateError) => void) | null = null;

function compositeKey(fingerprint: string, hostname: string): string {
  return `${fingerprint}|${hostname}`;
}

function enqueuePendingError(
  input: Omit<PendingCertificateError, "id" | "observedAt">,
): void {
  const key = compositeKey(input.fingerprint, input.hostname);
  if (pendingByCompositeKey.has(key)) return;
  const entry: PendingCertificateError = {
    id: randomUUID(),
    observedAt: Date.now(),
    ...input,
  };
  if (pendingByCompositeKey.size >= MAX_PENDING) {
    const oldestKey = pendingByCompositeKey.keys().next().value;
    if (oldestKey !== undefined) pendingByCompositeKey.delete(oldestKey);
  }
  pendingByCompositeKey.set(key, entry);
  if (pendingEmitter !== null) pendingEmitter(entry);
}

export function listPendingCertificateErrors(): ReadonlyArray<PendingCertificateError> {
  return [...pendingByCompositeKey.values()];
}

export function dismissPendingCertificateError(id: string): void {
  for (const [key, entry] of pendingByCompositeKey) {
    if (entry.id === id) {
      pendingByCompositeKey.delete(key);
      return;
    }
  }
}

export function setPendingCertificateEmitter(
  emitter: (entry: PendingCertificateError) => void,
): void {
  pendingEmitter = emitter;
}

export async function showSystemCertificateTrustDialog(
  window: BrowserWindow,
  certificate: Certificate,
  message: string,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await dialog.showCertificateTrustDialog(window, {
      certificate,
      message,
    });
    return true;
  } catch (err) {
    log.warn("[cert-trust] system dialog dismissed/failed", { err });
    return false;
  }
}
