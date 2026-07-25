import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import type {
  CredentialsMigrationOutcome,
  StoredAuthTokens,
  StoredCredentials,
  StoredCredentialsIdentity,
  TokenRotateResult,
  TokenStoreChange,
} from "../ipc-contracts/auth-types";
import type { DesktopAuthSessionSnapshot } from "../ipc-contracts/window-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

/**
 * Eagerly subscribe at module load so a cold-start browser-return deep link
 * that arrives before `AuthService.start()` installs its subscription is
 * captured and replayed to the first subscriber. The signal is payload-free
 * (device flow is the only login - the token arrives over the poll, not here),
 * so we only track that it fired. Mirrors the `localHostChange` replay-safety
 * pattern in `host-bridge.ts`.
 */
let authReturnSignalled = false;
const authCallbackHandlers = new Set<Listener<void>>();

ipcRenderer.on(RunnerHostEvent.authCallback, (): void => {
  // No live subscriber yet (cold-start deep link): cache the signal as a
  // one-time replay for the next subscriber. With live subscribers, deliver
  // straight through and drop any stale cache so a later subscriber doesn't
  // replay an already-handled return.
  if (authCallbackHandlers.size === 0) {
    authReturnSignalled = true;
    return;
  }
  authReturnSignalled = false;
  for (const handler of authCallbackHandlers) {
    handler();
  }
});

function subscribeAuthCallback(handler: Listener<void>): Disposable {
  authCallbackHandlers.add(handler);
  if (authReturnSignalled) {
    // Consume the cached signal so it replays exactly once, to the first
    // subscriber, and never to later ones.
    authReturnSignalled = false;
    handler();
  }
  return {
    dispose: () => {
      authCallbackHandlers.delete(handler);
    },
  };
}

export interface AuthBridgeSurface {
  validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult>;
  beginAuthAttempt(): void;
  onAuthCallback(handler: Listener<void>): Disposable;
}

export function buildAuthBridge(): AuthBridgeSurface {
  return {
    validateAuthTokenIdentity: (token) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.validateAuthTokenIdentity,
        token,
      ) as Promise<AuthIdentityValidationResult>,

    // Desktop does not dedupe browser-return signals on URL identity, so the
    // attempt-boundary hook is a renderer-local no-op. It still exists to
    // satisfy the shared `IRunnerHost` contract.
    beginAuthAttempt: () => undefined,

    onAuthCallback: (handler) => subscribeAuthCallback(handler),
  };
}

/**
 * Renderer-side `ITokenStore` backed by the main-process `FileTokenStore`
 * (tech plan §3). `rotate` performs the refresh spend in main under the file
 * lock; `subscribe` receives the owned-watcher change events (source lands in
 * §4). The renderer wraps this exactly as its `ITokenStore` implementation.
 */
export interface AuthTokenStoreBridgeSurface {
  get(): Promise<StoredCredentials | null>;
  signIn(
    tokens: StoredAuthTokens,
    identity: StoredCredentialsIdentity,
  ): Promise<void>;
  rotate(expected: {
    readonly userId: string;
    readonly token: string;
  }): Promise<TokenRotateResult>;
  delete(): Promise<void>;
  subscribe(handler: Listener<TokenStoreChange>): Disposable;
  migrateLegacyCredentials(
    legacy: StoredAuthTokens,
  ): Promise<CredentialsMigrationOutcome>;
}

export function buildAuthTokenStoreBridge(): AuthTokenStoreBridgeSurface {
  return {
    get: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.authTokenStoreGet,
      ) as Promise<StoredCredentials | null>,
    signIn: (tokens, identity) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.authTokenStoreSignIn,
        tokens,
        identity,
      ) as Promise<void>,
    rotate: (expected) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.authTokenStoreRotate,
        expected,
      ) as Promise<TokenRotateResult>,
    delete: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.authTokenStoreDelete,
      ) as Promise<void>,
    subscribe: (handler) =>
      subscribe<TokenStoreChange>(
        RunnerHostEvent.authTokenStoreChange,
        handler,
      ),
    migrateLegacyCredentials: (legacy) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.authTokenStoreMigrateLegacy,
        legacy,
      ) as Promise<CredentialsMigrationOutcome>,
  };
}

export interface AuthSessionBridgeSurface {
  get(): Promise<DesktopAuthSessionSnapshot>;
  set(snapshot: DesktopAuthSessionSnapshot): Promise<void>;
  onChange(handler: Listener<DesktopAuthSessionSnapshot>): Disposable;
}

export function buildAuthSessionBridge(): AuthSessionBridgeSurface {
  return {
    get: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.authSessionGet,
      ) as Promise<DesktopAuthSessionSnapshot>,
    set: (snapshot) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.authSessionSet,
        snapshot,
      ) as Promise<void>,
    onChange: (handler) =>
      subscribe<DesktopAuthSessionSnapshot>(
        RunnerHostEvent.authSessionChange,
        handler,
      ),
  };
}
