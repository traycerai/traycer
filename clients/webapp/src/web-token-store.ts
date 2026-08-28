import { credentialsIdentityFromAuthenticatedUser } from "@traycer-clients/shared/auth/auth-validation";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import type {
  AuthTokenRefreshResult,
  CredentialsMigrationOutcome,
  ITokenStore,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateResult,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

/**
 * Storage slot for the browser shell's credential.
 *
 * Namespaced away from every other writer that shares this origin: the web
 * dashboard's own `auth-storage`, the renderer's retired per-window
 * `traycer.token` / `traycer.refresh-token` slots (which `AuthService` WIPES
 * at startup after its migration pre-step), and the phone shell's
 * `traycer.credentials`. A collision here does not read as a bug in this
 * store - it reads as the user being signed out by something else.
 */
export const WEB_TOKEN_STORE_KEY = "traycer.webapp.credentials";

/**
 * The one lock every mutation of {@link WEB_TOKEN_STORE_KEY} runs inside.
 * Web Locks are scoped to the origin, which is exactly the scope of the
 * storage it guards.
 */
export const WEB_TOKEN_STORE_LOCK = "traycer.webapp.credentials.lock";

/**
 * The origin-wide key/value slot the credential lives in, plus the edge that
 * says another context of this origin just wrote it.
 *
 * A seam rather than a direct `window.localStorage` reach, because the
 * cross-tab behaviour this store exists to provide is only testable with two
 * stores over one shared backing - which is what a browser actually is, and
 * what a per-test fake can reproduce faithfully.
 */
export interface WebCredentialStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  /**
   * Registers a handler for writes to `key` made by ANOTHER context of this
   * origin. Deliberately not disposable: the listener lives as long as the
   * document, the same lifetime as the store that installs it, so a disposal
   * path here would exist only to be never called.
   */
  onExternalChange(key: string, handler: () => void): void;
}

/**
 * Mutual exclusion across every tab of the origin.
 *
 * A seam for the same reason as the storage above: the lock is the mechanism
 * under test, so a test has to be able to run two stores against one real
 * lock - and, to prove the test is not vacuous, against a lock that does not
 * exclude.
 */
export interface WebLockManager {
  runExclusive<T>(name: string, task: () => Promise<T>): Promise<T>;
}

export interface WebCredentialRefreshRequest {
  readonly authnBaseUrl: string;
  readonly token: string;
  readonly refreshToken: string;
  readonly clientKind: "cli" | "desktop" | null;
  readonly signal: AbortSignal | null;
}

/** The single-attempt refresh the store spends inside its lock. */
export type WebCredentialRefresh = (
  request: WebCredentialRefreshRequest,
) => Promise<AuthTokenRefreshResult>;

export interface WebIdentityProbeRequest {
  readonly authnBaseUrl: string;
  readonly token: string;
  readonly signal: AbortSignal | null;
}

/** The access-only identity probe the legacy migration reads identity from. */
export type WebIdentityProbe = (
  request: WebIdentityProbeRequest,
) => Promise<AuthIdentityValidationResult>;

export interface WebTokenStoreOptions {
  readonly storage: WebCredentialStorage;
  readonly locks: WebLockManager;
  readonly authnBaseUrl: string;
  readonly refresh: WebCredentialRefresh;
  readonly probeIdentity: WebIdentityProbe;
}

/**
 * `ITokenStore` for a browser tab, and the shell's cross-tab credential
 * authority.
 *
 * Every other shell has exactly one writer of the credential. The desktop's
 * single main process owns a file lock and the renderers are IPC clients of
 * it; a phone runs one WebView, so its store's sequential guards ARE the whole
 * protocol. Neither holds in a browser: N tabs of one origin share one
 * `localStorage`, each runs its own copy of this class, and their access
 * tokens expire together - so two tabs will reach for the SAME single-use
 * refresh token at the same moment. Authn honours the first spend and rejects
 * the second, which signs that tab out with a valid session still in storage.
 *
 * Three mechanisms, each load-bearing and none sufficient alone:
 *
 * 1. MUTUAL EXCLUSION. Every mutation runs inside {@link WEB_TOKEN_STORE_LOCK},
 *    so at most one tab in the browser is inside `signIn` / `rotate` /
 *    `delete` / `deleteIfToken` at a time.
 * 2. COMPARE-AND-MUTATE. The lock ORDERS writers; it does not tell the second
 *    one that it is second. So `rotate` re-reads storage INSIDE the lock and
 *    compares what it finds against the pair the caller based its request on.
 *    A caller holding a superseded pair is refused before any refresh is
 *    spent, and is handed the winner's pair to adopt instead. Reading before
 *    the lock (as a single-runtime store may) would compare against a value
 *    that the lock wait itself invalidated.
 * 3. ADOPTION. `storage` fires in every OTHER tab of the origin when one tab
 *    writes, and that edge is what makes a sibling notice a sign-in, a
 *    rotation or a sign-out it did not perform. Without it the loser of a
 *    race is correct about not spending and still stuck holding a dead token.
 */
