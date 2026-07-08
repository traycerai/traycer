import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type { AuthTokenValidationResult } from "@traycer-clients/shared/platform/runner-host";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import type { AuthTokenRefreshResult } from "../ipc-contracts/auth-types";
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
  validateAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenValidationResult>;
  validateAuthTokenIdentity(
    token: string,
    refreshToken: string,
  ): Promise<AuthIdentityValidationResult>;
  refreshAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenRefreshResult>;
  beginAuthAttempt(): void;
  onAuthCallback(handler: Listener<void>): Disposable;
}

export function buildAuthBridge(): AuthBridgeSurface {
  return {
    validateAuthToken: (token, refreshToken) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.validateAuthToken,
        token,
        refreshToken,
      ) as Promise<AuthTokenValidationResult>,

    validateAuthTokenIdentity: (token, refreshToken) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.validateAuthTokenIdentity,
        token,
        refreshToken,
      ) as Promise<AuthIdentityValidationResult>,

    refreshAuthToken: (token, refreshToken) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.refreshAuthToken,
        token,
        refreshToken,
      ) as Promise<AuthTokenRefreshResult>,

    // Desktop does not dedupe browser-return signals on URL identity, so the
    // attempt-boundary hook is a renderer-local no-op. It still exists to
    // satisfy the shared `IRunnerHost` contract.
    beginAuthAttempt: () => undefined,

    onAuthCallback: (handler) => subscribeAuthCallback(handler),
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
