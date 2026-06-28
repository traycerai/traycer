import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import {
  refreshAuthTokenViaHttp,
  validateAuthTokenIdentityViaHttp,
  validateAuthTokenViaHttp,
} from "@traycer-clients/shared/auth/auth-validation";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";
import { assertString, parseDesktopAuthSession } from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

/**
 * Auth IPC handlers for token *validation* against the authn service - credential
 * persistence is now fully renderer-side (`encrypt-storage` on top of
 * `localStorage`), so this surface no longer plumbs `tokenStore` /
 * `secureStorage` through Electron main. Removing those handlers also
 * removes the OS-keychain dependency that triggered the scary
 * "enter login password" prompt on every unsigned local install.
 */
export function registerAuthIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(
    RunnerHostInvoke.validateAuthToken,
    async (_event, token: unknown, refreshToken: unknown) => {
      assertString(token, "validateAuthToken");
      assertString(refreshToken, "validateAuthToken.refreshToken");
      return validateAuthTokenViaHttp(
        bridge.options.authnBaseUrl,
        token,
        refreshToken,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.validateAuthTokenIdentity,
    async (_event, token: unknown, refreshToken: unknown) => {
      assertString(token, "validateAuthTokenIdentity");
      assertString(refreshToken, "validateAuthTokenIdentity.refreshToken");
      return validateAuthTokenIdentityViaHttp(
        bridge.options.authnBaseUrl,
        token,
        refreshToken,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.refreshAuthToken,
    async (_event, token: unknown, refreshToken: unknown) => {
      assertString(token, "refreshAuthToken");
      assertString(refreshToken, "refreshAuthToken.refreshToken");
      // Run in main so renderer-origin CORS does not block the authn refresh.
      return refreshAuthTokenViaHttp(
        bridge.options.authnBaseUrl,
        token,
        refreshToken,
      );
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.authSessionGet, () => {
    return bridge.authSession.get();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.authSessionSet,
    (_event, snapshot: unknown) => {
      bridge.authSession.set(parseDesktopAuthSession(snapshot));
    },
  );

  const onAuthSessionChange = (snapshot: DesktopAuthSessionSnapshot): void => {
    bridge.fanOut(RunnerHostEvent.authSessionChange, snapshot);
  };
  bridge.authSession.on("change", onAuthSessionChange);
  bridge.disposeFns.push(() => {
    bridge.authSession.off("change", onAuthSessionChange);
  });

  bridge.fanOut(RunnerHostEvent.authSessionChange, bridge.authSession.get());
}