export class WebTokenStore implements ITokenStore {
  private readonly listeners = new Set<(change: TokenStoreChange) => void>();
  private revision = 0;

  constructor(private readonly options: WebTokenStoreOptions) {
    // A sibling's committed write is the only mutation this tab learns about
    // without having performed it, so the adoption edge is armed for the
    // store's whole life rather than per subscriber.
    options.storage.onExternalChange(WEB_TOKEN_STORE_KEY, () => {
      this.emitChange();
    });
  }

  async get(): Promise<StoredCredentials | null> {
    return this.readStored();
  }

  async signIn(
    tokens: StoredAuthTokens,
    identity: StoredCredentialsIdentity,
  ): Promise<void> {
    // Locked like every other mutation: an interactive sign-in that landed
    // between a sibling's compare and its commit would otherwise be
    // overwritten by that sibling's rotation of the pair it just replaced.
    await this.options.locks.runExclusive(WEB_TOKEN_STORE_LOCK, async () => {
      this.writeStored({
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        savedAt: new Date().toISOString(),
        user: identity,
      });
    });
    this.notifyAfterMutation();
  }

  async rotate(expected: {
    readonly userId: string;
    readonly token: string;
  }): Promise<TokenRotateResult> {
    return this.options.locks.runExclusive(WEB_TOKEN_STORE_LOCK, async () => {
      // Inside the lock, and only inside it: this read is the compare half of
      // compare-and-mutate. Between the caller deciding to rotate and this
      // line, a sibling may have rotated, signed out, or signed a different
      // user in - each of which this read now sees.
      const stored = this.readStored();
      if (stored === null) {
        return { outcome: "deleted", pair: null };
      }
      if (stored.user.id !== expected.userId) {
        return { outcome: "user-mismatch", pair: stored };
      }
      if (stored.token !== expected.token) {
        // The stale writer loses here, BEFORE the spend. `pair` is the
        // winner's committed pair, which the caller adopts instead of
        // burning a refresh token that authn has already consumed.
        return { outcome: "superseded", pair: stored };
      }
      const refreshed = await this.options.refresh({
        authnBaseUrl: this.options.authnBaseUrl,
        token: stored.token,
        refreshToken: stored.refreshToken,
        clientKind: null,
        signal: null,
      });
      if (refreshed.kind === "network-error") {
        return { outcome: "refresh-network", pair: null };
      }
      if (refreshed.kind === "rejected") {
        return { outcome: "refresh-rejected", pair: null };
      }
      const next: StoredCredentials = {
        ...stored,
        token: refreshed.token,
        refreshToken: refreshed.refreshToken,
        savedAt: new Date().toISOString(),
      };
      this.writeStored(next);
      this.notifyAfterMutation();
      return { outcome: "applied", pair: next };
    });
  }

  async delete(): Promise<void> {
    await this.options.locks.runExclusive(WEB_TOKEN_STORE_LOCK, async () => {
      this.options.storage.remove(WEB_TOKEN_STORE_KEY);
    });
    this.notifyAfterMutation();
  }

  async deleteIfToken(expectedToken: string): Promise<"deleted" | "kept"> {
    return this.options.locks.runExclusive(WEB_TOKEN_STORE_LOCK, async () => {
      // The interface requires the comparison and the delete to be atomic at
      // the store's own authority; here that authority is the lock, so both
      // happen inside one hold rather than being composed by the caller.
      const stored = this.readStored();
      if (stored === null || stored.token !== expectedToken) {
        return "kept";
      }
      this.options.storage.remove(WEB_TOKEN_STORE_KEY);
      this.notifyAfterMutation();
      return "deleted";
    });
  }

