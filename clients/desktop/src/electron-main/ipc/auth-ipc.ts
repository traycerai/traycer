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
import { voiceRouteViaHttp } from "@traycer-clients/shared/host-client/voice-router";
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
} from "@traycer-clients/shared/host-client/slack-app";
import { mintExecutableWriteGrantViaHttp } from "@traycer-clients/shared/host-client/executable-write-grant";
import { config } from "../../config";
import type {
  DesktopAuthSessionSetResult,
  DesktopAuthSessionSnapshot,
  DesktopAuthVerificationRevoked,
} from "../../ipc-contracts/window-types";
import { createDesktopBearerVerifier } from "../auth/bearer-verifier";
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
  parseSlackAppRegisterRequest,
  parseStoredAuthTokens,
  parseStoredCredentialsIdentity,
  parseTokenRotateExpected,
  parseUpdateHostVersionPolicyInput,
  readSenderWebContentsId,
} from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import { registerLocalAuthSessionRestore } from "./local-auth-session";
import { UNRELEASED_FEATURES_ENABLED } from "../../unreleased-features";

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
 * bot surfaces call. Registered only by a build with those features
 * (`unreleased-features.ts`); without them a stray call rejects as an
 * unhandled channel instead of reaching traycer-server or authn.
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
    async (_event, bearerToken: unknown) => {
      assertString(bearerToken, "getSandboxCatalogue.bearerToken");
      return fetchSandboxCatalogueViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
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

  // The voice router's model call: the body is the renderer's JSON, relayed
  // unread; the answer goes back opaque for the renderer's parser.
  bridge.handleInvoke(
    RunnerHostInvoke.routeVoiceUtterance,
    async (_event, bearerToken: unknown, requestBody: unknown) => {
      assertString(bearerToken, "routeVoiceUtterance.bearerToken");
      assertString(requestBody, "routeVoiceUtterance.requestBody");
      return voiceRouteViaHttp(
        config.serverBaseUrl,
        bearerToken,
        await iapProxyToken(),
        requestBody,
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

export function registerAuthIpc(bridge: RunnerIpcBridge): void {
  registerLocalAuthSessionRestore(bridge);
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

  if (UNRELEASED_FEATURES_ENABLED) registerSandboxControlPlaneIpc(bridge);

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

  bridge.handleInvoke(
    RunnerHostInvoke.authSessionSet,
    async (_event, snapshot: unknown): Promise<DesktopAuthSessionSetResult> => {
      const parsed = parseDesktopAuthSession(snapshot);
      if (parsed.token === null || parsed.profile === null) {
        // No bearer to verify: signing-in and signed-out are the renderer's
        // own UX states and carry nothing main can be made to speak for.
        bridge.authSession.set(parsed);
        return { outcome: "accepted" };
      }
      // Taken before the await: this set is the newest intent from here until
      // another begins, and the JWKS round-trip is where a sibling window's
      // set (or sign-out) can overtake it. The commit below is dropped if a
      // newer one COMMITTED meanwhile - a newer set that was refused, or is
      // still verifying, supersedes nothing (`DesktopAuthSession.setVerified`).
      const generation = bridge.authSession.beginSet();
      const reason = await bearerVerifier.verify(
        parsed.token,
        parsed.profile.userId,
      );
      if (reason !== null) {
        // The previous session - possibly a verified one - stays exactly as it
        // was. The reason is a statement about the token, never about who sent
        // it, so it is the whole of what this line may carry.
        log.warn("[auth] refused an unverifiable auth session", { reason });
        return { outcome: "refused", reason };
      }
      // Reported, not swallowed: an `accepted` for a set main did not install
      // would leave the sender believing main holds what it sent.
      return bridge.authSession.setVerified(parsed, generation)
        ? { outcome: "accepted" }
        : { outcome: "superseded" };
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
      bridge.authSession.revokeVerification(rejectedToken);
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
