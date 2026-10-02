import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  useProfileCopyLoginAwaitMutation,
  useProfileCopyLoginCancelMutation,
  useProfileCopyLoginStartMutation,
  useProfileCopyLoginSubmitCodeMutation,
  useProfileCopyLoginTouchMutation,
} from "@/hooks/providers/profile-copy/use-profile-copy-login-mutations";
import { profileCopyDraftStatusKey } from "@/hooks/providers/profile-copy/profile-copy-cache";
import type {
  ProfileCopyAttempt,
  ProfileCopyLoginChallenge,
  ProfileCopyLoginResponse,
  ProfileCopyOutcome,
  ProfileCopyReason,
} from "@/lib/profile-copy/profile-copy-model";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import type { ProviderProfileLoginFlowCodePaste } from "../use-provider-profile-login-flow";

/** A live sign-in is touched this often so it does not expire while watched. */
const LOGIN_TOUCH_INTERVAL_MS = 60_000;

export type ProfileImportLoginPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | {
      readonly kind: "waiting";
      readonly loginAttemptId: string;
      readonly challenge: ProfileCopyLoginChallenge | null;
    };

/**
 * Why the last sign-in did not start, finish or stop, for the panel to say
 * once. None of it is persisted. A refusal BEFORE any login job (no
 * `loginAttemptId`) is not here: it is recorded in the flow store as a direct
 * block, keyed by the verb and the draft revision it answered at (Q4
 * ruling), so it outlives this component and the panel can count repeats.
 */
export type ProfileImportLoginNotice =
  | { readonly kind: "stale"; readonly revision: number }
  /** A sign-in another window or device started is still running there. */
  | { readonly kind: "elsewhere"; readonly revision: number }
  | { readonly kind: "unfinished" }
  | { readonly kind: "lost" }
  /** `login.start` failed: nothing started here, nothing to cancel. */
  | { readonly kind: "start-failed"; readonly error: HostRpcError }
  /**
   * `login.start` reserved a login job and it ended before any challenge: a
   * configuration refusal (T5 contract 8), a runner that did not start, or a
   * rejected login URL. The host moved the revision to reserve and complete
   * the job's writer, so this is not bound to one; it holds until the next
   * start, and never counts as a repeat.
   */
  | { readonly kind: "start-refused"; readonly reason: ProfileCopyReason }
  /** `login.cancel` failed: the sign-in may still be live, so the step stays. */
  | { readonly kind: "cancel-failed" };

export interface ProfileImportLoginFlow {
  readonly phase: ProfileImportLoginPhase;
  readonly notice: ProfileImportLoginNotice | null;
  /** The reason of a `start-refused` notice while it holds, or `null`. */
  readonly startRefusal: ProfileCopyReason | null;
  /** Another destination's sign-in holds this window's one interactive slot. */
  readonly blockedByOtherLogin: boolean;
  readonly startPending: boolean;
  readonly cancelPending: boolean;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  /** Starts, or attaches to the live sign-in, at the revision the user saw. */
  readonly start: (expectedRevision: number) => void;
  /** Cancels the sign-in AND the draft - see `useProfileCopyLoginCancelMutation`. */
  readonly cancel: () => void;
  readonly dismissNotice: () => void;
}

/** What an answer that started nothing says, when it is not a refusal. */
function notStartedNotice(
  outcome: ProfileCopyOutcome,
): ProfileImportLoginNotice {
  return outcome.state === "signing-in"
    ? { kind: "elsewhere", revision: outcome.revision }
    : { kind: "stale", revision: outcome.revision };
}

function isRefusal(outcome: ProfileCopyOutcome): boolean {
  return outcome.state === "blocked" || outcome.reason !== null;
}

/**
 * The reason a `login.start` answer that DID reserve a login job carries
 * when that job ended before any challenge, or `null`. The host builds a
 * challenge only when it has no reason (profile-import-login-service.ts
 * `begin`), so a reason beside a null challenge means nothing is left to
 * sign in to.
 */
function startedJobRefusal(
  response: ProfileCopyLoginResponse,
): ProfileCopyReason | null {
  return response.challenge === null ? response.outcome.reason : null;
}

function startRefusalOf(
  notice: ProfileImportLoginNotice | null,
): ProfileCopyReason | null {
  return notice !== null && notice.kind === "start-refused"
    ? notice.reason
    : null;
}

