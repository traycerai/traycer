import { useCallback, useEffect, useRef, useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  providerProfileSchema,
  type ProviderCliState,
  type ProviderLoginCapability,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  AMBIENT_AUTH_PENDING_REPOLL_CAP,
  AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS,
  isAmbientAuthVerdictPending,
  isDefinitiveProviderAuthStatus,
} from "@/lib/providers/provider-ambient-auth";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
  type AnalyticsBlocker,
} from "@/lib/analytics";
import { appLogger } from "@/lib/logger";

type LoginMutationContext = { readonly hostId: string | null };

export type StartLoginMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.startLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.startLogin">,
  LoginMutationContext
>;
export type AwaitLoginMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.awaitLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.awaitLogin">,
  LoginMutationContext
>;
export type CancelLoginMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.cancelLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.cancelLogin">,
  LoginMutationContext
>;
export type SubmitLoginCodeMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.submitLoginCode">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.submitLoginCode">
>;
export type TouchLoginMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.touchLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.touchLogin">
>;

export type ProviderProfileLoginFlowMode = "create" | "reauth";

export type ProviderProfileLoginFlowState =
  | { readonly kind: "start" }
  | { readonly kind: "starting"; readonly cancelRequested: boolean }
  | {
      readonly kind: "waiting";
      readonly profileId: string | null;
      readonly url: string | null;
    }
  | {
      readonly kind: "identity";
      readonly profileId: string;
      readonly profile: ProviderProfile;
      readonly profiles: readonly ProviderProfile[];
      readonly existingProfileId: string | null;
    }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled" };

/** Bounded auto-restart on a rejected/expired code-paste attempt (code-paste decision log's "Bad-code recovery"
 * row): 2 fresh-login retries per flow, then land on `failed`. */
type CodePasteRestartCause = "codeRejected" | "sessionExpired";
const CODE_PASTE_RESTART_CAP = 2;
const CODE_PASTE_RESTART_NOTICES: Record<CodePasteRestartCause, string> = {
  codeRejected: "That code didn't work - a new sign-in link was generated.",
  sessionExpired: "That sign-in link expired - a new one was generated.",
};
const CODE_PASTE_RESTART_LIMIT_MESSAGES: Record<CodePasteRestartCause, string> =
  {
    codeRejected: "That code kept getting rejected. Try signing in again.",
    sessionExpired:
      "The sign-in session kept expiring before the code arrived. Try again.",
  };
/** Keeps `providers.touchLogin` calls well under the host's 3-minute rolling kill timer while still bounding
 * call frequency during sustained typing (code-paste decision log's "Timeouts" row). */
const CODE_PASTE_TOUCH_THROTTLE_MS = 45_000;
const CODE_PASTE_KEEPALIVE_INTERVAL_MS = 60_000;

type AwaitLoginResult = ResponseOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;

/** What a settled `providers.awaitLogin` response means for the current attempt - computed by the pure
 * classifiers below, acted on by `beginLogin`'s success handler. */
type AwaitLoginResolution =
  | {
      readonly kind: "authenticated";
      readonly payload: {
        readonly profile: ProviderProfile;
        readonly profiles: readonly ProviderProfile[];
        readonly existingProfileId: string | null;
      } | null;
    }
  | { readonly kind: "codeRejected" }
  | { readonly kind: "authPending" }
  | { readonly kind: "notAuthenticated" };

/** Ambient reauth (no profile picker - the in-chat banner's OAuth reconnect) has no profile row to check. */
function classifyAmbientAwaitResult(
  result: AwaitLoginResult,
): AwaitLoginResolution {
  if (result.state?.auth.status === "authenticated") {
    return { kind: "authenticated", payload: null };
  }
  if (result.codeRejected) return { kind: "codeRejected" };
  if (result.state !== null && isAmbientAuthVerdictPending(result.state)) {
    return { kind: "authPending" };
  }
  return { kind: "notAuthenticated" };
}

/** The ambient row mirrors the state's top-level auth, whose force-refresh read is non-blocking host-side - a
 * non-definitive ambient verdict with the probe still in flight is "not settled yet", never a failure. */
