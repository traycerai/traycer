import { useCallback, useEffect, useRef, useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type {
  ProviderCliState,
  ProviderLoginCapability,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
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

/**
 * Bounded auto-restart on a rejected/expired code-paste attempt (code-paste
 * decision log's "Bad-code recovery" row): 2 fresh-login retries per flow,
 * then land on `failed`. `codeRejected` comes from `awaitLogin`'s own flag;
 * `sessionExpired` comes from the two-sided join in `settleAttempt` between
 * `awaitLogin` not authenticating and `submitLoginCode` reporting
 * `noActiveLogin` for the same attempt - see that function's doc comment.
 */
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
/** Keeps `providers.touchLogin` calls well under the host's 3-minute
 *  rolling kill timer while still bounding call frequency during sustained
 *  typing (code-paste decision log's "Timeouts" row). */
const CODE_PASTE_TOUCH_THROTTLE_MS = 45_000;
const CODE_PASTE_KEEPALIVE_INTERVAL_MS = 60_000;

/**
 * Bounded re-poll for the ambient row's `authPending` window: the host's
 * `providers.awaitLogin` response can carry a non-definitive ambient auth
 * reading (the login runner evicts the ambient auth cache when the login
 * child closes, and older hosts assemble the response from a non-blocking
 * probe), so a not-yet-authenticated ambient verdict with `authPending` set
 * means "the probe is still running", not "sign-in failed". Re-awaiting is
 * cheap - with no login job in flight the host resolves immediately with a
 * re-probed state - so a few short re-polls let the background probe land
 * instead of misreporting a successful switch as a failure. Definitive
 * verdicts (`authenticated`/`unauthenticated`) are never re-polled.
 */
export const AMBIENT_AUTH_PENDING_REPOLL_CAP = 3;
// Exported so tests can drive the re-poll deterministically with fake timers
// instead of hardcoding a duplicate magic number that could silently drift
// from this value.
export const AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS = 2_000;

function isDefinitiveAuthStatus(
  status: ProviderProfile["auth"]["status"],
): boolean {
  return status === "authenticated" || status === "unauthenticated";
}

type AwaitLoginResult = ResponseOfMethod<
  HostRpcRegistry,
  "providers.awaitLogin"
>;

/** What a settled `providers.awaitLogin` response means for the current
 *  attempt - computed by the pure classifiers below, acted on by
 *  `beginLogin`'s success handler. */
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

/**
 * Ambient reauth (no profile picker - the in-chat banner's OAuth reconnect)
 * has no profile row to check: the re-probed top-level auth status is the
 * only success signal, since `providers.list` keeps a profile row present
 * even when it is signed out (fixup review finding 2 - presence alone is
 * not success). A non-definitive top-level status with the probe still in
 * flight is "not settled yet" (see `AMBIENT_AUTH_PENDING_REPOLL_CAP`).
 */
function classifyAmbientAwaitResult(
  result: AwaitLoginResult,
): AwaitLoginResolution {
  if (result.state?.auth.status === "authenticated") {
    return { kind: "authenticated", payload: null };
  }
  if (result.codeRejected) return { kind: "codeRejected" };
  if (
    result.state !== null &&
    result.state.authPending &&
    !isDefinitiveAuthStatus(result.state.auth.status)
  ) {
    return { kind: "authPending" };
  }
  return { kind: "notAuthenticated" };
}

/**
 * Same presence-is-not-success caveat as the ambient classifier: a resolved
 * row must also be authenticated, not merely present. The ambient row
 * mirrors the state's top-level auth, whose force-refresh read is
 * non-blocking host-side - a non-definitive ambient verdict with the probe
 * still in flight is "not settled yet", never a failure. Managed rows get an
 * awaited per-profile probe host-side, so that window is ambient-only.
 */
function classifyProfileAwaitResult(
  result: AwaitLoginResult,
  awaitedProfileId: string | null,
): AwaitLoginResolution {
  const profiles = result.state?.profiles ?? [];
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
    !isDefinitiveAuthStatus(profile.auth.status) &&
    (result.state?.authPending ?? false)
  ) {
    return { kind: "authPending" };
  }
  return { kind: "notAuthenticated" };
}

/**
 * The paste field's real-world phases, derived from the mutation lifecycle:
 * `"idle"` - nothing in flight, ready for a paste/submit (including right
 * after a submit RPC error, so the same code can be retried); `"submitting"`
 * - the `providers.submitLoginCode` relay RPC is in flight (host writes to
 * the child's stdin and returns almost instantly); `"verifying"` - the relay
 * succeeded (or errored in a way that carries no verdict - see `submitCode`'s
 * `onError`) and the real token exchange is running host-side, from
 * `awaitLogin` settles this attempt. That verifying window is the one most
 * easily mistaken for a dead UI, since `submitLoginCode.isPending` alone only
 * covers the near-instant relay leg.
 */
export type ProviderProfileLoginFlowCodePastePhase =
  "idle" | "submitting" | "verifying";

export interface ProviderProfileLoginFlowCodePaste {
  /** `false` when the provider has no `codePaste` capability - callers
   *  should render nothing for the paste field in that case. */
  readonly enabled: boolean;
  /** Increments on every fresh login attempt (initial start and each
   *  auto-restart). Callers key the paste field's local component state by
   *  this so a restart's fresh child gets a clean, unmasked field. */
  readonly attemptId: number;
  /** Non-null right after an auto-restart - the inline notice explaining a
   *  fresh sign-in link was generated. */
  readonly restartNotice: string | null;
  readonly phase: ProviderProfileLoginFlowCodePastePhase;
  /** Rendered inline by the caller, never a toast - see
   *  `useProvidersSubmitLoginCode`'s doc comment. Scoped to the current
   *  attempt only - `beginLogin` resets the underlying mutation on every
   *  fresh attempt so a restart never renders the previous attempt's error. */
  readonly submitError: HostRpcError | null;
  readonly submit: (code: string) => void;
  readonly touch: () => void;
}

interface UseProviderProfileLoginFlowInput {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly providerId: ProviderCliState["providerId"];
  /** Reauth mode always targets this existing profile - the flow awaits THIS
   *  id regardless of what `startLogin`'s response echoes. `null` in reauth
   *  mode means the ambient, no-profile-picker identity (the in-chat reauth
   *  banner's OAuth reconnect, which predates per-profile management) - the
   *  flow still runs the full waiting/code-paste machinery against it, just
   *  without a profile to resolve on success (see `beginLogin`'s ambient
   *  branch). Create mode has no profile yet, so it awaits whatever id
   *  `startLogin` mints. */
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
  /** Fires once, the instant the flow lands on `failed` - lets a caller
   *  surface the failure outside the dialog (the Settings panel's inline
   *  retry banner). Reauth mode, which has no such banner, passes a no-op. */
  readonly onFailed: (message: string) => void;
}

export interface ProviderProfileLoginFlow {
  readonly mode: ProviderProfileLoginFlowMode;
  readonly state: ProviderProfileLoginFlowState;
  /** Either of the flow's own mutations in flight. */
  readonly busy: boolean;
  /** `providers.startLogin` specifically - the "queued behind another
   *  sign-in" wording only applies while this mutation, not `awaitLogin`,
   *  is pending. */
  readonly startPending: boolean;
  readonly start: (options: {
    readonly label: string | null;
    readonly shareSkillsAndPlugins: boolean;
  }) => void;
  readonly cancel: () => void;
  /** `providers.cancelLogin`'s own pending state, for the Cancel button's
   *  UX (gui-app AGENTS.md pending recipe: `disabled` + unchanged label +
   *  inline spinner, never a swapped label). Distinct from `busy` /
   *  `startPending`, which never cover this mutation. */
  readonly cancelPending: boolean;
  /**
   * A pasted code has crossed (or is crossing) the one-shot commit boundary.
   * Cancelling now would kill the provider child mid-exchange and burn the
   * code. Derived from the submit mutation and active waiting attempt; never
   * mirrored in local state.
   */
  readonly commitPending: boolean;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
}

/**
 * Shared OAuth login-flow state machine (multi-profile UX overhaul, S10):
 * owns the start -> starting -> waiting -> identity | failed transitions,
 * including cancellation before `startLogin` returns, and the three provider
 * login mutations shared by the add-profile dialog, the inline Settings
 * reauth panel, and the in-chat reauth banner's ambient OAuth reconnect.
 *
 * The banner's OAuth reconnect passes `mode: "reauth"` with
 * `existingProfileId: null` (the ambient, no-profile-picker identity that
 * predates per-profile management) - `beginLogin` runs the full
 * waiting/code-paste machinery against it exactly like a known-profile
 * reauth, but success is judged differently (see `settleAttempt`): the
 * ambient case has no profile row to check, only the re-probed top-level
 * `state.auth.status`, and a successful resolution returns straight to
 * `start` instead of `identity` - the caller's own live subscription (the
 * reauth gate) reacts to the re-probed auth status on its own, matching
 * the ambient flow's pre-code-paste `onSettled` behavior.
 *
 * Also owns the code-paste sub-flow within `waiting` (code-paste decision
 * log): submitting a pasted code, a throttled keepalive, and bounded
 * auto-restart when the host reports the submitted code was rejected or the
 * login child already died. This never introduces a new top-level state -
 * the paste field is always visible within `waiting` per that decision
 * log's "Paste field visibility" row. `settleAttempt` is the two-sided join
 * that decides what a `waiting` attempt resolves to once `awaitLogin` and
 * `submitLoginCode` have both had a chance to weigh in - see its own doc
 * comment for the exact rules (fixup review findings 1 and 2).
 *
 * Callers render their own UI per `state.kind`; profile naming/coloring stays
 * outside this machine. Callers remain conditionally mounted so closing
 * discards the flow state and late mutation callbacks cannot leak into a
 * later attempt.
 */
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
  // Mirrors `attemptIdRef` for render-safe reads (`codePaste.attemptId` is
  // read during render, where refs must not be touched). `attemptIdRef`
  // stays the source of truth for the async "is this callback stale"
  // comparisons inside mutation callbacks, which run outside render.
  const [attemptId, setAttemptId] = useState(0);
  const cancelRequestedRef = useRef(false);
  // Latches once `cancelProfile` fires for this flow - a boolean rather than
  // the cancelled profile id itself, since the ambient case's profileId is
  // legitimately `null` and would otherwise collide with this ref's own
  // "nothing cancelled yet" initial value.
  const cancelledRef = useRef(false);
  const restartCountRef = useRef(0);
  const attemptIdRef = useRef(0);
  // Two-sided settlement join for the current attempt (see `settleAttempt`'s
  // doc comment): `awaitLogin` and `submitLoginCode` can resolve in either
  // order, so each side latches its own verdict into one of these refs and
  // calls the shared arbiter - never acts unilaterally. Reset per attempt in
  // `beginLogin`, never compared across attempts.
  const awaitOutcomeRef = useRef<"authenticated" | "notAuthenticated" | null>(
    null,
  );
  const submitOutcomeRef = useRef<
    "none" | "pending" | "accepted" | "noActiveLogin"
  >("none");
  // The authenticated payload to resolve to, captured at the moment
  // `awaitOutcomeRef` is set to `"authenticated"` - `settleAttempt` may run
  // again later (a late `submitLoginCode` resolution re-invoking the
  // arbiter after success already latched) and needs it without a second
  // copy of `result` in scope.
  const successPayloadRef = useRef<{
    readonly profile: ProviderProfile;
    readonly profiles: readonly ProviderProfile[];
    readonly existingProfileId: string | null;
  } | null>(null);
  const lastTouchAtRef = useRef(0);
  // Pending timer for the bounded ambient `authPending` re-poll (see
  // `scheduleAuthPendingRepoll` inside `beginLogin`). Cleared on every fresh
  // attempt, on cancellation, and on unmount so a late tick can never
  // re-await a superseded or abandoned attempt.
  const repollTimerRef = useRef<number | null>(null);
  // Latched by the unmount cleanup below so a re-poll already in flight at
  // unmount cannot schedule its successor.
  const unmountedRef = useRef(false);
  const lastStartOptionsRef = useRef<{
    readonly label: string | null;
    readonly shareSkillsAndPlugins: boolean;
  }>({ label: null, shareSkillsAndPlugins: false });
  // Forwarding ref breaks the `restart` <-> `beginLogin` cycle: `restart`
  // must be declared before `beginLogin` (which depends on it), so it can't
  // reference `beginLogin` directly.
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

  // Unmount-only cleanup: callers conditionally unmount to discard the flow
  // (the Settings panel's reauth section, and the in-chat banner the moment
  // its reauth gate clears), and a re-poll surviving that would keep
  // re-awaiting a discarded attempt. Clearing the timer alone is not enough:
  // an already-dispatched `awaitOnce` resolves after unmount, and a
  // still-pending verdict would arm a fresh timer on a dead hook - so the
  // unmount is latched into `attemptAbandoned` too. Reset on every effect run
  // rather than only at declaration: StrictMode's dev double-invoke unmounts
  // and remounts, which would otherwise leave this latched on for good.
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
      // Reauth always targets a real login child - a specific profile, or
      // the ambient/no-profile-picker identity when `existingProfileId` is
      // null (the in-chat banner's OAuth reconnect). Create mode's `null`
      // means the host never minted a profile-scoped child, so there is
      // nothing to cancel.
      if (mode === "reauth" || profileId !== null) cancelProfile(profileId);
      Analytics.getInstance().track(
        AnalyticsEvent.ProviderProfileLinkCancelled,
        { provider: providerId, mode },
      );
      setState({ kind: "cancelled" });
    },
    [cancelProfile, clearRepollTimer, mode, providerId],
  );

  // The blocker is classified from the REAL error at each call site (or an
  // explicit bounded value for error-less outcomes), never from the display
  // message - UI copy like "Sign-in did not…" would misclassify everything
  // as `authentication`.
  const fail = useCallback(
    (message: string, blocker: AnalyticsBlocker): void => {
      // Flow-level failures otherwise surface only as inline dialog copy -
      // log them so a failed sign-in/switch is diagnosable from the desktop
      // log after the fact.
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

  /**
   * Auto-restart entry point, invoked from `settleAttempt` (the
   * `codeRejected` case) or directly from `beginLogin`'s `awaitLogin`
   * `onSuccess` (the `codeRejected` fast path, which is unconditional and
   * does not wait on anything else).
   */
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

  /**
   * Two-sided settlement join for the current attempt (fixup review
   * finding 1): `awaitLogin` and `submitLoginCode` can resolve in either
   * order, and neither side may act alone on a `noActiveLogin`/not-yet-
   * authenticated verdict - only this shared arbiter decides, after both
   * sides have latched what they know into `awaitOutcomeRef` /
   * `submitOutcomeRef`. Called again whenever either ref changes, so a late
   * verdict (whichever side resolves second) always gets a chance to settle
   * the attempt instead of being silently dropped.
   *
   * - `awaitOutcomeRef` unset: `awaitLogin` hasn't resolved yet - nothing to
   *   decide regardless of `submitOutcomeRef`.
   * - `"authenticated"`: terminal success, always - resolves immediately and
   *   ignores `submitOutcomeRef` entirely (fixup review finding 2: this is
   *   the host's re-probed auth status, explicitly checked in `beginLogin`,
   *   never just "a profile row is present" - `providers.list` keeps rows
   *   for signed-out profiles too).
   * - `"notAuthenticated"`: only a `submitOutcomeRef` of `"noActiveLogin"`
   *   triggers the bounded restart; `"pending"` waits for that submit to
   *   resolve before deciding anything; `"accepted"` or `"none"` (no
   *   code-paste submit is relevant to this outcome) lands on the ordinary
   *   not-finished path - `failed` for a profile-aware flow, a quiet
   *   `start` for the ambient banner reconnect (matching its pre-code-paste
   *   `onSettled` behavior).
   */
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
      // Statefulness fixup: without this, a restart's fresh `CodePasteField`
      // (remounted via `key={attemptId}`) would still render the PREVIOUS
      // attempt's `submitError`/pending flags off the shared mutation
      // object, since TanStack Query mutation state otherwise persists
      // across separate `.mutate()` calls on the same hook instance.
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
            // Reauth always awaits the profile it was invoked for - the
            // response never mints a different id for an existing profile.
            // Create has no id until this response supplies one.
            const nextProfileId =
              mode === "reauth" ? existingProfileId : data.profileId;
            if (cancelRequestedRef.current) {
              finishCancellation(nextProfileId);
              return;
            }
            // Create mode must have a minted profile id to proceed; reauth
            // mode never derives `nextProfileId` from this response (it is
            // always the caller's own `existingProfileId`, including the
            // ambient `null`), so there is nothing to validate there beyond
            // `data.started`.
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
            // Per-attempt budget for the ambient `authPending` re-poll (see
            // the constant's doc comment). Scoped to this attempt's closure -
            // an auto-restart mints a fresh attempt with a fresh budget.
            let authPendingRepolls = 0;
            // A resolution this attempt must no longer act on: a later attempt
            // (auto-restart, or the child finishing while a restart was
            // already triggered) superseded this long-poll, the flow was
            // cancelled, or the hook unmounted. Clearing the re-poll timer
            // cannot recall an already-dispatched RPC, and neither cancelling
            // nor unmounting touches `attemptIdRef` - so without the other two
            // halves a re-poll landing afterward would settle the attempt
            // (overwriting the terminal `cancelled` state with a failure) or
            // arm a fresh timer on a dead hook.
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
  // Keeps the forwarding ref current after render commits (never during
  // render, per the `react-hooks/refs` rule) - `restart` only invokes it
  // from inside async mutation callbacks, well after the first commit.
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
      // `state.profileId` may be `null` in the ambient reauth case - the
      // request still carries it (the wire contract's `profileId` is
      // nullable exactly for this), so no extra guard is needed here.
      if (state.kind !== "waiting") return;
      const thisAttemptId = attemptIdRef.current;
      // Marks this attempt's submit verdict in flight *before* the request
      // goes out: if `awaitLogin` resolves not-authenticated while this is
      // still pending, `settleAttempt` must wait for the real verdict
      // instead of failing early (fixup review finding 1's lost-update race).
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
            // An RPC-level failure carries no "no active child" verdict -
            // treat it like "accepted" (nothing more to wait for) so a
            // `notAuthenticated` await isn't left waiting on this submit
            // forever.
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

  // Keep the provider child alive throughout the browser-approval leg. Users
  // may spend several minutes in account pickers or 2FA before interacting
  // with the fallback field; field-only touches would let the host's rolling
  // deadline expire first. The host's hard cap still bounds an abandoned but
  // open flow, while leaving `waiting` synchronously clears this interval.
  useEffect(() => {
    if (state.kind !== "waiting" || !codePasteEnabled) return;
    const intervalId = window.setInterval(
      touch,
      CODE_PASTE_KEEPALIVE_INTERVAL_MS,
    );
    return () => window.clearInterval(intervalId);
  }, [codePasteEnabled, state.kind, touch]);

  // Render-facing status comes directly from the submit mutation. A successful
  // relay remains in the checking phase while this top-level flow is still in
  // `waiting`; `awaitLogin` moves the flow away from that state when the real
  // exchange settles. `reset()` keeps prior attempts from leaking forward.
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
