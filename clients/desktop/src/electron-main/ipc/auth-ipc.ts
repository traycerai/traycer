import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import {
  listUserSessionsViaHttp,
  requestStepUpChallengeViaHttp,
  revokeAllSessionsViaHttp,
  revokeUserSessionViaHttp,
  toRetainedStepUpVerifyResult,
  verifyStepUpChallengeViaHttp,
} from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import {
  refreshAuthTokenViaHttp,
  validateAuthTokenIdentityViaHttp,
  validateAuthTokenViaHttp,
} from "@traycer-clients/shared/auth/auth-validation";
import { fetchRegisteredHostsViaHttp } from "@traycer-clients/shared/host-client/remote-fetcher";
import { updateHostVersionPolicyViaHttp } from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";
import {
  assertString,
  parseDesktopAuthSession,
  parseUpdateHostVersionPolicyInput,
} from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

const STEP_UP_EXPIRY_SKEW_MS = 5_000;

interface RetainedStepUpCredential {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

function assertBoolean(
  value: unknown,
  context: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${context} requires a boolean argument`);
  }
}

function activeRetainedStepUpToken(
  credential: RetainedStepUpCredential | null,
  nowMs: number,
): string | null {
  if (credential === null) {
    return null;
  }
  return credential.expiresAtMs > nowMs ? credential.accessToken : null;
}

/**
 * Auth IPC handlers for token *validation* against the authn service - credential
 * persistence is now fully renderer-side (`encrypt-storage` on top of
 * `localStorage`), so this surface no longer plumbs `tokenStore` /
 * `secureStorage` through Electron main. Removing those handlers also
 * removes the OS-keychain dependency that triggered the scary
 * "enter login password" prompt on every unsigned local install.
 */
export function registerAuthIpc(bridge: RunnerIpcBridge): void {
  let retainedStepUpCredential: RetainedStepUpCredential | null = null;

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
    RunnerHostInvoke.listRegisteredHosts,
    async (_event, bearerToken: unknown) => {
      assertString(bearerToken, "listRegisteredHosts.bearerToken");
      // Run in main so renderer-origin CORS does not block authn-v3's
      // `GET /api/v3/hosts` (Remote Host Support §7).
      return fetchRegisteredHostsViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.listUserSessions,
    async (_event, bearerToken: unknown) => {
      assertString(bearerToken, "listUserSessions.bearerToken");
      return listUserSessionsViaHttp(bridge.options.authnBaseUrl, bearerToken);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.revokeUserSession,
    async (
      _event,
      bearerToken: unknown,
      familyId: unknown,
      useStepUpCredential: unknown,
    ) => {
      assertString(bearerToken, "revokeUserSession.bearerToken");
      assertString(familyId, "revokeUserSession.familyId");
      assertBoolean(
        useStepUpCredential,
        "revokeUserSession.useStepUpCredential",
      );
      const stepUpToken = useStepUpCredential
        ? activeRetainedStepUpToken(retainedStepUpCredential, Date.now())
        : null;
      const result = await revokeUserSessionViaHttp(
        bridge.options.authnBaseUrl,
        stepUpToken ?? bearerToken,
        familyId,
      );
      if (result.kind === "step-up-required" && useStepUpCredential) {
        retainedStepUpCredential = null;
      }
      return result;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.revokeAllSessions,
    async (_event, bearerToken: unknown) => {
      assertString(bearerToken, "revokeAllSessions.bearerToken");
      const stepUpToken = activeRetainedStepUpToken(
        retainedStepUpCredential,
        Date.now(),
      );
      const result = await revokeAllSessionsViaHttp(
        bridge.options.authnBaseUrl,
        stepUpToken ?? bearerToken,
      );
      retainedStepUpCredential = null;
      return result;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.requestStepUpChallenge,
    async (_event, bearerToken: unknown) => {
      assertString(bearerToken, "requestStepUpChallenge.bearerToken");
      return requestStepUpChallengeViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.verifyStepUpChallenge,
    async (_event, bearerToken: unknown, code: unknown) => {
      assertString(bearerToken, "verifyStepUpChallenge.bearerToken");
      assertString(code, "verifyStepUpChallenge.code");
      const result = await verifyStepUpChallengeViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
        code,
      );
      if (result.kind === "ok") {
        retainedStepUpCredential = {
          accessToken: result.response.access_token,
          expiresAtMs:
            Date.now() +
            Math.max(
              0,
              result.response.expires_in * 1_000 - STEP_UP_EXPIRY_SKEW_MS,
            ),
        };
      }
      return toRetainedStepUpVerifyResult(result);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.updateHostVersionPolicy,
    async (_event, bearerToken: unknown, hostId: unknown, input: unknown) => {
      assertString(bearerToken, "updateHostVersionPolicy.bearerToken");
      assertString(hostId, "updateHostVersionPolicy.hostId");
      // Run in main so renderer-origin CORS does not block authn-v3's
      // `PATCH /api/v3/hosts/:hostId` (Remote Host Support §13, T16).
      return updateHostVersionPolicyViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
        hostId,
        parseUpdateHostVersionPolicyInput(input),
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
    retainedStepUpCredential = null;
    bridge.fanOut(RunnerHostEvent.authSessionChange, snapshot);
  };
  bridge.authSession.on("change", onAuthSessionChange);
  bridge.disposeFns.push(() => {
    bridge.authSession.off("change", onAuthSessionChange);
  });

  bridge.fanOut(RunnerHostEvent.authSessionChange, bridge.authSession.get());
}
