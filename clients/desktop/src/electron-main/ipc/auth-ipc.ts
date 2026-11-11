import { sandboxCatalogueReadinessRequestSchema } from "@traycer/protocol/host/sandbox-control";
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
import { fetchRegisteredHostsViaHttp } from "@traycer-clients/shared/host-client/remote-fetcher";
import { updateHostVersionPolicyViaHttp } from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import { deregisterHostViaHttp } from "@traycer-clients/shared/host-client/host-deregister-fetcher";
import {
  createSandboxViaHttp,
  destroySandboxViaHttp,
  fetchSandboxCatalogueViaHttp,
  fetchSandboxCostsViaHttp,
  fetchTraycerModelsViaHttp,
  getSandboxAutomationViaHttp,
  keepSandboxViaHttp,
  listSandboxesViaHttp,
  openSandboxAutomationViaHttp,
  patchSandboxViaHttp,
  runSandboxVerbViaHttp,
} from "@traycer-clients/shared/host-client/sandbox-control";
import {
  voiceSessionsAvailabilityViaHttp,
  voiceSessionsEndViaHttp,
  voiceSessionsMintViaHttp,
  type VoiceSessionIndicator,
  type VoiceSessionMintRequest,
} from "@traycer-clients/shared/host-client/voice-sessions";
import { voiceLiveWindows } from "../windows/voice-live-windows";
import {
  decideSecretRequestViaHttp,
  fetchEnvironmentProvidersViaHttp,
  fetchSandboxGrantsViaHttp,
  fetchTeamEnvironmentViaHttp,
} from "@traycer-clients/shared/host-client/sandbox-secrets";
import {
  disconnectSlackAppViaHttp,
  fetchSlackAppManifestViaHttp,
  mintSlackAppInstallUrlViaHttp,
  readSlackAppViaHttp,
  registerSlackAppViaHttp,
  setSlackAppDmsViaHttp,
} from "@traycer-clients/shared/host-client/slack-app";
import { mintTeamHostInstallTokenViaHttp } from "@traycer-clients/shared/host-client/team-host";
import { mintExecutableWriteGrantViaHttp } from "@traycer-clients/shared/host-client/executable-write-grant";
import { config } from "../../config";
import type {
  DesktopAuthSessionPendingReason,
  DesktopAuthSessionPendingRefused,
  DesktopAuthSessionRefusalReason,
  DesktopAuthSessionSetResult,
  DesktopAuthSessionSnapshot,
  DesktopAuthVerificationRevoked,
} from "../../ipc-contracts/window-types";
import {
  createDesktopBearerVerifier,
  JWKS_REFETCH_COOLDOWN_MS,
} from "../auth/bearer-verifier";
import type { DesktopAuthSessionChangeKind } from "../auth/desktop-auth-session";
import {
  createCachedIapTokenProvider,
  resolveIapKeyFilePath,
} from "../auth/iap-proxy-token";
import { log } from "../app/logger";
import {
  assertNumber,
  assertNullableString,
  assertString,
  parseDesktopAuthSession,
  parseMintHostCredentialRequest,
  parseRequiredId,
  parseSandboxAutomationEnvironmentId,
  parseSandboxAutomationOpenTarget,
  parseSandboxCreateRequest,
  parseSandboxLifecycleVerb,
  parseSandboxVerbGesture,
  parseSandboxPatchRequest,
  parseSecretRequestDecision,
  parseSlackAppBotId,
  parseSlackAppDmsRequest,
  parseSlackAppRegisterRequest,
  parseStoredAuthTokens,
  parseStoredCredentialsIdentity,
  parseTokenRotateExpected,
  parseUpdateHostVersionPolicyInput,
  readSenderWebContentsId,
} from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import { registerLocalAuthSessionRestore } from "./local-auth-session";

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

