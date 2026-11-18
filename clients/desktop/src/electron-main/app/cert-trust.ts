import { app, dialog, type BrowserWindow, type Certificate } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { log } from "./logger";
import { createJsonFileStore } from "./json-file-store";
import type { CertificateTrustScope } from "../../ipc-contracts/platform-types";

const STORE_FILE_NAME = "trusted-certificates.json";

const trustEntrySchema = z.object({
  scope: z.enum(["app-shell", "browser"]).catch("app-shell"),
  fingerprint: z.string(),
  hostname: z.string(),
  subject: z.string(),
  issuer: z.string(),
  trustedAt: z.number().finite(),
});

type TrustEntry = z.infer<typeof trustEntrySchema>;

const trustStorePayloadSchema = z.object({
  entries: z
    .array(z.unknown())
    .catch([])
    .transform((entries) =>
      entries.flatMap((entry): TrustEntry[] => {
        const parsed = trustEntrySchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
});

interface TrustStorePayload {
  readonly entries: TrustEntry[];
}

const FALLBACK_PAYLOAD: TrustStorePayload = { entries: [] };

function parsePayload(value: unknown): TrustStorePayload {
  const parsed = trustStorePayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : FALLBACK_PAYLOAD;
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
  scope: CertificateTrustScope,
  fingerprint: string,
  hostname: string,
): Promise<void> {
  const store = getStore();
  await store.load();
  const idx = findTrustEntryIndex(store.memory, scope, fingerprint, hostname);
  if (idx >= 0) {
    store.memory.splice(idx, 1);
    await store.flush();
    log.info("[cert-trust] trust removed", { scope, hostname, fingerprint });
  }
}

/** Every grant, both scopes - each entry carries the scope it applies to. */
export async function listTrustedCertificates(): Promise<
  ReadonlyArray<TrustEntry>
> {
  const store = getStore();
  await store.load();
  return [...store.memory];
}

/** One rejected certificate, as handed to whichever scope owns the surface. */
export interface CertificateErrorReport {
  readonly webContentsId: number;
  readonly url: string;
  readonly hostname: string;
  readonly fingerprint: string;
  readonly error: string;
  readonly certificate: Certificate;
}

/**
 * Registration seam for the browser feature, mirroring `pendingEmitter`
 * below: `certificate-error` is an app-level event this module owns, but a
 * native browser tile's untrusted cert belongs to the browser's own in-page
 * UX, not the settings allowlist. `browser-view/browser-session` registers
 * itself here at startup so this file never imports into browser-view.
 */
export interface BrowserCertificateErrorHandler {
  /** True when the webContents is a native browser tile (scope `browser`). */
  readonly owns: (webContentsId: number) => boolean;
  readonly report: (input: CertificateErrorReport) => void;
}

let browserCertificateErrorHandler: BrowserCertificateErrorHandler | null =
  null;

export function setBrowserCertificateErrorHandler(
  handler: BrowserCertificateErrorHandler,
): void {
  browserCertificateErrorHandler = handler;
}

function reportAppShellCertificateError(input: CertificateErrorReport): void {
  enqueuePendingError({
    fingerprint: input.fingerprint,
    hostname: input.hostname,
    subject: input.certificate.subject.commonName,
    issuer: input.certificate.issuer.commonName,
    error: input.error,
    url: input.url,
  });
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
        const browserHandler = browserCertificateErrorHandler;
        const isBrowser =
          browserHandler !== null && browserHandler.owns(webContents.id);
        const scope: CertificateTrustScope = isBrowser
          ? "browser"
          : "app-shell";
        if (hasTrustedCertificate(store.memory, scope, fingerprint, hostname)) {
          event.preventDefault();
          callback(true);
          log.info("[cert-trust] allowed via allowlist", {
            scope,
            hostname,
            fingerprint,
            error,
          });
          return;
        }
        callback(false);
        log.warn("[cert-trust] rejected (no matching trust)", {
          scope,
          hostname,
          fingerprint,
          error,
          subject: certificate.subject.commonName,
          issuer: certificate.issuer.commonName,
        });
        const report =
          browserHandler !== null && isBrowser
            ? browserHandler.report
            : reportAppShellCertificateError;
        report({
          webContentsId: webContents.id,
          url,
          hostname,
          fingerprint,
          error,
          certificate,
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
