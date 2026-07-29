import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import {
  listUserSessionsViaHttp,
  mintHostCredentialViaHttp,
  requestStepUpChallengeViaHttp,
  revokeAllSessionsViaHttp,
  revokeUserSessionViaHttp,
  toRetainedStepUpVerifyResult,
  verifyStepUpChallengeViaHttp,
} from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import { validateAuthTokenIdentityAccessOnly } from "@traycer-clients/shared/auth/auth-validation";
import { HostProvisionClaimRegistry } from "@traycer-clients/shared/host-transport/host-provision-claim-registry";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";
import {
  assertString,
  parseDesktopAuthSession,
  parseMintHostCredentialRequest,
  parseStoredAuthTokens,
  parseStoredCredentialsIdentity,
  parseTokenRotateExpected,
  readSenderWebContentsId,
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

/**
 * The identity the provisioning memo is scoped to. Only a fully signed-in
 * session names one: `signing-in` and `signed-out` both collapse to null, so a
 * sign-out clears the memo and a sign-in as the same user restores it.
 */
function signedInUserId(snapshot: DesktopAuthSessionSnapshot): string | null {
  return snapshot.status === "signed-in"
    ? (snapshot.profile?.userId ?? null)
    : null;
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
  /**
   * The retained step-up bearer if it is still usable, dropping an expired one
   * on the way out.
   *
   * The drop is the point. An expired token is already refused by the server, so
   * holding it grants nothing - but it is still a secret sitting in main-process
   * memory with no remaining reason to be there, kept alive until some later
   * `step-up-required`, `revokeAllSessions`, or session change happens to clear
   * it. `MockRunnerHost.activeRetainedStepUpToken` self-nulls for the same
   * reason; a closure rather than a free function is what lets this one do it
   * too, so the pair cannot drift.
   */
  const activeRetainedStepUpToken = (nowMs: number): string | null => {
    if (retainedStepUpCredential === null) {
      return null;
    }
    if (retainedStepUpCredential.expiresAtMs <= nowMs) {
      retainedStepUpCredential = null;
      return null;
    }
    return retainedStepUpCredential.accessToken;
  };
  const provisionClaims = new HostProvisionClaimRegistry(() => Date.now());
  // Identity the provisioning memo currently belongs to. Compared - rather
  // than resetting on every auth-session change - because the session snapshot
  // also carries the bearer, so an ordinary token refresh fires `change` too.
  // Clearing the memo there would let the next window to open re-ask about a
  // host this identity has already answered for.
  let provisionIdentity: string | null = signedInUserId(
    bridge.authSession.get(),
  );

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

  // Fan the owned-watcher change events out to every window (source lands in §4;
  // a live registration that never fires until then). Torn down on dispose,
  // which also disposes the underlying mutation store.
  const unsubscribeTokenStore = bridge.authTokenStore.subscribe((change) => {
    bridge.fanOut(RunnerHostEvent.authTokenStoreChange, change);
  });
  bridge.disposeFns.push(unsubscribeTokenStore);
  bridge.disposeFns.push(() => bridge.authTokenStore.dispose());

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
        ? activeRetainedStepUpToken(Date.now())
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
      const stepUpToken = activeRetainedStepUpToken(Date.now());
      const result = await revokeAllSessionsViaHttp(
        bridge.options.authnBaseUrl,
        stepUpToken ?? bearerToken,
      );
      retainedStepUpCredential = null;
      return result;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.mintHostCredential,
    async (
      _event,
      bearerToken: unknown,
      request: unknown,
      useStepUpCredential: unknown,
    ) => {
      assertString(bearerToken, "mintHostCredential.bearerToken");
      assertBoolean(
        useStepUpCredential,
        "mintHostCredential.useStepUpCredential",
      );
      const stepUpToken = useStepUpCredential
        ? activeRetainedStepUpToken(Date.now())
        : null;
      const result = await mintHostCredentialViaHttp(
        bridge.options.authnBaseUrl,
        stepUpToken ?? bearerToken,
        parseMintHostCredentialRequest(request),
      );
      // Same drop rule as `revokeUserSession`: if the server says step-up is
      // still required while we believed we held a fresh credential, the one we
      // held is stale - clear it so the retry actually re-challenges instead of
      // replaying a dead token.
      if (result.kind === "step-up-required" && useStepUpCredential) {
        retainedStepUpCredential = null;
      }
      return result;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.claimHostCredentialProvision,
    (event, hostId: unknown) => {
      assertString(hostId, "claimHostCredentialProvision.hostId");
      const holderId = readSenderWebContentsId(event);
      if (holderId === null) {
        // A sender with no identifiable webContents cannot be pruned when its
        // window closes, so granting it would risk a claim held until the TTL.
        // Denying costs at most one un-provisioned host; the connection lease
        // still works. `isTrustedIpcSender` already makes this unreachable in
        // practice - it resolves the sender against the window registry.
        return { kind: "denied" };
      }
      return provisionClaims.claim(hostId, holderId);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.releaseHostCredentialProvision,
    (_event, hostId: unknown, token: unknown) => {
      assertString(hostId, "releaseHostCredentialProvision.hostId");
      assertString(token, "releaseHostCredentialProvision.token");
      // Authorized by the token, not by the sender: the token was minted for
      // one claim and only the holder of that claim has it.
      provisionClaims.release(hostId, token);
    },
  );

  // A window closed mid-prompt never releases. Drop its claim so the next
  // window may ask - it is NOT settled, because nobody answered.
  const onWindowRegistryChange = (): void => {
    provisionClaims.retainHolders(
      new Set(
        bridge.windowRegistry.records().map((record) => record.webContentsId),
      ),
    );
  };
  bridge.windowRegistry.on("change", onWindowRegistryChange);
  bridge.disposeFns.push(() => {
    bridge.windowRegistry.off("change", onWindowRegistryChange);
  });

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
    const nextIdentity = signedInUserId(snapshot);
    if (nextIdentity !== provisionIdentity) {
      provisionIdentity = nextIdentity;
      provisionClaims.reset();
    }
    bridge.fanOut(RunnerHostEvent.authSessionChange, snapshot);
  };
  bridge.authSession.on("change", onAuthSessionChange);
  bridge.disposeFns.push(() => {
    bridge.authSession.off("change", onAuthSessionChange);
  });

  bridge.fanOut(RunnerHostEvent.authSessionChange, bridge.authSession.get());
}