/** The renderer's mint request, checked field by field before it is sent. */
function voiceSessionMintRequestOf(value: unknown): VoiceSessionMintRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("mintVoiceSession.request requires an object argument");
  }
  const offerSdp: unknown = Reflect.get(value, "offerSdp");
  const input: unknown = Reflect.get(value, "input");
  assertString(offerSdp, "mintVoiceSession.request.offerSdp");
  assertString(input, "mintVoiceSession.request.input");
  return { offerSdp, input };
}

/** The renderer's voice indicator, checked field by field. */
function voiceSessionIndicatorOf(value: unknown): VoiceSessionIndicator {
  if (typeof value !== "object" || value === null) {
    throw new Error("setVoiceSessionIndicator requires an object argument");
  }
  const muted: unknown = Reflect.get(value, "muted");
  const pausedForDictation: unknown = Reflect.get(value, "pausedForDictation");
  assertBoolean(muted, "setVoiceSessionIndicator.muted");
  assertBoolean(
    pausedForDictation,
    "setVoiceSessionIndicator.pausedForDictation",
  );
  return { muted, pausedForDictation };
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
/**
 * The sandbox control plane, the team environment, the secret decisions and
 * the executable-write grant: the IPC the gui-app's sandbox, environment and
 * bot surfaces call.
 */
function registerSandboxControlPlaneIpc(bridge: RunnerIpcBridge): void {
  // The sandbox control plane. traycer-server's base URL is read from the
  // baked config rather than the bridge options: it is a build constant (with
  // the same dev-only loopback override as `authnBaseUrl`), and nothing in main
  // needs to vary it per window. Each call carries the IAP proxy token a
  // staging build mints (`iap-proxy-token.ts`); every other build's provider
  // answers `null`, and its requests carry the user's bearer alone.
  const iapProxyToken = createCachedIapTokenProvider({
    keyFilePath: resolveIapKeyFilePath(process.resourcesPath),
    audience: config.iapAudience,
    fetch: globalThis.fetch,
    now: Date.now,
    warn: (message) => log.warn(message),
  });

  bridge.handleInvoke(
    RunnerHostInvoke.listSandboxes,
    async (_event, bearerToken: unknown) => {
      assertString(bearerToken, "listSandboxes.bearerToken");
      return listSandboxesViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.getSandboxCosts,
    async (_event, bearerToken: unknown) => {
      assertString(bearerToken, "getSandboxCosts.bearerToken");
      return fetchSandboxCostsViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.getSandboxCatalogue,
    async (_event, bearerToken: unknown, context: unknown) => {
      assertString(bearerToken, "getSandboxCatalogue.bearerToken");
      const request =
        context == null
          ? null
          : sandboxCatalogueReadinessRequestSchema.parse(context);
      return fetchSandboxCatalogueViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        request,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.getVoiceAvailability,
    async (_event, bearerToken: unknown) => {
      assertString(bearerToken, "getVoiceAvailability.bearerToken");
      return voiceSessionsAvailabilityViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.setVoiceSessionLive,
    (event, live: unknown) => {
      assertBoolean(live, "setVoiceSessionLive.live");
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) return Promise.resolve();
      voiceLiveWindows.set(windowId, live);
      return Promise.resolve();
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.setVoiceSessionIndicator,
    (event, indicator: unknown) => {
      const checked = voiceSessionIndicatorOf(indicator);
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) return Promise.resolve();
      voiceLiveWindows.setIndicator(windowId, checked);
      return Promise.resolve();
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.mintVoiceSession,
    async (_event, bearerToken: unknown, request: unknown) => {
      assertString(bearerToken, "mintVoiceSession.bearerToken");
      return voiceSessionsMintViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        voiceSessionMintRequestOf(request),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.endVoiceSession,
    async (_event, bearerToken: unknown, voiceSessionId: unknown) => {
      assertString(bearerToken, "endVoiceSession.bearerToken");
      assertString(voiceSessionId, "endVoiceSession.voiceSessionId");
      return voiceSessionsEndViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        voiceSessionId,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.getTraycerModels,
    async (_event, bearerToken: unknown) => {
      assertString(bearerToken, "getTraycerModels.bearerToken");
      return fetchTraycerModelsViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.createSandbox,
    async (_event, bearerToken: unknown, request: unknown) => {
      assertString(bearerToken, "createSandbox.bearerToken");
      const parsedRequest = parseSandboxCreateRequest(request);
      return createSandboxViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        parsedRequest,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.destroySandbox,
    async (
      _event,
      bearerToken: unknown,
      sandboxId: unknown,
      onlyIfIdle: unknown,
    ) => {
      assertString(bearerToken, "destroySandbox.bearerToken");
      assertString(sandboxId, "destroySandbox.sandboxId");
      const idle = onlyIfIdle === undefined ? false : onlyIfIdle;
      assertBoolean(idle, "destroySandbox.onlyIfIdle");
      return destroySandboxViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        sandboxId,
        idle,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.patchSandbox,
    async (
      _event,
      bearerToken: unknown,
      sandboxId: unknown,
      request: unknown,
    ) => {
      assertString(bearerToken, "patchSandbox.bearerToken");
      assertString(sandboxId, "patchSandbox.sandboxId");
      const parsedRequest = parseSandboxPatchRequest(request);
      return patchSandboxViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        sandboxId,
        parsedRequest,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.keepSandbox,
    async (_event, bearerToken: unknown, sandboxId: unknown) => {
      assertString(bearerToken, "keepSandbox.bearerToken");
      assertString(sandboxId, "keepSandbox.sandboxId");
      return keepSandboxViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        sandboxId,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.runSandboxVerb,
    async (
      _event,
      bearerToken: unknown,
      sandboxId: unknown,
      verb: unknown,
      gesture: unknown,
      timeoutMs: unknown,
    ) => {
      assertString(bearerToken, "runSandboxVerb.bearerToken");
      assertString(sandboxId, "runSandboxVerb.sandboxId");
      assertNumber(timeoutMs, "runSandboxVerb.timeoutMs");
      const parsedVerb = parseSandboxLifecycleVerb(verb);
      const parsedGesture = parseSandboxVerbGesture(gesture);
      return runSandboxVerbViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        sandboxId,
        parsedVerb,
        parsedGesture,
        timeoutMs,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.getSandboxAutomation,
    async (_event, bearerToken: unknown, environmentId: unknown) => {
      assertString(bearerToken, "getSandboxAutomation.bearerToken");
      const parsedEnvironmentId =
        parseSandboxAutomationEnvironmentId(environmentId);
      return getSandboxAutomationViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        parsedEnvironmentId,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.openSandboxAutomation,
    async (_event, bearerToken: unknown, target: unknown) => {
      assertString(bearerToken, "openSandboxAutomation.bearerToken");
      const parsedTarget = parseSandboxAutomationOpenTarget(target);
      return openSandboxAutomationViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        parsedTarget,
      );
    },
  );

  // A bot's Slack app, on the same server and with the same proxy token.
  const slackAppBotCalls = [
    [RunnerHostInvoke.readSlackApp, readSlackAppViaHttp],
    [RunnerHostInvoke.getSlackAppManifest, fetchSlackAppManifestViaHttp],
    [RunnerHostInvoke.mintSlackAppInstallUrl, mintSlackAppInstallUrlViaHttp],
    [RunnerHostInvoke.disconnectSlackApp, disconnectSlackAppViaHttp],
  ] as const;
  for (const [channel, viaHttp] of slackAppBotCalls) {
    bridge.handleInvoke(
      channel,
      async (_event, bearerToken: unknown, botId: unknown) => {
        assertString(bearerToken, `${channel}.bearerToken`);
        const parsedBotId = parseSlackAppBotId(botId, `${channel}.botId`);
        return viaHttp(
          config.serverBaseUrl,
          bearerToken,
          await iapProxyToken(),
          parsedBotId,
        );
      },
    );
  }

  bridge.handleInvoke(
    RunnerHostInvoke.registerSlackApp,
    async (_event, bearerToken: unknown, request: unknown) => {
      assertString(bearerToken, "registerSlackApp.bearerToken");
      const parsedRequest = parseSlackAppRegisterRequest(request);
      return registerSlackAppViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        parsedRequest,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.setSlackAppDms,
    async (_event, bearerToken: unknown, request: unknown) => {
      assertString(bearerToken, "setSlackAppDms.bearerToken");
      const parsedRequest = parseSlackAppDmsRequest(request);
      return setSlackAppDmsViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        parsedRequest,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.mintTeamHostInstallToken,
    async (_event, bearerToken: unknown, environmentId: unknown) => {
      assertString(bearerToken, "mintTeamHostInstallToken.bearerToken");
      return mintTeamHostInstallTokenViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        parseRequiredId(
          environmentId,
          "mintTeamHostInstallToken.environmentId",
        ),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.getSandboxGrants,
    async (
      _event,
      bearerToken: unknown,
      environmentId: unknown,
      hostId: unknown,
    ) => {
      assertString(bearerToken, "getSandboxGrants.bearerToken");
      assertNullableString(environmentId, "getSandboxGrants.environmentId");
      assertString(hostId, "getSandboxGrants.hostId");
      return fetchSandboxGrantsViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
        environmentId,
        hostId,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.getTeamEnvironment,
    async (_event, bearerToken: unknown, teamId: unknown) => {
      assertString(bearerToken, "getTeamEnvironment.bearerToken");
      return fetchTeamEnvironmentViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
        parseRequiredId(teamId, "getTeamEnvironment.teamId"),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.getEnvironmentProviders,
    async (_event, bearerToken: unknown, environmentId: unknown) => {
      assertString(bearerToken, "getEnvironmentProviders.bearerToken");
      return fetchEnvironmentProvidersViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
        parseRequiredId(environmentId, "getEnvironmentProviders.environmentId"),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.mintExecutableWriteGrant,
    async (_event, bearerToken: unknown, hostId: unknown) => {
      assertString(bearerToken, "mintExecutableWriteGrant.bearerToken");
      assertString(hostId, "mintExecutableWriteGrant.hostId");
      return mintExecutableWriteGrantViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
        hostId,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.decideSecretRequest,
    async (
      _event,
      bearerToken: unknown,
      environmentId: unknown,
      requestId: unknown,
      decision: unknown,
    ) => {
      assertString(bearerToken, "decideSecretRequest.bearerToken");
      assertNullableString(environmentId, "decideSecretRequest.environmentId");
      assertString(requestId, "decideSecretRequest.requestId");
      return decideSecretRequestViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
        environmentId,
        requestId,
        parseSecretRequestDecision(decision),
      );
    },
  );
}

/**
 * The session a window set, with the generation of that set: a re-check that
 * verifies the bearer commits it under the same fences the set would have.
 */
interface PendingSessionPromotion {
  readonly snapshot: DesktopAuthSessionSnapshot;
  readonly generation: number;
}

/**
 * A bearer main is still checking. `promotion` is null for a pair main holds
 * from its own store for a window's local restore: no window claimed that
 * session, and main's key check cannot see what a window's own validation
 * with authn sees, so such a hold is only ever withdrawn, never promoted.
 */
interface PendingSessionCheck {
  readonly token: string;
  readonly userId: string;
  readonly promotion: PendingSessionPromotion | null;
  /** When the check may next run. */
  dueAtMs: number;
}

/**
 * The pending reasons for which main holds the window's session unverified
 * while it keeps checking. Each opens this machine's host only, and only when
 * main's stored credentials carry the same user and token. Taking a reason out
 * of this set stops that opening and leaves its re-check as it is.
 */
const HELD_LOCALLY_WHILE_PENDING: ReadonlySet<DesktopAuthSessionPendingReason> =
  new Set<DesktopAuthSessionPendingReason>([
    "key-source-unavailable",
    "signing-key-unconfirmed",
  ]);

function isPendingReason(
  reason: DesktopAuthSessionRefusalReason,
): reason is DesktopAuthSessionPendingReason {
  return (
    reason === "key-source-unavailable" || reason === "signing-key-unconfirmed"
  );
}

export function registerAuthIpc(bridge: RunnerIpcBridge): void {
  const restoreLocalSession = registerLocalAuthSessionRestore(bridge);
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
  // One IPC call for the whole conditional delete: the comparison and the
  // delete run inside a single locked FileTokenStore mutation, never composed
  // from separate get/delete invokes in a renderer.
  bridge.handleInvoke(
    RunnerHostInvoke.authTokenStoreDeleteIfToken,
    (_event, expectedToken: unknown) => {
      assertString(expectedToken, "authTokenStoreDeleteIfToken");
      return bridge.authTokenStore.deleteIfToken(expectedToken);
    },
  );
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

  bridge.handleInvoke(
    RunnerHostInvoke.deregisterHostFromAccount,
    async (_event, bearerToken: unknown, hostId: unknown) => {
      assertString(bearerToken, "deregisterHostFromAccount.bearerToken");
      assertString(hostId, "deregisterHostFromAccount.hostId");
      // Run in main so renderer-origin CORS does not block authn-v3's
      // `POST /api/v3/hosts/:hostId/deregister`, exactly as above.
      return deregisterHostViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
        hostId,
      );
    },
  );

  registerSandboxControlPlaneIpc(bridge);

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
      // No caller signal: an `AbortSignal` cannot cross the context bridge, so
      // a renderer that cancels settles its own side (`settleOnAbort`) and this
      // GET simply runs out its bounded timeout with nobody reading the reply.
      return listUserSessionsViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
        null,
      );
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
    async (_event, bearerToken: unknown, request: unknown) => {
      assertString(bearerToken, "mintHostCredential.bearerToken");
      // The caller's own bearer, never the retained step-up credential. The
      // mint is not step-up gated, so substituting one here would have let an
      // IPC caller spend a step-up bearer for a dialog nobody ever saw.
      return mintHostCredentialViaHttp(
        bridge.options.authnBaseUrl,
        bearerToken,
        parseMintHostCredentialRequest(request),
        null,
      );
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

  bridge.handleInvoke(RunnerHostInvoke.authSessionGet, () => {
    return bridge.authSession.get();
  });

  // Verification happens HERE, at the set, and not at the reads: main derives
  // the jar plane's bearer and userId from this session, so a shape-only parse
  // would let any renderer name the account main then speaks for.
  const bearerVerifier = createDesktopBearerVerifier({
    authnBaseUrl: bridge.options.authnBaseUrl,
    fetchImpl: (input, init) => fetch(input, init),
    now: () => Date.now(),
  });

  // What main is still checking, at most two bearers:
  // - `signInCheck`, the newest sign-in a set was answered `pending` for;
  // - `holdCheck`, the bearer main holds unverified when it is not the
  //   sign-in's (`reconcileHoldCheck`).
  // A set ends them only once it commits something of its own: a verified
  // session, a state with no bearer, or a newer pending sign-in. A refused or
  // superseded set leaves them as they were.
  let signInCheck: PendingSessionCheck | null = null;
  let holdCheck: PendingSessionCheck | null = null;
  let checkTimer: NodeJS.Timeout | null = null;
  // One pass verifies the checks one after another, so the verifier's single
  // fetch per cooldown serves both instead of answering the second
  // "unreachable" while the first is still fetching.
  let checkPassRunning = false;
  let checksDisposed = false;
  // Counts sets as they arrive. A set whose number is no longer the newest
  // when its verification returns is an older intent and changes nothing.
  let setSequence = 0;

  const isLiveCheck = (check: PendingSessionCheck): boolean =>
    check === signInCheck || check === holdCheck;

  const heldUnverified = (): {
    readonly token: string;
    readonly userId: string;
  } | null => {
    const held = bridge.authSession.get();
    if (
      held.status !== "unverified" ||
      held.token === null ||
      held.profile === null
    ) {
      return null;
    }
    return { token: held.token, userId: held.profile.userId };
  };

  // When a check that ran without a verdict may run again: at the verifier's
  // next fetch, or a full cooldown on when that time has already passed (a
  // check answered from the keys in hand), so a hold check never spins.
  const nextCheckDueMs = (): number => {
    const now = Date.now();
    const allowed = bearerVerifier.nextFetchAllowedAtMs();
    return allowed > now ? allowed : now + JWKS_REFETCH_COOLDOWN_MS;
  };

  // Main never holds a bearer it is not checking: the hold check follows the
  // hold. The exception is a bearer a renderer revoked. Its window was demoted
  // to local use on purpose (the local plane is kept on a terminal verdict
  // loss), and a check could only end that.
  function reconcileHoldCheck(): void {
    const held = heldUnverified();
    if (
      held === null ||
      held.token === signInCheck?.token ||
      bridge.authSession.isBearerRevoked(held.token)
    ) {
      holdCheck = null;
      return;
    }
    if (holdCheck?.token === held.token) return;
    holdCheck = {
      token: held.token,
      userId: held.userId,
      promotion: null,
      // Never before a full cooldown: a window that restores locally at
      // startup sends its own sign-in moments later, and a check fetching the
      // keys meanwhile would answer that set "unreachable".
      dueAtMs: Math.max(
        bearerVerifier.nextFetchAllowedAtMs(),
        Date.now() + JWKS_REFETCH_COOLDOWN_MS,
      ),
    };
  }

  function syncChecks(): void {
    if (checksDisposed) return;
    reconcileHoldCheck();
    if (checkTimer !== null) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    // A running pass schedules the next one when it ends.
    if (checkPassRunning) return;
    const dues: number[] = [];
    if (signInCheck !== null) dues.push(signInCheck.dueAtMs);
    if (holdCheck !== null) dues.push(holdCheck.dueAtMs);
    if (dues.length === 0) return;
    checkTimer = setTimeout(
      () => {
        checkTimer = null;
        void runCheckPass();
      },
      Math.max(0, Math.min(...dues) - Date.now()),
    );
  }

  // A committed verified session, or a committed state with no bearer, is
  // what every window follows from here.
  function endAllChecks(): void {
    signInCheck = null;
    holdCheck = null;
    syncChecks();
  }

  bridge.disposeFns.push(() => {
    checksDisposed = true;
    signInCheck = null;
    holdCheck = null;
    if (checkTimer !== null) clearTimeout(checkTimer);
    checkTimer = null;
  });

  const isHeldOrChecked = (token: string, userId: string): boolean => {
    const matches = (
      candidate: { readonly token: string; readonly userId: string } | null,
    ): boolean =>
      candidate !== null &&
      candidate.token === token &&
      candidate.userId === userId;
    return (
      matches(signInCheck) || matches(holdCheck) || matches(heldUnverified())
    );
  };

  /**
   * A verdict against `token`, from a re-check or from a set of the same pair:
   * main stops holding it, so this machine's host is no longer selectable on
   * it, stops checking it, and tells every window, since the sets that were
   * answered `pending` for it returned long ago.
   */
  function applyVerdict(
    token: string,
    reason: DesktopAuthSessionRefusalReason,
  ): void {
    if (signInCheck?.token === token) signInCheck = null;
    if (holdCheck?.token === token) holdCheck = null;
    const withdrawn = bridge.authSession.withdrawLocal(token);
    syncChecks();
    log.warn("[auth] a pending auth session failed its check", {
      reason,
      withdrawn,
    });
    const refused: DesktopAuthSessionPendingRefused = { token, reason };
    bridge.fanOut(RunnerHostEvent.authSessionPendingRefused, refused);
  }

  async function runCheckPass(): Promise<void> {
    checkPassRunning = true;
    try {
      // The newest sign-in first: when both verify, it is the one promoted.
      for (const check of [signInCheck, holdCheck]) {
        if (check === null || !isLiveCheck(check)) continue;
        if (check.dueAtMs > Date.now()) continue;
        const reason = await bearerVerifier.verify(check.token, check.userId);
        if (!isLiveCheck(check)) continue;
        if (reason !== null && isPendingReason(reason)) {
          check.dueAtMs = nextCheckDueMs();
          continue;
        }
        if (reason !== null) {
          applyVerdict(check.token, reason);
          continue;
        }
        if (check.promotion === null) {
          // Main's own hold of a stored pair stays a hold, checked again for a
          // verdict and never promoted.
          check.dueAtMs = nextCheckDueMs();
          continue;
        }
        const committed = bridge.authSession.setVerified(
          check.promotion.snapshot,
          check.promotion.generation,
        );
        log.info("[auth] verified a pending auth session", { committed });
        if (committed) {
          endAllChecks();
        } else if (signInCheck === check) {
          signInCheck = null;
        } else {
          holdCheck = null;
        }
      }
    } finally {
      checkPassRunning = false;
      syncChecks();
    }
  }

  bridge.handleInvoke(
    RunnerHostInvoke.authSessionSet,
    async (_event, snapshot: unknown): Promise<DesktopAuthSessionSetResult> => {
      const parsed = parseDesktopAuthSession(snapshot);
      setSequence += 1;
      const sequence = setSequence;
      if (parsed.token === null || parsed.profile === null) {
        // No bearer to verify: signing-in and signed-out are the renderer's
        // own UX states and carry nothing main can be made to speak for.
        bridge.authSession.set(parsed);
        endAllChecks();
        return { outcome: "accepted" };
      }
      const token = parsed.token;
      const userId = parsed.profile.userId;
      // Taken before the await: this set is the newest intent from here until
      // another begins, and the JWKS round-trip is where a sibling window's
      // set (or sign-out) can overtake it. The commit below is dropped if a
      // newer one COMMITTED meanwhile - a newer set that was refused, or is
      // still verifying, supersedes nothing (`DesktopAuthSession.setVerified`).
      const generation = bridge.authSession.beginSet();
      const reason = await bearerVerifier.verify(token, userId);
      if (reason !== null && isPendingReason(reason)) {
        // A newer set owns what happens next; this one neither holds nor
        // schedules anything.
        if (sequence !== setSequence) return { outcome: "superseded" };
        // Main's own stored credentials, never this window's word: the same
        // rule a window's offline restore uses, so it grants this machine's
        // host and nothing that speaks for the account.
        const heldLocally =
          HELD_LOCALLY_WHILE_PENDING.has(reason) &&
          (await restoreLocalSession({ userId, token })) === "restored";
        if (sequence !== setSequence) return { outcome: "superseded" };
        // A sibling window's set of this same pair can have verified while
        // this one waited (its fetch counted against the cooldown this one
        // hit). That verified session already fanned out, so `pending` would
        // leave the sender a notice nothing ever takes down.
        const held = bridge.authSession.get();
        if (
          held.verified &&
          held.token === token &&
          held.profile?.userId === userId
        ) {
          return { outcome: "accepted" };
        }
        // The newest sign-in main could not check. The one it replaces goes on
        // being checked, with its own promotion, while main still holds it.
        const replaced = signInCheck;
        signInCheck = {
          token,
          userId,
          promotion: { snapshot: parsed, generation },
          dueAtMs: bearerVerifier.nextFetchAllowedAtMs(),
        };
        if (
          replaced !== null &&
          replaced.token !== token &&
          replaced.token === heldUnverified()?.token
        ) {
          holdCheck = replaced;
        }
        syncChecks();
        log.warn("[auth] could not check an auth session yet", {
          reason,
          heldLocally,
        });
        return { outcome: "pending", reason, heldLocally };
      }
      if (reason !== null) {
        // A verdict against a pair main is holding or checking ends it here,
        // exactly as a re-check's would. Anything else - possibly a verified
        // session - stays as it was. The reason is a statement about the
        // token, never about who sent it, so it is the whole of what this line
        // may carry.
        if (isHeldOrChecked(token, userId)) applyVerdict(token, reason);
        log.warn("[auth] refused an unverifiable auth session", { reason });
        return { outcome: "refused", reason };
      }
      // Reported, not swallowed: an `accepted` for a set main did not install
      // would leave the sender believing main holds what it sent.
      if (!bridge.authSession.setVerified(parsed, generation)) {
        return { outcome: "superseded" };
      }
      endAllChecks();
      return { outcome: "accepted" };
    },
  );

  // The renderer's terminal verdict loss. Not a session transition - the
  // session main holds stays as it is and fans out unchanged - only the
  // verification behind it goes, which is what the jar plane reads. The
  // revoke names the bearer it is about: windows' IPC is unordered, so one
  // that arrives after a sibling's fresh sign-in must not strip THAT session
  // (`DesktopAuthSession.revokeVerification`). A revoke without a bearer
  // names nothing and is dropped. The revocation scope rides along for the
  // other windows only; main's own withdrawal does not depend on it.
  bridge.handleInvoke(
    RunnerHostInvoke.authSessionRevoke,
    (_event, rejectedToken: unknown, revocation: unknown) => {
      if (typeof rejectedToken !== "string") return;
      // Revoked first, so the hold check below skips the bearer.
      bridge.authSession.revokeVerification(rejectedToken);
      // A bearer authn has refused is never worth checking again. A local hold
      // of it stays (`reconcileHoldCheck`).
      if (signInCheck?.token === rejectedToken) signInCheck = null;
      if (holdCheck?.token === rejectedToken) holdCheck = null;
      syncChecks();
      // Withdrawing main's verification protects what MAIN speaks for. It
      // does nothing for the other renderers: the fan-out above republishes
      // the same snapshot, every window's latch discards it as an echo, and
      // their auth stores keep reading `signed-in` and dispatching cloud work
      // on the bearer authn has already refused - until each happens to
      // revalidate on its own. This is the edge that tells them, on its own
      // channel and naming the bearer so each can fence it. The originating
      // window included: its own demotion has already run, and re-ingesting a
      // bearer it no longer holds verified is a no-op there.
      const revoked: DesktopAuthVerificationRevoked = {
        token: rejectedToken,
        revocation: revocation === "user-epoch" ? "user-epoch" : null,
      };
      bridge.fanOut(RunnerHostEvent.authVerificationRevoked, revoked);
    },
  );

  const onAuthSessionChange = (
    snapshot: DesktopAuthSessionSnapshot,
    kind: DesktopAuthSessionChangeKind,
  ): void => {
    retainedStepUpCredential = null;
    // A hold taken or moved by any path - a window's local restore included -
    // is checked from here.
    syncChecks();
    // Windows never ingest main's unverified hold, so its withdrawal is not
    // theirs to see either: as a status it would read as a sign-out. They hear
    // the verdict on `authSessionPendingRefused` instead.
    if (kind === "local-hold-withdrawn") return;
    bridge.fanOut(RunnerHostEvent.authSessionChange, snapshot);
  };
  bridge.authSession.on("change", onAuthSessionChange);
  bridge.disposeFns.push(() => {
    bridge.authSession.off("change", onAuthSessionChange);
  });

  bridge.fanOut(RunnerHostEvent.authSessionChange, bridge.authSession.get());
}