  subscribe(listener: (change: TokenStoreChange) => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  async migrateLegacyCredentials(
    legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome> {
    // The whole reconcile is one lock hold. Its two network calls are each
    // deadline-bounded by the shared helpers, and an unlocked migration is
    // precisely the double-spend this store exists to prevent: every tab runs
    // this at startup against the same legacy pair.
    return this.options.locks.runExclusive(WEB_TOKEN_STORE_LOCK, async () => {
      const existing = this.readStored();
      if (existing !== null) {
        return "file-wins";
      }
      const probe = await this.options.probeIdentity({
        authnBaseUrl: this.options.authnBaseUrl,
        token: legacy.token,
        signal: null,
      });
      if (probe.kind === "network-error") return "retryable";
      if (probe.kind !== "valid") return "identity-unknown";
      const refreshed = await this.options.refresh({
        authnBaseUrl: this.options.authnBaseUrl,
        token: legacy.token,
        refreshToken: legacy.refreshToken,
        clientKind: null,
        signal: null,
      });
      if (refreshed.kind === "network-error") return "retryable";
      if (refreshed.kind === "rejected") return "terminal-dead";
      this.writeStored({
        token: refreshed.token,
        refreshToken: refreshed.refreshToken,
        savedAt: new Date().toISOString(),
        user: credentialsIdentityFromAuthenticatedUser(probe.user),
      });
      this.notifyAfterMutation();
      return "committed";
    });
  }

  private readStored(): StoredCredentials | null {
    return parseStoredCredentials(
      this.options.storage.read(WEB_TOKEN_STORE_KEY),
    );
  }

  private writeStored(credentials: StoredCredentials): void {
    this.options.storage.write(
      WEB_TOKEN_STORE_KEY,
      JSON.stringify(credentials),
    );
  }

  // Self-writes notify on a microtask so the caller's apply path finishes
  // before the change event lands, matching the watcher-after-write ordering
  // the shared AuthService expects. A sibling's write arrives already
  // asynchronous and emits directly.
  private notifyAfterMutation(): void {
    queueMicrotask(() => {
      this.emitChange();
    });
  }

  private emitChange(): void {
    const stored = this.readStored();
    this.revision += 1;
    const change: TokenStoreChange = {
      present: stored !== null,
      userId: stored?.user.id ?? null,
      revision: this.revision,
    };
    for (const listener of Array.from(this.listeners)) {
      listener(change);
    }
  }
}

/**
 * Total decoder for the stored JSON; `null` on any structural mismatch, which
 * reads downstream as "signed out" and routes the user back through sign-in.
 * Hand-rolled rather than reusing the protocol's decoder of the same shape:
 * that one ships beside the `node:fs` credentials-file writers and cannot be
 * pulled into a browser bundle.
 */
export function parseStoredCredentials(
  raw: string | null,
): StoredCredentials | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record: Record<string, unknown> = parsed as Record<string, unknown>;
  const user = record.user;
  if (user === null || user === undefined || typeof user !== "object") {
    return null;
  }
  const userRecord: Record<string, unknown> = user as Record<string, unknown>;
  if (
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    typeof record.refreshToken !== "string" ||
    typeof record.savedAt !== "string" ||
    typeof userRecord.id !== "string" ||
    typeof userRecord.email !== "string" ||
    typeof userRecord.name !== "string"
  ) {
    return null;
  }
  return {
    token: record.token,
    refreshToken: record.refreshToken,
    savedAt: record.savedAt,
    user: {
      id: userRecord.id,
      email: userRecord.email,
      name: userRecord.name,
    },
  };
}

/**
 * `localStorage` backing, chosen over `sessionStorage` and over an in-memory
 * credential so a browser holds ONE Traycer session that survives a restart -
 * desktop and mobile parity, and a sessions page that lists one row per
 * browser rather than one per tab. The residual it accepts is an
 * XSS-persistent credential on an origin that also serves marketing pages;
 * that is bounded elsewhere (consent-gated third-party JS, the app bundle's
 * vendor fences, a path-scoped CSP, short access-token life plus family
 * revocation) and is not something this module can bound by itself.
 */
export function createLocalStorageCredentialStorage(): WebCredentialStorage {
  return {
    read: (key) => window.localStorage.getItem(key),
    write: (key, value) => {
      window.localStorage.setItem(key, value);
    },
    remove: (key) => {
      window.localStorage.removeItem(key);
    },
    onExternalChange: (key, handler) => {
      window.addEventListener("storage", (event: StorageEvent) => {
        // `storage` fires only in the OTHER documents of the origin, so an
        // event here is always a sibling's write. A `null` key is the whole
        // store being cleared, which is also a change to this slot.
        if (event.storageArea !== window.localStorage) return;
        if (event.key !== null && event.key !== key) return;
        handler();
      });
    },
  };
}

/**
 * Web Locks backing. The name is origin-scoped, matching the scope of the
 * storage it guards, and the lock is released when the holding tab's callback
 * settles - including when that tab is closed mid-hold, which is the failure
 * a hand-rolled `localStorage` mutex cannot recover from.
 */
export function createWebLockManager(): WebLockManager {
  return {
    runExclusive: (name, task) => navigator.locks.request(name, () => task()),
  };
}