function classifyProfileAwaitResult(
  result: AwaitLoginResult,
  awaitedProfileId: string | null,
): AwaitLoginResolution {
  const profiles = (result.state?.profiles ?? []).map((profile) =>
    providerProfileSchema.parse(profile),
  );
  const existingProfileId = result.existingProfileId ?? null;
  const resolvedProfileId = existingProfileId ?? awaitedProfileId;
  const profile =
    profiles.find((candidate) => candidate.profileId === resolvedProfileId) ??
    null;
  if (profile !== null && profile.auth.status === "authenticated") {
    return {
      kind: "authenticated",
      payload: { profile, profiles, existingProfileId },
    };
  }
  if (result.codeRejected) return { kind: "codeRejected" };
  if (
    profile !== null &&
    profile.kind === "ambient" &&
    !isDefinitiveProviderAuthStatus(profile.auth.status) &&
    (result.state?.authPending ?? false)
  ) {
    return { kind: "authPending" };
  }
  return { kind: "notAuthenticated" };
}

/** That verifying window is the one most easily mistaken for a dead UI, since `submitLoginCode.isPending` alone
 * only covers the near-instant relay leg. */
export type ProviderProfileLoginFlowCodePastePhase =
  | "idle"
  | "submitting"
  | "verifying";

export interface ProviderProfileLoginFlowCodePaste {
  /** `false` when the provider has no `codePaste` capability - callers
   *  should render nothing for the paste field in that case. */
  readonly enabled: boolean;
  /** Increments on every fresh login attempt (initial start and each auto-restart). */
  readonly attemptId: number;
  /** Non-null right after an auto-restart - the inline notice explaining a
   *  fresh sign-in link was generated. */
  readonly restartNotice: string | null;
  readonly phase: ProviderProfileLoginFlowCodePastePhase;
  /** Scoped to the current attempt only - `beginLogin` resets the underlying mutation on every fresh attempt so a
   * restart never renders the previous attempt's error. */
  readonly submitError: HostRpcError | null;
  readonly submit: (code: string) => void;
  readonly touch: () => void;
}

interface UseProviderProfileLoginFlowInput {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly providerId: ProviderCliState["providerId"];
  /** Reauth mode always targets this existing profile - the flow awaits this id regardless of what `startLogin`'s
   * response echoes. */
  readonly existingProfileId: string | null;
  /** Source of the `codePaste` capability gate - see
   *  `ProviderProfileLoginFlowCodePaste.enabled`. */
  readonly loginCapability: ProviderLoginCapability | null;
  readonly startLogin: StartLoginMutation;
  readonly awaitLogin: AwaitLoginMutation;
  readonly cancelLogin: CancelLoginMutation;
  readonly submitLoginCode: SubmitLoginCodeMutation;
  readonly touchLogin: TouchLoginMutation;
  /** Copy for the two failure edges - distinct per mode to match each
   *  dialog's existing wording. */
  readonly failureMessages: {
    readonly notStarted: string;
    readonly notFinished: string;
  };
  /** Fires once, the instant the flow lands on `failed` - lets a caller surface the failure outside the dialog
   * (the Settings panel's inline retry banner). */
  readonly onFailed: (message: string) => void;
}

export interface ProviderProfileLoginFlow {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly state: ProviderProfileLoginFlowState;
  readonly busy: boolean;
  /** `providers.startLogin` specifically - the "queued behind another sign-in" wording only applies while this
   * mutation, not `awaitLogin`, is pending. */
  readonly startPending: boolean;
  readonly start: (options: {
    readonly label: string | null;
    readonly shareSkillsAndPlugins: boolean;
  }) => void;
  readonly cancel: () => void;
  readonly cancelPending: boolean;
  /** Cancelling now would kill the provider child mid-exchange and burn the code. Derived from the submit
   * mutation and active waiting attempt; never mirrored in local state. */
  readonly commitPending: boolean;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
}

/** This never introduces a new top-level state - the paste field is always visible within `waiting` per that
 * decision log's "Paste field visibility" row. */
