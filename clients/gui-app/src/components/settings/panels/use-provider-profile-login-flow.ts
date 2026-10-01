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
  type ProviderLoginRefusal,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  providerLoginAnswerHeldForNobody,
  providerLoginAnswerHoldsLogin,
  providerLoginAnswerStillStarting,
  providerLoginAnswerWantsPackRetry,
  providerLoginNotStartedMessage,
  providerLoginStartCopy,
  startProviderLoginUntilSettled,
  waitForProviderLoginStart,
  type ProviderLoginStartCopy,
  type ProviderLoginStartProgress,
  type ProviderStartLoginAnswer,
} from "@/components/providers/provider-login-start";
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
export type EnsurePackMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.ensurePack">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.ensurePack">,
  LoginMutationContext
>;

export type ProviderProfileLoginFlowMode = "create" | "reauth";

export type ProviderProfileLoginFlowState =
  | { readonly kind: "start" }
  | {
      readonly kind: "starting";
      readonly cancelRequested: boolean;
      /** What the host is doing meanwhile - see `ProviderLoginStartProgress`. */
      readonly progress: ProviderLoginStartProgress;
    }
  | {
      readonly kind: "waiting";
      readonly profileId: string | null;
      readonly url: string | null;
      readonly userCode: string | null;
    }
  | {
      readonly kind: "identity";
      readonly profileId: string;
      readonly profile: ProviderProfile;
      readonly profiles: readonly ProviderProfile[];
      readonly existingProfileId: string | null;
    }
  | {
      readonly kind: "failed";
      readonly message: string;
      /**
       * The provider refused the sign-in after the browser leg, in its own
       * words (`message` is its reason then), with where it sends the user to
       * resolve it. Null for every failure the flow words itself.
       */
      readonly refusal: ProviderLoginRefusal | null;
    }
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
  | { readonly kind: "refused"; readonly refusal: ProviderLoginRefusal }
  | { readonly kind: "codeRejected" }
  | { readonly kind: "authPending" }
  | { readonly kind: "notAuthenticated" };

/**
 * The provider refused the sign-in (`providers.awaitLogin@2.2`). Decided
 * before anything the re-probed state says: the host sends no state with a
 * refusal, and over an account that was already signed in a state would only
 * describe the previous account. A host before 2.2 reports none.
 */
