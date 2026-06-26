import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  AuthTokenValidationResult,
  StoredAuthTokens,
} from "@traycer-clients/shared/platform/runner-host";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import type { AuthTokenRefreshResult } from "../ipc-contracts/auth-types";
import type { DesktopAuthSessionSnapshot } from "../ipc-contracts/window-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export type AuthCallbackBridgeResult =
  | { readonly code: string }
  | { readonly error: string };

/**
 * Eagerly subscribe at module load so a cold-start deep link that arrives
 * before `AuthService.start()` installs its subscription is captured and
 * replayed synchronously to the first subscriber. Mirrors the
 * `localHostChange` replay-safety pattern in `host-bridge.ts`.
 */
let cachedAuthCallback: AuthCallbackBridgeResult | null = null;
const authCallbackHandlers = new Set<Listener<AuthCallbackBridgeResult>>();

ipcRenderer.on(
  RunnerHostEvent.authCallback,
  (_event: unknown, payload: unknown): void => {
    const result = payload as AuthCallbackBridgeResult;
    cachedAuthCallback = result;
    for (const handler of authCallbackHandlers) {
      handler(result);
    }
  },
);

function subscribeAuthCallback(
  handler: Listener<AuthCallbackBridgeResult>,
): Disposable {
  authCallbackHandlers.add(handler);
  if (cachedAuthCallback !== null) {
    handler(cachedAuthCallback);
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
  exchangeAuthCode(
    code: string,
    codeVerifier: string,
  ): Promise<StoredAuthTokens | null>;
  beginAuthAttempt(): void;
  onAuthCallback(handler: Listener<AuthCallbackBridgeResult>): Disposable;
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

    exchangeAuthCode: (code, codeVerifier) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.exchangeAuthCode,
        code,
        codeVerifier,
      ) as Promise<StoredAuthTokens | null>,

    // Desktop does not dedupe deep-link auth callbacks on URL identity, so the
    // attempt-boundary signal is a renderer-local no-op. The hook still exists
    // to satisfy the shared `IRunnerHost` contract.
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
