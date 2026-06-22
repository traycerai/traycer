import { app, dialog, type BrowserWindow, type Certificate } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { log } from "./logger";
import { createJsonFileStore } from "./json-file-store";

const STORE_FILE_NAME = "trusted-certificates.json";

interface TrustEntry {
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
  if (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as TrustStorePayload).entries)
  ) {
    return value as TrustStorePayload;
  }
  return FALLBACK_PAYLOAD;
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

export async function trustCertificate(
  hostname: string,
  certificate: Certificate,
): Promise<TrustEntry> {
  const store = getStore();
  await store.load();
  const fingerprint = computeFingerprint(certificate);
  const idx = store.memory.findIndex(
    (entry) => entry.fingerprint === fingerprint && entry.hostname === hostname,
  );
  const entry: TrustEntry = {
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
  const idx = store.memory.findIndex(
    (entry) => entry.fingerprint === fingerprint && entry.hostname === hostname,
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
  return [...store.memory];
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
    (event, _webContents, url, error, certificate, callback) => {
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
        const trusted = store.memory.some(
          (entry) =>
            entry.fingerprint === fingerprint && entry.hostname === hostname,
        );
        if (trusted) {
          event.preventDefault();
          callback(true);
          log.info("[cert-trust] allowed via allowlist", {
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
