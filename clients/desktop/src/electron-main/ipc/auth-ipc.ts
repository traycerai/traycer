import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import {
  exchangeCodeForTokens,
  refreshAuthTokenViaHttp,
  validateAuthTokenIdentityViaHttp,
  validateAuthTokenViaHttp,
} from "@traycer-clients/shared/auth/auth-validation";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";
import { assertString, parseDesktopAuthSession } from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import { log } from "../app/logger";

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

  bridge.handleInvoke(
    RunnerHostInvoke.exchangeAuthCode,
    async (_event, code: unknown, codeVerifier: unknown) => {
      assertString(code, "exchangeAuthCode");
      assertString(codeVerifier, "exchangeAuthCode.codeVerifier");
      // Run in main so renderer-origin CORS does not decide the exchange.
      const result = await exchangeCodeForTokens(
        bridge.options.authnBaseUrl,
        code,
        codeVerifier,
      );
      if (result.kind !== "exchanged") {
        // `rejected` = authn returned 400/401/403/404 (bad/expired/reused code
        // or PKCE verifier↔challenge mismatch); `network-error` = the request
        // never got a usable response (proxy/TLS/DNS, or a non-2xx status).
        // Logged without code/verifier/token values so the cause is diagnosable
        // from the app log without leaking secrets.
        log.warn("[auth] code exchange failed", { reason: result.kind });
        return null;
      }
      return { token: result.token, refreshToken: result.refreshToken };
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