export function useProviderProfileLoginFlow(
  input: UseProviderProfileLoginFlowInput,
): ProviderProfileLoginFlow {
  const {
    mode,
    providerId,
    existingProfileId,
    loginCapability,
    startLogin,
    awaitLogin,
    cancelLogin,
    submitLoginCode,
    touchLogin,
    failureMessages,
    onFailed,
  } = input;
  const [state, setState] = useState<ProviderProfileLoginFlowState>({
    kind: "start",
  });
  const [restartNotice, setRestartNotice] = useState<string | null>(null);
  // Mirrors `attemptIdRef` for render-safe reads (`codePaste.attemptId` is read during render, where refs must
  // not be touched).
  const [attemptId, setAttemptId] = useState(0);
  const cancelRequestedRef = useRef(false);
  // Latches once `cancelProfile` fires for this flow - a boolean rather than the cancelled profile id itself.
  const cancelledRef = useRef(false);
  const restartCountRef = useRef(0);
  const attemptIdRef = useRef(0);
  // Reset per attempt in `beginLogin`, never compared across attempts.
  const awaitOutcomeRef = useRef<"authenticated" | "notAuthenticated" | null>(
    null,
  );
  const submitOutcomeRef = useRef<
    "none" | "pending" | "accepted" | "noActiveLogin"
  >("none");
  // The authenticated payload to resolve to, captured at the moment `awaitOutcomeRef` is set to
  // `"authenticated"`.
  const successPayloadRef = useRef<{
    readonly profile: ProviderProfile;
    readonly profiles: readonly ProviderProfile[];
    readonly existingProfileId: string | null;
  } | null>(null);
  const lastTouchAtRef = useRef(0);
  // Cleared on every fresh attempt, on cancellation, and on unmount so a late tick can never re-await a
  // superseded or abandoned attempt.
  const repollTimerRef = useRef<number | null>(null);
  // Latched by the unmount cleanup below so a re-poll already in flight at
  // unmount cannot schedule its successor.
  const unmountedRef = useRef(false);
  const lastStartOptionsRef = useRef<{
    readonly label: string | null;
    readonly shareSkillsAndPlugins: boolean;
  }>({ label: null, shareSkillsAndPlugins: false });
  // Forwarding ref breaks the `restart` <-> `beginLogin` cycle: `restart` must be declared before `beginLogin`
  // (which depends on it), so it can't reference `beginLogin` directly.
  const beginLoginRef = useRef<
    (
      options: {
        readonly label: string | null;
        readonly shareSkillsAndPlugins: boolean;
      },
      notice: string | null,
    ) => void
  >(() => {});

  const clearRepollTimer = useCallback((): void => {
    if (repollTimerRef.current !== null) {
      window.clearTimeout(repollTimerRef.current);
      repollTimerRef.current = null;
    }
  }, []);

  // Reset on every effect run rather than only at declaration: StrictMode's dev double-invoke unmounts and
  // remounts, which would otherwise leave this latched on for good.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      clearRepollTimer();
    };
  }, [clearRepollTimer]);

  const cancelProfile = useCallback(
    (profileId: string | null): void => {
      if (cancelledRef.current) return;
      cancelledRef.current = true;
      cancelLogin.mutate({ providerId, profileId });
    },
    [cancelLogin, providerId],
  );

  const finishCancellation = useCallback(
    (profileId: string | null): void => {
      clearRepollTimer();
      // Create mode's `null` means the host never minted a profile-scoped child, so there is nothing to cancel.
      if (mode === "reauth" || profileId !== null) cancelProfile(profileId);
      Analytics.getInstance().track(
        AnalyticsEvent.ProviderProfileLinkCancelled,
        { provider: providerId, mode },
      );
      setState({ kind: "cancelled" });
    },
    [cancelProfile, clearRepollTimer, mode, providerId],
  );

  // The blocker is classified from the real error at each call site (or an explicit bounded value for error-less
  // outcomes), never from the display message.
  const fail = useCallback(
    (message: string, blocker: AnalyticsBlocker): void => {
      // Flow-level failures otherwise surface only as inline dialog copy - log them so a failed sign-in/switch is
      // diagnosable from the desktop log after the fact.
      appLogger.warn("[provider-login] flow failed", {
        provider: providerId,
        mode,
        blocker,
        message,
      });
      Analytics.getInstance().track(AnalyticsEvent.ProviderProfileLinkFailed, {
        provider: providerId,
        mode,
        blocker,
      });
      setState({ kind: "failed", message });
      onFailed(message);
    },
    [mode, onFailed, providerId],
  );

  /** Auto-restart entry point, invoked from `settleAttempt` (the `codeRejected` case) or directly from
   * `beginLogin`'s `awaitLogin` `onSuccess` (the `codeRejected` fast path. */
  const restart = useCallback(
    (cause: CodePasteRestartCause): void => {
      if (cancelRequestedRef.current) {
        finishCancellation(null);
        return;
      }
      if (restartCountRef.current >= CODE_PASTE_RESTART_CAP) {
        fail(CODE_PASTE_RESTART_LIMIT_MESSAGES[cause], "timeout");
        return;
      }
      restartCountRef.current += 1;
      beginLoginRef.current(
        lastStartOptionsRef.current,
        CODE_PASTE_RESTART_NOTICES[cause],
      );
    },
    [fail, finishCancellation],
  );

  /** Called again whenever either ref changes, so a late verdict (whichever side resolves second) always gets a
   * chance to settle the attempt instead of being silently dropped. */
  const settleAttempt = useCallback(
    (thisAttemptId: number): void => {
      if (attemptIdRef.current !== thisAttemptId) return;
      const awaitOutcome = awaitOutcomeRef.current;
      if (awaitOutcome === null) return;
      const ambient = mode === "reauth" && existingProfileId === null;
      if (awaitOutcome === "authenticated") {
        Analytics.getInstance().track(
          AnalyticsEvent.ProviderProfileLinkSucceeded,
          { provider: providerId, mode },
        );
        if (ambient) {
          setState({ kind: "start" });
          return;
        }
        const payload = successPayloadRef.current;
        if (payload === null) return;
        setState({
          kind: "identity",
          profileId: payload.profile.profileId,
          profile: payload.profile,
          profiles: payload.profiles,
          existingProfileId: payload.existingProfileId,
        });
        return;
      }
      const submitOutcome = submitOutcomeRef.current;
      if (submitOutcome === "pending") return;
      if (submitOutcome === "noActiveLogin") {
        restart("sessionExpired");
        return;
      }
      if (ambient) {
        setState({ kind: "start" });
        return;
      }
      fail(failureMessages.notFinished, "authentication");
    },
    [existingProfileId, fail, failureMessages, mode, providerId, restart],
  );

  const beginLogin = useCallback(
    (
      options: {
        readonly label: string | null;
        readonly shareSkillsAndPlugins: boolean;
      },
      notice: string | null,
    ): void => {
      lastStartOptionsRef.current = options;
      // A fresh attempt supersedes any pending ambient re-poll tick.
      clearRepollTimer();
      attemptIdRef.current += 1;
      const thisAttemptId = attemptIdRef.current;
      awaitOutcomeRef.current = null;
      submitOutcomeRef.current = "none";
      successPayloadRef.current = null;
      lastTouchAtRef.current = 0;
      // Statefulness fixup: without this, a restart's fresh `CodePasteField` (remounted via `key={attemptId}`) would
      // still render the previous attempt's `submitError`/pending flags off the shared mutation object.
      submitLoginCode.reset();
      touchLogin.reset();
      setAttemptId(thisAttemptId);
      setRestartNotice(notice);
      setState({ kind: "starting", cancelRequested: false });
      startLogin.mutate(
        {
          providerId,
          profileId: existingProfileId,
          createProfile:
            mode === "create"
              ? {
                  label: options.label ?? "",
                  shareSkillsAndPlugins: options.shareSkillsAndPlugins,
                }
              : null,
        },
        {
          onSuccess: (data) => {
            // Reauth always awaits the profile it was invoked for - the response never mints a different id for an
            // existing profile.
            const nextProfileId =
              mode === "reauth" ? existingProfileId : data.profileId;
            if (cancelRequestedRef.current) {
              finishCancellation(nextProfileId);
              return;
            }
            // Create mode must have a minted profile id to proceed.
            if (
              !data.started ||
              (mode === "create" && nextProfileId === null)
            ) {
              // The RPC succeeded but the host declined to start the login:
              // the provider tooling is the limiting factor, not auth.
              fail(failureMessages.notStarted, "provider_unavailable");
              return;
            }
            setState({
              kind: "waiting",
              profileId: nextProfileId,
              url: data.url,
            });
            // Per-attempt budget for the ambient `authPending` re-poll (see the constant's doc comment).
            let authPendingRepolls = 0;
            // Clearing the re-poll timer cannot recall an already-dispatched RPC, and neither cancelling nor unmounting
            // touches `attemptIdRef`.
            const attemptAbandoned = (): boolean =>
              attemptIdRef.current !== thisAttemptId ||
              cancelRequestedRef.current ||
              cancelledRef.current ||
              unmountedRef.current;
            const scheduleAuthPendingRepoll = (): boolean => {
              if (authPendingRepolls >= AMBIENT_AUTH_PENDING_REPOLL_CAP) {
                return false;
              }
              authPendingRepolls += 1;
              repollTimerRef.current = window.setTimeout(() => {
                repollTimerRef.current = null;
                if (attemptAbandoned()) return;
                awaitOnce();
              }, AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS);
              return true;
            };
            const handleAwaitSuccess = (result: AwaitLoginResult): void => {
              if (attemptAbandoned()) return;
              const resolution =
                mode === "reauth" && existingProfileId === null
                  ? classifyAmbientAwaitResult(result)
                  : classifyProfileAwaitResult(result, nextProfileId);
              if (resolution.kind === "authenticated") {
                awaitOutcomeRef.current = "authenticated";
                successPayloadRef.current = resolution.payload;
                settleAttempt(thisAttemptId);
                return;
              }
              if (resolution.kind === "codeRejected") {
                restart("codeRejected");
                return;
              }
              if (
                resolution.kind === "authPending" &&
                scheduleAuthPendingRepoll()
              ) {
                return;
              }
              awaitOutcomeRef.current = "notAuthenticated";
              settleAttempt(thisAttemptId);
            };
            const handleAwaitError = (): void => {
              if (attemptAbandoned()) return;
              awaitOutcomeRef.current = "notAuthenticated";
              settleAttempt(thisAttemptId);
            };
            const awaitOnce = (): void => {
              awaitLogin.mutate(
                { providerId, profileId: nextProfileId },
                { onSuccess: handleAwaitSuccess, onError: handleAwaitError },
              );
            };
            awaitOnce();
          },
          onError: (error) => {
            if (cancelRequestedRef.current) {
              finishCancellation(null);
              return;
            }
            fail(failureMessages.notStarted, analyticsBlockerFromError(error));
          },
        },
      );
    },
    [
      awaitLogin,
      clearRepollTimer,
      existingProfileId,
      fail,
      failureMessages,
      finishCancellation,
      mode,
      providerId,
      restart,
      settleAttempt,
      startLogin,
      submitLoginCode,
      touchLogin,
    ],
  );
  // Keeps the forwarding ref current after render commits (never during render, per the `react-hooks/refs` rule)
  // - `restart` only invokes it from inside async mutation callbacks, well after the first commit.
  useEffect(() => {
    beginLoginRef.current = beginLogin;
  });

  const start = useCallback(
    (options: {
      readonly label: string | null;
      readonly shareSkillsAndPlugins: boolean;
    }): void => {
      if (
        state.kind === "starting" ||
        state.kind === "waiting" ||
        startLogin.isPending ||
        awaitLogin.isPending
      ) {
        return;
      }
      cancelRequestedRef.current = false;
      cancelledRef.current = false;
      restartCountRef.current = 0;
      Analytics.getInstance().track(AnalyticsEvent.ProviderProfileLinkStarted, {
        source: "direct_ui",
        provider: providerId,
        mode,
      });
      beginLogin(options, null);
    },
    [
      awaitLogin.isPending,
      beginLogin,
      mode,
      providerId,
      startLogin.isPending,
      state.kind,
    ],
  );

  const commitPending =
    submitLoginCode.isPending ||
    (submitLoginCode.isSuccess &&
      submitLoginCode.data.outcome === "accepted" &&
      state.kind === "waiting");

  const cancel = useCallback((): void => {
    if (commitPending) return;
    cancelRequestedRef.current = true;
    if (state.kind === "starting") {
      if (mode === "reauth" && existingProfileId !== null) {
        finishCancellation(existingProfileId);
        return;
      }
      setState({ kind: "starting", cancelRequested: true });
      return;
    }
    if (state.kind === "waiting") {
      finishCancellation(state.profileId);
      return;
    }
    if (
      mode === "reauth" &&
      state.kind === "start" &&
      existingProfileId !== null
    ) {
      finishCancellation(existingProfileId);
    }
  }, [commitPending, existingProfileId, finishCancellation, mode, state]);

  const submitCode = useCallback(
    (code: string): void => {
      // `state.profileId` may be `null` in the ambient reauth case - the request still carries it (the wire
      // contract's `profileId` is nullable exactly for this), so no extra guard is needed here.
      if (state.kind !== "waiting") return;
      const thisAttemptId = attemptIdRef.current;
      // Marks this attempt's submit verdict in flight *before* the request goes out.
      submitOutcomeRef.current = "pending";
      submitLoginCode.mutate(
        { providerId, profileId: state.profileId, code },
        {
          onSuccess: (result) => {
            if (attemptIdRef.current !== thisAttemptId) return;
            submitOutcomeRef.current =
              result.outcome === "noActiveLogin" ? "noActiveLogin" : "accepted";
            settleAttempt(thisAttemptId);
          },
          onError: () => {
            if (attemptIdRef.current !== thisAttemptId) return;
            // An RPC-level failure carries no "no active child" verdict - treat it like "accepted" (nothing more to wait
            // for) so a `notAuthenticated` await isn't left waiting on this submit forever.
            submitOutcomeRef.current = "accepted";
            settleAttempt(thisAttemptId);
          },
        },
      );
    },
    [providerId, settleAttempt, state, submitLoginCode],
  );

  const touchLoginMutate = touchLogin.mutate;
  const touch = useCallback((): void => {
    if (state.kind !== "waiting") return;
    const now = Date.now();
    if (now - lastTouchAtRef.current < CODE_PASTE_TOUCH_THROTTLE_MS) return;
    lastTouchAtRef.current = now;
    touchLoginMutate({ providerId, profileId: state.profileId });
  }, [providerId, state, touchLoginMutate]);

  const codePasteEnabled =
    loginCapability !== null && loginCapability.codePaste !== null;

  // Users may spend several minutes in account pickers or 2FA before interacting with the fallback field;
  // field-only touches would let the host's rolling deadline expire first.
  useEffect(() => {
    if (state.kind !== "waiting" || !codePasteEnabled) return;
    const intervalId = window.setInterval(
      touch,
      CODE_PASTE_KEEPALIVE_INTERVAL_MS,
    );
    return () => window.clearInterval(intervalId);
  }, [codePasteEnabled, state.kind, touch]);

  // A successful relay remains in the checking phase while this top-level flow is still in `waiting`;
  // `awaitLogin` moves the flow away from that state when the real exchange settles.
  let codePastePhase: ProviderProfileLoginFlowCodePastePhase = "idle";
  if (submitLoginCode.isPending) codePastePhase = "submitting";
  else if (commitPending) codePastePhase = "verifying";

  return {
    mode,
    state,
    busy:
      state.kind === "starting" || startLogin.isPending || awaitLogin.isPending,
    startPending: state.kind === "starting" || startLogin.isPending,
    start,
    cancel,
    cancelPending: cancelLogin.isPending,
    commitPending,
    codePaste: {
      enabled: codePasteEnabled,
      attemptId,
      restartNotice,
      phase: codePastePhase,
      submitError: submitLoginCode.error,
      submit: submitCode,
      touch,
    },
  };
}