/**
 * The import sign-in, driven only by the user:
 *
 * - `start` sends `login.start` at the revision the user was shown. The host
 *   attaches to a live job rather than starting a second one.
 * - A refusal with no `loginAttemptId` came before any login job: it is
 *   recorded for that revision, the draft is read again (the host never
 *   persists a refusal), and nothing is sent again.
 * - A reason with a `loginAttemptId` and no challenge means the job was
 *   reserved and already ended (a configuration refusal, a runner that did
 *   not start, a rejected URL). It is kept as a `start-refused` notice, the
 *   draft is read again, and `login.await` is NOT sent: the job is over, and
 *   an await on a finished job answers with whatever verification the host
 *   runs next (or runs one itself), overwriting the reason.
 * - Otherwise `login.await` waits for verification to finish; `login.touch`
 *   keeps a watched sign-in alive every minute. Every control verb carries
 *   the latest revision a previous answer returned.
 * - Nothing restarts itself. Closing leaves the sign-in running on the device
 *   until it expires, and releases this window's interactive slot.
 *
 * Every callback here depends only on the mutations' `mutate` / `reset`,
 * which are stable for the component's life, and reads the attempt through a
 * ref. The panel re-renders at least once a minute (its host labels tick,
 * the draft polls); a callback rebuilt by those renders would re-arm the
 * keepalive interval before it could ever fire. Each verb is `reset()` once
 * it settles, so no challenge or pasted code stays in the MutationCache.
 */