function refusedAwaitResult(
  result: AwaitLoginResult,
): AwaitLoginResolution | null {
  const refusal = result.refusal ?? null;
  return refusal === null ? null : { kind: "refused", refusal };
}

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
  const refused = refusedAwaitResult(result);
  if (refused !== null) return refused;
  if (result.state?.auth.status === "authenticated") {
    return { kind: "authenticated", payload: null };
  }
  if (result.codeRejected) return { kind: "codeRejected" };
  if (result.state !== null && isAmbientAuthVerdictPending(result.state)) {
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
  const refused = refusedAwaitResult(result);
  if (refused !== null) return refused;
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

/**
 * Why a final `providers.startLogin` answer is not a started sign-in, or null
 * when it is one.
 *
 * `profileMissing` is create mode's own requirement: a started login with no
 * minted profile id is nothing the flow can await.
 *
 * An answer that still says `pending: "starting"` is this side having stopped
 * asking, not the host having given up: the login child is still alive, and
 * whoever stops waiting for it releases it.
 */
function startAnswerRefusal(
  answer: ProviderStartLoginAnswer,
  profileMissing: boolean,
): {
  readonly blocker: AnalyticsBlocker;
  readonly releaseHostLogin: boolean;
} | null {
  const failure = answer.failure ?? null;
  if (failure !== null) {
    return {
      blocker: failure === "device_code_missing" ? "timeout" : "authentication",
      releaseHostLogin: false,
    };
  }
  if (answer.started && !profileMissing) return null;
  // The RPC succeeded but the host declined to start the login: the provider
  // tooling is the limiting factor, not auth.
  const gaveUp = providerLoginAnswerStillStarting(answer);
  return {
    blocker: gaveUp ? "timeout" : "provider_unavailable",
    releaseHostLogin: gaveUp,
  };
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
  | "idle"
  | "submitting"
  | "verifying";

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
  readonly supportsLoginOwnership: boolean;
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
  /** Fetches the provider's pack again. Only ever called from `start`, i.e.
   *  from a press, and only when the previous attempt ended on a failed
   *  install that a retry can move. */
  readonly ensurePack: EnsurePackMutation;
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
   *  sign-in" wording only applies while this request, not `awaitLogin`,
   *  is pending. Read from the flow's `starting` state, not the mutation's
   *  `isPending` (see the note above the return). */
  readonly startPending: boolean;
  /**
   * What to say while `startPending` when the start is taking longer than a
   * moment - the provider's pack is downloading, or its login child is still
   * coming up. Null while "Opening the sign-in page…" still describes it.
   */
  readonly startingCopy: ProviderLoginStartCopy | null;
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
    supportsLoginOwnership,
    mode,
    providerId,
    existingProfileId,
    loginCapability,
    startLogin,
    awaitLogin,
    cancelLogin,
    submitLoginCode,
    touchLogin,
    ensurePack,
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
  // Latches once `cancelProfile` sends a release for this attempt - a boolean
  // rather than the cancelled profile id itself, since the ambient case's
  // profileId is legitimately `null` and would otherwise collide with this
  // ref's own "nothing cancelled yet" initial value. Reopened by
  // `cancelProfile` when that release fails, so a later path can send it
  // again; `cancelRequestedRef` is what keeps the attempt abandoned meanwhile.
  const cancelledRef = useRef(false);
  // Whether the release `cancelledRef` stands for is still in flight, and the
  // release a later path asked for while it was: the start answer that lands
  // during a pending cancel names the profile the host actually holds, and a
  // cancel that then fails is retried for that profile rather than only
  // reopening the latch after the answer has already been consumed.
  const releaseInFlightRef = useRef(false);
  const deferredReleaseRef = useRef<{
    readonly profileId: string | null;
  } | null>(null);
  // Releases the user asked for that the host never acknowledged: a holder
  // whose cancel call failed with nothing left in its attempt to send it
  // again - the start answer had already landed, or a fresh press had
  // already moved the attempt on. Kept by holder rather than by attempt,
  // since the attempt is what the next press replaces; drained at that press
  // before its own attempt begins, and at unmount. Only ownership holders
  // belong here: a legacy release is a scope cancel, and sent at the next
  // press it would end the very login that press attaches to.
  const owedReleasesRef = useRef<
    ReadonlyArray<{
      readonly holderId: string;
      readonly profileId: string | null;
    }>
  >([]);
  // `finishCancellation` can now be reached twice for one press: once from
  // `cancel` itself, and again when a start call that was already in flight
  // answers. The second visit may still have a login to cancel on the host;
  // it has nothing left to report.
  const cancellationReportedRef = useRef(false);
  // The target the host is holding a live login for while the flow is still
  // `starting` - known from the first "still starting" answer onwards. Until
  // then a cancel has to wait for the start call to say what it started.
  const liveLoginRef = useRef<{ readonly profileId: string | null } | null>(
    null,
  );
  // The answer the last attempt ended on, read by the next press to decide
  // whether the provider's pack has to be fetched again first.
  const lastAnswerRef = useRef<ProviderStartLoginAnswer | null>(null);
  const restartCountRef = useRef(0);
  const attemptIdRef = useRef(0);
  // Latched at the press: later handshakes must not change the cancellation
  // policy of a start already sent anonymously to an older host.
  const holderIdRef = useRef<string | null>(null);
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
      retryPackFirst: boolean,
    ) => void
  >(() => {});
  // Same shape for `settleOwedReleases`: the unmount cleanup below must call
  // it without depending on it, or the mutation's own state changes would
  // re-run that effect and drain the owed releases mid-flow.
  const settleOwedReleasesRef = useRef<() => void>(() => {});

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
      settleOwedReleasesRef.current();
    };
  }, [clearRepollTimer]);

  const oweRelease = useCallback(
    (holderId: string, profileId: string | null): void => {
      owedReleasesRef.current = [
        ...owedReleasesRef.current.filter(
          (release) => release.holderId !== holderId,
        ),
        { holderId, profileId },
      ];
    },
    [],
  );

  // Sends every owed release once more, best effort: the host keys a
  // holder's cancel by the holder alone, so one that already landed is a
  // no-op there, and one that fails again is owed again for the next press
  // or the unmount. The hook's own `onError` toasts each failure.
  const settleOwedReleases = useCallback((): void => {
    const owed = owedReleasesRef.current;
    if (owed.length === 0) return;
    owedReleasesRef.current = [];
    for (const release of owed) {
      void cancelLogin
        .mutateAsync({
          providerId,
          profileId: release.profileId,
          holderId: release.holderId,
        })
        .then(
          () => {},
          () => {
            oweRelease(release.holderId, release.profileId);
          },
        );
    }
  }, [cancelLogin, oweRelease, providerId]);

  const cancelProfile = useCallback(
    (profileId: string | null): void => {
      // A holder can release a create attempt before its profile ID arrives.
      // Legacy create has no safe scope to cancel until the host names one;
      // legacy reauth's null profile is the ambient scope.
      const holderId = holderIdRef.current;
      if (holderId === null && mode !== "reauth" && profileId === null) return;
      if (cancelledRef.current) {
        // A release is already on its way, or has landed. What this path
        // learned - usually the profile the start answer named - is kept
        // while that release is still in flight, so one that fails can be
        // sent again for it; once a release has landed there is nothing
        // left to retry.
        if (releaseInFlightRef.current) {
          deferredReleaseRef.current = { profileId };
        }
        return;
      }
      cancelledRef.current = true;
      const thisAttemptId = attemptIdRef.current;
      // The latch means "a release is on its way", not "released": the flow
      // already reads `cancelled` by now, so nothing the user can press would
      // send another. A cancel call that fails leaves this attempt's claim on
      // the host. If a later path asked for a release while this one was in
      // flight, that release is sent now with what it learned; otherwise the
      // latch reopens for the next path that learns what the attempt holds -
      // the start answer still in flight, or the unmount cleanup - and a
      // holder's release is owed besides, since a settled attempt has no such
      // path left and a fresh press replaces the attempt without one. Sent
      // with `mutateAsync`, not `mutate` with an `onError`: the promise is
      // the mutation's own `execute()` and settles after the caller unmounts
      // too, where per-`mutate` callbacks are dropped (see `beginLogin`). The
      // hook's own `onError` still toasts.
      const send = (target: string | null): void => {
        releaseInFlightRef.current = true;
        deferredReleaseRef.current = null;
        if (holderId !== null) {
          owedReleasesRef.current = owedReleasesRef.current.filter(
            (release) => release.holderId !== holderId,
          );
        }
        void cancelLogin
          .mutateAsync({ providerId, profileId: target, holderId })
          .then(
            () => {
              if (attemptIdRef.current !== thisAttemptId) return;
              releaseInFlightRef.current = false;
              deferredReleaseRef.current = null;
            },
            () => {
              const owe = (): void => {
                if (holderId === null) return;
                oweRelease(holderId, target);
                // A hook that has already unmounted has no press and no
                // cleanup left to drain what it owes, so the one retry it
                // gets goes now; the drain's own failure only re-owes.
                if (unmountedRef.current) settleOwedReleasesRef.current();
              };
              if (attemptIdRef.current !== thisAttemptId) {
                // A fresh press has already reset the attempt's refs; the
                // claim this call failed to release is still the host's.
                owe();
                return;
              }
              releaseInFlightRef.current = false;
              const deferred = deferredReleaseRef.current;
              if (deferred !== null) {
                send(deferred.profileId);
                return;
              }
              owe();
              cancelledRef.current = false;
            },
          );
      };
      send(profileId);
    },
    [cancelLogin, mode, oweRelease, providerId],
  );

  // The user-visible half of a cancel: the flow is over as far as this
  // surface is concerned. Once per press, however many paths arrive here.
  const reportCancellation = useCallback((): void => {
    clearRepollTimer();
    if (cancellationReportedRef.current) return;
    cancellationReportedRef.current = true;
    Analytics.getInstance().track(AnalyticsEvent.ProviderProfileLinkCancelled, {
      provider: providerId,
      mode,
    });
    setState({ kind: "cancelled" });
  }, [clearRepollTimer, mode, providerId]);

  const finishCancellation = useCallback(
    (profileId: string | null): void => {
      cancelProfile(profileId);
      reportCancellation();
    },
    [cancelProfile, reportCancellation],
  );

  // The blocker is classified from the REAL error at each call site (or an
  // explicit bounded value for error-less outcomes), never from the display
  // message - UI copy like "Sign-in did not…" would misclassify everything
  // as `authentication`.
  const fail = useCallback(
    (
      message: string,
      blocker: AnalyticsBlocker,
      refusal: ProviderLoginRefusal | null,
    ): void => {
      // Flow-level failures otherwise surface only as inline dialog copy -
      // log them so a failed sign-in/switch is diagnosable from the desktop
      // log after the fact.
      appLogger.warn("[provider-login] flow failed", {
        provider: providerId,
        mode,
        blocker,
        // Provider-authored refusal text can contain account identifiers.
        // Keep it in the UI; the host already records it at DEBUG.
        message: refusal === null ? message : "Provider refused sign-in",
      });
      Analytics.getInstance().track(AnalyticsEvent.ProviderProfileLinkFailed, {
        provider: providerId,
        mode,
        blocker,
      });
      setState({ kind: "failed", message, refusal });
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
        fail(CODE_PASTE_RESTART_LIMIT_MESSAGES[cause], "timeout", null);
        return;
      }
      restartCountRef.current += 1;
      beginLoginRef.current(
        lastStartOptionsRef.current,
        CODE_PASTE_RESTART_NOTICES[cause],
        false,
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
      fail(failureMessages.notFinished, "authentication", null);
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
      retryPackFirst: boolean,
    ): void => {
      lastStartOptionsRef.current = options;
      // A fresh attempt supersedes any pending ambient re-poll tick.
      clearRepollTimer();
      attemptIdRef.current += 1;
      const thisAttemptId = attemptIdRef.current;
      const holderId = supportsLoginOwnership ? crypto.randomUUID() : null;
      holderIdRef.current = holderId;
      cancelledRef.current = false;
      releaseInFlightRef.current = false;
      deferredReleaseRef.current = null;
      awaitOutcomeRef.current = null;
      submitOutcomeRef.current = "none";
      successPayloadRef.current = null;
      liveLoginRef.current = null;
      lastAnswerRef.current = null;
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
      setState({
        kind: "starting",
        cancelRequested: false,
        progress: { kind: "opening" },
      });
      // The outcome travels on `mutateAsync`'s promise, never on per-`mutate`
      // callbacks. The Settings reauth panel starts this from a MOUNT effect,
      // and under StrictMode (every dev build) that effect's setup -> cleanup
      // -> setup unsubscribes the mutation's observer in between: TanStack
      // then detaches the observer from the mutation already in flight and
      // never re-attaches it. Its per-`mutate` callbacks are dropped and its
      // `isPending` stays true for good, while the hook's own `onError` toast
      // still fires - the dialog sat on "Opening the sign-in page…" under a
      // "Couldn't start the sign-in flow" toast. The promise is the mutation's
      // own `execute()`, which settles whatever its observer is doing.
      //
      // Per-`mutate` callbacks were also dropped once the caller unmounted,
      // and a superseded attempt never heard its answer; the guard below keeps
      // both of those, so an answer nobody is waiting for still stops here.
      const startAbandoned = (): boolean =>
        attemptIdRef.current !== thisAttemptId || unmountedRef.current;
      // One question is not always the whole start: the host answers
      // `pending` while the provider's pack downloads or its login child is
      // still coming up, and the same question asked again attaches to that
      // work. `startProviderLoginUntilSettled` keeps asking; what arrives
      // here is the answer that ended it.
      void startProviderLoginUntilSettled({
        request: {
          providerId,
          holderId,
          profileId: existingProfileId,
          createProfile:
            mode === "create"
              ? {
                  label: options.label ?? "",
                  shareSkillsAndPlugins: options.shareSkillsAndPlugins,
                }
              : null,
        },
        startLogin: (request) => startLogin.mutateAsync(request),
        ensurePack: () => ensurePack.mutateAsync({ providerId }),
        retryPackFirst,
        onProgress: (progress, answer) => {
          if (startAbandoned()) return;
          if (progress.kind === "launching") {
            liveLoginRef.current = {
              profileId:
                mode === "reauth" ? existingProfileId : answer.profileId,
            };
          }
          setState({
            kind: "starting",
            cancelRequested: cancelRequestedRef.current,
            progress,
          });
        },
        shouldStop: () => startAbandoned() || cancelRequestedRef.current,
        wait: waitForProviderLoginStart,
      }).then(
        (data) => {
          // A newer attempt asks the same question and attaches to the same
          // login, so whatever this answer holds is that attempt's now.
          if (attemptIdRef.current !== thisAttemptId) return;
          // Reauth always awaits the profile it was invoked for - the
          // response never mints a different id for an existing profile.
          // Create has no id until this response supplies one.
          const nextProfileId =
            mode === "reauth" ? existingProfileId : data.profileId;
          // Ahead of the unmount check: a Cancel pressed while the pack was
          // downloading ends the flow at once (`cancel`), and the dialog can
          // be gone by the time the call already on its way answers - with a
          // login it started, and a profile it minted, that only this cancel
          // releases. Only a login the answer holds is released: an answer
          // that the pack is still preparing, or that the host did not start
          // one, left nothing there, and an ambient reauth's cancel is keyed
          // by the provider alone, so it would end a login another surface
          // started for the same account.
          if (cancelRequestedRef.current) {
            if (providerLoginAnswerHoldsLogin(data)) {
              cancelProfile(nextProfileId);
            }
            reportCancellation();
            return;
          }
          if (unmountedRef.current) {
            // Nobody will open this login's page or wait for it. Only a
            // provider that opens its own page keeps its login: that page may
            // be open in a browser, where the user can still finish.
            if (providerLoginAnswerHeldForNobody(data, loginCapability)) {
              cancelProfile(nextProfileId);
            }
            return;
          }
          lastAnswerRef.current = data;
          // Create mode must have a minted profile id to proceed; reauth
          // mode never derives `nextProfileId` from this response (it is
          // always the caller's own `existingProfileId`, including the
          // ambient `null`), so there is nothing to validate there beyond
          // `data.started`.
          const refusal = startAnswerRefusal(
            data,
            mode === "create" && nextProfileId === null,
          );
          if (refusal !== null) {
            if (refusal.releaseHostLogin) cancelProfile(nextProfileId);
            fail(
              providerLoginNotStartedMessage(
                data,
                providerId,
                failureMessages.notStarted,
              ),
              refusal.blocker,
              null,
            );
            return;
          }
          liveLoginRef.current = null;
          setState({
            kind: "waiting",
            profileId: nextProfileId,
            url: data.url,
            // Test doubles (and a body that skipped 1.2 parse) omit the
            // field; treat missing as "no device code" so the paste field
            // still renders for Claude.
            userCode: data.userCode ?? null,
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
            // Final, whatever a pasted code is still doing: the provider has
            // already turned this account away, and the ambient reconnect
            // must say so too rather than return quietly to `start`.
            if (resolution.kind === "refused") {
              fail(
                resolution.refusal.reason,
                "authentication",
                resolution.refusal,
              );
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
        // Every rejection is consumed here, abandoned or not; the hook's own
        // `onError` has already toasted it. The second argument of `then`,
        // not a `catch`, so a throw in the success arm above is never
        // misread as a refused start.
        (error: unknown) => {
          if (startAbandoned()) return;
          if (cancelRequestedRef.current) {
            // A failed start names no login to cancel. Ownership callers
            // already released their claim at the press; legacy callers
            // must not turn this failure into an ambient scope cancel.
            reportCancellation();
            return;
          }
          fail(
            failureMessages.notStarted,
            analyticsBlockerFromError(error),
            null,
          );
        },
      );
    },
    [
      awaitLogin,
      cancelProfile,
      clearRepollTimer,
      ensurePack,
      existingProfileId,
      fail,
      failureMessages,
      loginCapability,
      mode,
      providerId,
      reportCancellation,
      restart,
      settleAttempt,
      startLogin,
      supportsLoginOwnership,
      submitLoginCode,
      touchLogin,
    ],
  );
  // Keeps the forwarding ref current after render commits (never during
  // render, per the `react-hooks/refs` rule) - `restart` only invokes it
  // from inside async mutation callbacks, well after the first commit.
  useEffect(() => {
    beginLoginRef.current = beginLogin;
    settleOwedReleasesRef.current = settleOwedReleases;
  });

  const start = useCallback(
    (options: {
      readonly label: string | null;
      readonly shareSkillsAndPlugins: boolean;
    }): void => {
      // `starting`, not `startLogin.isPending`: see `busy` below.
      if (
        state.kind === "starting" ||
        state.kind === "waiting" ||
        awaitLogin.isPending
      ) {
        return;
      }
      // Ahead of the fresh attempt: a holder the last attempt failed to
      // release is sent again now, before this press claims a new one.
      settleOwedReleases();
      cancelRequestedRef.current = false;
      cancelledRef.current = false;
      releaseInFlightRef.current = false;
      deferredReleaseRef.current = null;
      cancellationReportedRef.current = false;
      restartCountRef.current = 0;
      Analytics.getInstance().track(AnalyticsEvent.ProviderProfileLinkStarted, {
        source: "direct_ui",
        provider: providerId,
        mode,
      });
      // A press that follows a failed install asks for the pack again first.
      // This is the one place that may: it runs from a press and nowhere
      // else, which is what `providers.ensurePack` takes as the user's say-so.
      beginLogin(
        options,
        null,
        providerLoginAnswerWantsPackRetry(lastAnswerRef.current),
      );
    },
    [
      awaitLogin.isPending,
      beginLogin,
      mode,
      providerId,
      settleOwedReleases,
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
    if (holderIdRef.current !== null && state.kind !== "start") {
      const profileId =
        state.kind === "waiting"
          ? state.profileId
          : (liveLoginRef.current?.profileId ?? existingProfileId);
      finishCancellation(profileId);
      return;
    }
    if (state.kind === "starting") {
      if (mode === "reauth" && existingProfileId !== null) {
        finishCancellation(existingProfileId);
        return;
      }
      // The host has said which login it is holding: cancel that one now
      // rather than after the call attached to it gives up its wait.
      const liveLogin = liveLoginRef.current;
      if (liveLogin !== null) {
        finishCancellation(liveLogin.profileId);
        return;
      }
      // Nothing is running on the host while the pack downloads, so there
      // is nothing to cancel there yet - and sending the cancel anyway would
      // spend the one this flow gets. A question already on its way may
      // still start a login; that one is cancelled when its answer lands
      // (`beginLogin`).
      if (state.progress.kind === "downloading") {
        reportCancellation();
        return;
      }
      setState({
        kind: "starting",
        cancelRequested: true,
        progress: state.progress,
      });
      return;
    }
    if (state.kind === "waiting") {
      finishCancellation(state.profileId);
      return;
    }
    if (state.kind === "start") {
      // The panel can close before its first start effect runs. It owns no
      // login at that point, even if the profile's ID is already known.
      reportCancellation();
    }
  }, [
    commitPending,
    existingProfileId,
    finishCancellation,
    mode,
    reportCancellation,
    state,
  ]);

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

  // The start leg's pending flag is `starting`, never `startLogin.isPending`.
  // `beginLogin` enters `starting` right before `mutateAsync`, and only that
  // promise's answer leaves it (or a known-profile reauth cancel, which
  // unmounts its panel with it). Where the observer was detached (see
  // `beginLogin`), `isPending` instead stays true forever: it would pin the
  // step on "Opening the sign-in page…" and keep Retry disabled.
  return {
    mode,
    state,
    busy: state.kind === "starting" || awaitLogin.isPending,
    startPending: state.kind === "starting",
    startingCopy:
      state.kind === "starting"
        ? providerLoginStartCopy(state.progress, providerId)
        : null,
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
