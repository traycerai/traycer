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
import { validateAuthTokenIdentityAccessOnly } from "@traycer-clients/shared/auth/auth-validation";
import { fetchRegisteredHostsViaHttp } from "@traycer-clients/shared/host-client/remote-fetcher";
import { updateHostVersionPolicyViaHttp } from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";
import {
  assertString,
  parseDesktopAuthSession,
  parseStoredAuthTokens,
  parseStoredCredentialsIdentity,
  parseTokenRotateExpected,
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
 * Auth IPC handlers: token *validation* against the authn service, plus the
 * credentials-file token store (tech plan §3). Credential persistence now lives
 * in the main-process `FileTokenStore` (single machine-local file + lock/WAL),
 * reached through the `authTokenStore*` channels; the renderer's `ITokenStore`
 * is an IPC client of it. Validation stays access-only here — a token *spend*
 * happens only inside `tokenStore.rotate`, under the file lock.
 */
export function registerAuthIpc(bridge: RunnerIpcBridge): void {
  let retainedStepUpCredential: RetainedStepUpCredential | null = null;

  bridge.handleInvoke(
    RunnerHostInvoke.validateAuthTokenIdentity,
    async (_event, token: unknown) => {
      assertString(token, "validateAuthTokenIdentity");
      // Access-only (§3): no refresh-on-401. A stale token comes back `rejected`
      // and the renderer routes the spend through the locked `tokenStore.rotate`.
      return validateAuthTokenIdentityAccessOnly(
        bridge.options.authnBaseUrl,
        token,
      );
    },
  );

  // Credentials-file token store (tech plan §3). The renderer's `ITokenStore` is
  // an IPC client of the main `FileTokenStore`; `rotate` performs the refresh
  // spend in main, inside the file lock.
  bridge.handleInvoke(RunnerHostInvoke.authTokenStoreGet, () => {
    return bridge.authTokenStore.get();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.authTokenStoreSignIn,
    (_event, tokens: unknown, identity: unknown) => {
      return bridge.authTokenStore.signIn(
        parseStoredAuthTokens(tokens),
        parseStoredCredentialsIdentity(identity),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.authTokenStoreRotate,
    (_event, expected: unknown) => {
      return bridge.authTokenStore.rotate(parseTokenRotateExpected(expected));
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.authTokenStoreDelete, () => {
    return bridge.authTokenStore.delete();
  });
  // §6 one-time legacy→file migration. The renderer decrypts its legacy
  // localStorage token pair and hands it over; main single-flights the reconcile
  // across windows. Same fail-closed `{ token, refreshToken }` parse as signIn.
  bridge.handleInvoke(
    RunnerHostInvoke.authTokenStoreMigrateLegacy,
    (_event, legacy: unknown) => {
      return bridge.authTokenStore.migrateLegacyCredentials(
        parseStoredAuthTokens(legacy),
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

  // Fan the owned-watcher change events out to every window (source lands in §4;
  // a live registration that never fires until then). Torn down on dispose,
  // which also disposes the underlying mutation store.
  const unsubscribeTokenStore = bridge.authTokenStore.subscribe((change) => {
    bridge.fanOut(RunnerHostEvent.authTokenStoreChange, change);
  });
  bridge.disposeFns.push(unsubscribeTokenStore);
  bridge.disposeFns.push(() => bridge.authTokenStore.dispose());

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