export function useProfileImportLoginFlow(
  attempt: ProfileCopyAttempt,
): ProfileImportLoginFlow {
  const queryClient = useQueryClient();
  const loginStart = useProfileCopyLoginStartMutation(attempt);
  const loginAwait = useProfileCopyLoginAwaitMutation(attempt);
  const loginTouch = useProfileCopyLoginTouchMutation(attempt);
  const loginSubmitCode = useProfileCopyLoginSubmitCodeMutation(attempt);
  const loginCancel = useProfileCopyLoginCancelMutation(attempt);
  const { mutate: startMutate, reset: startReset } = loginStart;
  const { mutate: awaitMutate, reset: awaitReset } = loginAwait;
  const { mutate: touchMutate, reset: touchReset } = loginTouch;
  const { mutate: submitMutate, reset: submitReset } = loginSubmitCode;
  const { mutate: cancelMutate, reset: cancelReset } = loginCancel;
  const claimLogin = useProfileCopyFlowStore((state) => state.claimLogin);
  const releaseLogin = useProfileCopyFlowStore((state) => state.releaseLogin);
  const recordDirectBlock = useProfileCopyFlowStore(
    (state) => state.recordDirectBlock,
  );
  const clearDirectBlock = useProfileCopyFlowStore(
    (state) => state.clearDirectBlock,
  );
  const blockedByOtherLogin = useProfileCopyFlowStore(
    (state) =>
      state.activeLogin !== null &&
      state.activeLogin.attemptId !== attempt.attemptId,
  );
  const [phase, setPhase] = useState<ProfileImportLoginPhase>({ kind: "idle" });
  const [notice, setNotice] = useState<ProfileImportLoginNotice | null>(null);
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<HostRpcError | null>(null);
  const [loginRound, setLoginRound] = useState(0);
  // The revision the NEXT control verb must carry: every answer moves it.
  const revisionRef = useRef<number | null>(null);
  // The attempt is immutable for one attemptId, but its object is rebuilt by
  // every read; a ref keeps that identity churn out of the callbacks below.
  const attemptRef = useRef(attempt);
  useEffect(() => {
    attemptRef.current = attempt;
  }, [attempt]);
  const attemptId = attempt.attemptId;
  const destinationHostId = attempt.destinationHostId;

  const settle = useCallback(() => {
    revisionRef.current = null;
    setPhase({ kind: "idle" });
    setCodeSubmitted(false);
    setSubmitError(null);
    releaseLogin(attemptId);
  }, [attemptId, releaseLogin]);

  // Closing the surface releases the slot; the sign-in itself keeps running
  // on the device until it expires - closing is never cancelling.
  useEffect(() => () => releaseLogin(attemptId), [attemptId, releaseLogin]);

  // The host never persists a refusal: the next read says what the draft
  // actually is, and the recorded block or notice explains the refusal.
  const rereadDraft = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: profileCopyDraftStatusKey({ attempt: attemptRef.current }),
    });
  }, [queryClient]);

  const refuse = useCallback(
    (outcome: ProfileCopyOutcome) => {
      recordDirectBlock(attemptId, {
        verb: "sign-in",
        revision: outcome.revision,
        reason: outcome.reason,
      });
      rereadDraft();
    },
    [attemptId, recordDirectBlock, rereadDraft],
  );

  const awaitLogin = useCallback(
    (expectedRevision: number, loginAttemptId: string) => {
      awaitMutate(
        { attempt: attemptRef.current, expectedRevision, loginAttemptId },
        {
          onSuccess: (settled) => {
            awaitReset();
            if (settled.outcome.state === "sign-in-required") {
              setNotice({ kind: "unfinished" });
            }
            settle();
          },
          onError: () => {
            awaitReset();
            // The wait broke, not necessarily the sign-in: re-read the
            // draft and say so. Nothing is started again.
            setNotice({ kind: "lost" });
            rereadDraft();
            settle();
          },
        },
      );
    },
    [awaitMutate, awaitReset, rereadDraft, settle],
  );

  const start = useCallback(
    (expectedRevision: number) => {
      if (!claimLogin({ destinationHostId, attemptId })) return;
      setNotice(null);
      setCodeSubmitted(false);
      setSubmitError(null);
      setPhase({ kind: "starting" });
      startMutate(
        { attempt: attemptRef.current, expectedRevision },
        {
          onSuccess: (response) => {
            startReset();
            const outcome = response.outcome;
            revisionRef.current = outcome.revision;
            const loginAttemptId = response.loginAttemptId;
            if (loginAttemptId === null) {
              if (isRefusal(outcome)) refuse(outcome);
              else setNotice(notStartedNotice(outcome));
              settle();
              return;
            }
            const refusal = startedJobRefusal(response);
            if (refusal !== null) {
              // The job was reserved and is already over (R2-1): say why,
              // never await it, and leave any recorded block and its
              // repeat count alone.
              setNotice({ kind: "start-refused", reason: refusal });
              rereadDraft();
              settle();
              return;
            }
            clearDirectBlock(attemptId, "sign-in");
            setLoginRound((round) => round + 1);
            setPhase({
              kind: "waiting",
              loginAttemptId,
              challenge: response.challenge,
            });
            awaitLogin(outcome.revision, loginAttemptId);
          },
          onError: (error) => {
            startReset();
            setNotice({ kind: "start-failed", error });
            settle();
          },
        },
      );
    },
    [
      attemptId,
      awaitLogin,
      claimLogin,
      clearDirectBlock,
      destinationHostId,
      refuse,
      rereadDraft,
      settle,
      startMutate,
      startReset,
    ],
  );

  const waitingLoginAttemptId =
    phase.kind === "waiting" ? phase.loginAttemptId : null;

  const touch = useCallback(() => {
    const expectedRevision = revisionRef.current;
    if (waitingLoginAttemptId === null || expectedRevision === null) return;
    touchMutate(
      {
        attempt: attemptRef.current,
        expectedRevision,
        loginAttemptId: waitingLoginAttemptId,
      },
      {
        onSuccess: (response) => {
          touchReset();
          revisionRef.current = response.outcome.revision;
        },
        onError: () => touchReset(),
      },
    );
  }, [touchMutate, touchReset, waitingLoginAttemptId]);

  // External-system sync: a watched sign-in is kept alive on the device.
  // `touch` changes only when the waited-on sign-in does, so a re-render
  // never re-arms this.
  useEffect(() => {
    if (waitingLoginAttemptId === null) return;
    const handle = window.setInterval(touch, LOGIN_TOUCH_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [touch, waitingLoginAttemptId]);

  const submit = useCallback(
    (code: string) => {
      const expectedRevision = revisionRef.current;
      if (waitingLoginAttemptId === null || expectedRevision === null) return;
      setSubmitError(null);
      submitMutate(
        {
          attempt: attemptRef.current,
          expectedRevision,
          loginAttemptId: waitingLoginAttemptId,
          code,
        },
        {
          onSuccess: (response) => {
            submitReset();
            revisionRef.current = response.outcome.revision;
            setCodeSubmitted(true);
          },
          onError: (error) => {
            submitReset();
            setSubmitError(error);
          },
        },
      );
    },
    [submitMutate, submitReset, waitingLoginAttemptId],
  );

  const cancel = useCallback(() => {
    const expectedRevision = revisionRef.current;
    if (waitingLoginAttemptId === null || expectedRevision === null) return;
    setNotice(null);
    cancelMutate(
      {
        attempt: attemptRef.current,
        expectedRevision,
        loginAttemptId: waitingLoginAttemptId,
      },
      {
        onSuccess: () => {
          cancelReset();
          settle();
        },
        onError: () => {
          // The sign-in may still be live on the device: keep the step, and
          // its Cancel, and say the cancel did not land.
          cancelReset();
          setNotice({ kind: "cancel-failed" });
        },
      },
    );
  }, [cancelMutate, cancelReset, settle, waitingLoginAttemptId]);

  let codePhase: ProviderProfileLoginFlowCodePaste["phase"] = "idle";
  if (loginSubmitCode.isPending) codePhase = "submitting";
  else if (codeSubmitted) codePhase = "verifying";

  return {
    phase,
    notice,
    startRefusal: startRefusalOf(notice),
    blockedByOtherLogin,
    startPending: loginStart.isPending,
    cancelPending: loginCancel.isPending,
    codePaste: {
      enabled:
        phase.kind === "waiting" && phase.challenge?.kind === "code-paste",
      attemptId: loginRound,
      restartNotice: null,
      phase: codePhase,
      submitError,
      submit,
      touch,
    },
    start,
    cancel,
    dismissNotice: () => setNotice(null),
  };
}
