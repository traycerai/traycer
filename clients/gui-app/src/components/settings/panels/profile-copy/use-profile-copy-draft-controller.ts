import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { profileCopyDraftStatusKey } from "@/hooks/providers/profile-copy/profile-copy-cache";
import {
  useProfileCopyCancelDraftMutation,
  useProfileCopyConfirmIdentityMutation,
  useProfileCopyConfirmVerificationMutation,
  useProfileCopySetPreferenceMutation,
  useProfileCopyVerifyMutation,
} from "@/hooks/providers/profile-copy/use-profile-copy-draft-mutations";
import type {
  ProfileCopyAttempt,
  ProfileCopyDraftResponse,
  ProfileCopyOutcome,
} from "@/lib/profile-copy/profile-copy-model";
import type { ProfileCopyDraftAction } from "@/lib/profile-copy/profile-copy-presentation";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopySettingsNavigation } from "./profile-copy-shared";
import type { ProfileImportLoginFlow } from "./use-profile-import-login-flow";

/**
 * What a draft verb's answer needs said, at the revision it answered:
 *
 * - `stale-revision` / `unavailable`: the verb was not applied;
 * - `verify-unread` / `verify-timeout`: Verify ran but could not read the
 *   copied settings, or the provider did not answer in time, and nothing was
 *   checked (T5 contracts 4 and 6). A later read says only "pending", so this
 *   is the one place either is ever said.
 */
export interface DraftAnswerNotice {
  readonly kind:
    | "stale-revision"
    | "unavailable"
    | "verify-unread"
    | "verify-timeout";
  readonly revision: number;
}

export type PendingConfirm = "cancel-draft" | "cancel-sign-in";

export interface ProfileCopyDraftController {
  readonly answerNotice: DraftAnswerNotice | null;
  readonly requestError: HostRpcError | null;
  readonly pendingConfirm: PendingConfirm | null;
  /** Another attempt's sign-in holds this window's one interactive slot. */
  readonly otherLoginHostId: string | null;
  readonly anyPending: boolean;
  /** The "use it once ready" switch cannot be changed right now. */
  readonly preferenceDisabled: boolean;
  readonly cancelPending: boolean;
  readonly runAction: (action: ProfileCopyDraftAction) => void;
  readonly actionPending: (action: ProfileCopyDraftAction) => boolean;
  readonly actionDisabled: (action: ProfileCopyDraftAction) => boolean;
  readonly setPreference: (desiredEnabled: boolean) => void;
  readonly requestCancel: (confirm: PendingConfirm) => void;
  readonly dismissCancel: () => void;
  readonly confirmCancel: () => void;
}

/** A current Verify answer that checked nothing, or `null`. */
function uncheckedVerifyNotice(
  outcome: ProfileCopyOutcome,
): DraftAnswerNotice | null {
  if (
    outcome.state !== "verification-pending" ||
    outcome.readiness.verification !== "not-checked"
  ) {
    return null;
  }
  return {
    kind:
      outcome.reason === "verification-timeout"
        ? "verify-timeout"
        : "verify-unread",
    revision: outcome.revision,
  };
}

export function isProfileCopySignInAction(
  action: ProfileCopyDraftAction,
): boolean {
  return action.kind === "sign-in" || action.kind === "continue-sign-in";
}

/**
 * The draft verbs one destination-recorded draft offers. Every verb dials
 * `attempt.destinationHostId` (captured with the attempt) and carries the
 * revision on screen; an answer other than `current` is kept as a notice for
 * that revision and never sent again on the user's behalf.
 */
export function useProfileCopyDraftController(
  attempt: ProfileCopyAttempt,
  outcome: ProfileCopyOutcome,
  login: ProfileImportLoginFlow,
): ProfileCopyDraftController {
  const attemptId = attempt.attemptId;
  const queryClient = useQueryClient();
  const navigation = useProfileCopySettingsNavigation();
  const recordDirectBlock = useProfileCopyFlowStore(
    (state) => state.recordDirectBlock,
  );
  const clearDirectBlock = useProfileCopyFlowStore(
    (state) => state.clearDirectBlock,
  );
  const otherLoginHostId = useProfileCopyFlowStore((state) =>
    state.activeLogin !== null && state.activeLogin.attemptId !== attemptId
      ? state.activeLogin.destinationHostId
      : null,
  );

  const verify = useProfileCopyVerifyMutation(attempt);
  const confirmVerification =
    useProfileCopyConfirmVerificationMutation(attempt);
  const confirmIdentity = useProfileCopyConfirmIdentityMutation(attempt);
  const setPreferenceMutation = useProfileCopySetPreferenceMutation(attempt);
  const cancelDraft = useProfileCopyCancelDraftMutation(attempt);

  const [answerNotice, setAnswerNotice] = useState<DraftAnswerNotice | null>(
    null,
  );
  const [requestError, setRequestError] = useState<HostRpcError | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null,
  );

  const onAnswer = (response: ProfileCopyDraftResponse): void => {
    setRequestError(null);
    if (response.result !== "current") {
      setAnswerNotice({
        kind: response.result,
        revision: response.outcome.revision,
      });
    }
  };
  const answerHandlers = {
    onSuccess: onAnswer,
    onError: (error: HostRpcError) => setRequestError(error),
  };
  const beginAction = (): void => {
    setAnswerNotice(null);
    setRequestError(null);
  };

  const onVerifyAnswer = (response: ProfileCopyDraftResponse): void => {
    onAnswer(response);
    if (response.result !== "current") return;
    const answered = response.outcome;
    if (answered.state !== "blocked") {
      clearDirectBlock(attemptId, "verify");
      setAnswerNotice(uncheckedVerifyNotice(answered));
      return;
    }
    // Refused before any check ran (T5 contracts 5 and 7): a direct answer
    // only, never stored by the host. Remember it against the Verify click
    // at THIS revision, then read what the draft actually is.
    recordDirectBlock(attemptId, {
      verb: "verify",
      revision: answered.revision,
      reason: answered.reason,
    });
    void queryClient.invalidateQueries({
      queryKey: profileCopyDraftStatusKey({ attempt }),
    });
  };

  const onVerify = (): void => {
    beginAction();
    verify.mutate(
      { attempt, expectedRevision: outcome.revision },
      { onSuccess: onVerifyAnswer, onError: answerHandlers.onError },
    );
  };

  const onUseWithoutVerification = (): void => {
    const verificationRevision = outcome.readiness.verificationRevision;
    if (verificationRevision === null) return;
    beginAction();
    confirmVerification.mutate(
      {
        attempt,
        expectedRevision: outcome.revision,
        verificationRevision,
        decision: "accept-indeterminate",
      },
      answerHandlers,
    );
  };

  const onConfirmIdentity = (
    decision: "accept-mismatch" | "accept-unavailable",
  ): void => {
    const identityRevision = outcome.readiness.identityRevision;
    if (identityRevision === null) return;
    beginAction();
    confirmIdentity.mutate(
      {
        attempt,
        expectedRevision: outcome.revision,
        identityRevision,
        decision,
      },
      answerHandlers,
    );
  };

  const setPreference = (desiredEnabled: boolean): void => {
    beginAction();
    setPreferenceMutation.mutate(
      { attempt, expectedRevision: outcome.revision, desiredEnabled },
      answerHandlers,
    );
  };

  const confirmCancel = (): void => {
    // This window drives the sign-in: cancel it by its login id. Otherwise
    // the draft itself, at the revision on screen. Both cancel the draft.
    if (pendingConfirm === "cancel-sign-in" && login.phase.kind === "waiting") {
      login.cancel();
      setPendingConfirm(null);
      return;
    }
    beginAction();
    cancelDraft.mutate(
      { attempt, expectedRevision: outcome.revision },
      {
        onSuccess: onAnswer,
        onError: answerHandlers.onError,
        onSettled: () => setPendingConfirm(null),
      },
    );
  };

  const targetProfileId = outcome.targetProfileId;
  const runAction = (action: ProfileCopyDraftAction): void => {
    switch (action.kind) {
      case "sign-in":
      case "continue-sign-in":
        beginAction();
        login.start(outcome.revision);
        return;
      case "cancel-sign-in":
      case "cancel-draft":
        setPendingConfirm(action.kind);
        return;
      case "verify":
        onVerify();
        return;
      case "use-without-verification":
        onUseWithoutVerification();
        return;
      case "keep-account":
        onConfirmIdentity("accept-mismatch");
        return;
      case "add-without-confirming":
        onConfirmIdentity("accept-unavailable");
        return;
      case "open-profile":
        if (targetProfileId === null) return;
        navigation.openDestinationProfile({
          destinationHostId: attempt.destinationHostId,
          provider: attempt.providerId,
          profileId: targetProfileId,
        });
        return;
    }
  };

  const cancelPending = cancelDraft.isPending || login.cancelPending;
  const actionPending = (action: ProfileCopyDraftAction): boolean => {
    switch (action.kind) {
      case "sign-in":
      case "continue-sign-in":
        return login.startPending;
      case "verify":
        return verify.isPending;
      case "use-without-verification":
        return confirmVerification.isPending;
      case "keep-account":
      case "add-without-confirming":
        return confirmIdentity.isPending;
      case "cancel-draft":
      case "cancel-sign-in":
        return cancelPending;
      case "open-profile":
        return false;
    }
  };
  const anyPending =
    verify.isPending ||
    confirmVerification.isPending ||
    confirmIdentity.isPending ||
    setPreferenceMutation.isPending ||
    cancelPending ||
    login.startPending;
  // A preference write moves the draft's revision, and every sign-in control
  // verb (submit code, keepalive, cancel) carries the revision the last login
  // answer returned, so a write under a live sign-in leaves the next one
  // stale and the host refuses it. The switch waits out a sign-in: this
  // window's from the moment it starts (the draft read lags it), and one
  // another window or device drives (the record says `signing-in`).
  const preferenceDisabled =
    anyPending || login.phase.kind !== "idle" || outcome.state === "signing-in";
  const actionDisabled = (action: ProfileCopyDraftAction): boolean => {
    if (action.kind === "open-profile") return targetProfileId === null;
    if (isProfileCopySignInAction(action) && otherLoginHostId !== null) {
      return true;
    }
    return anyPending;
  };

  return {
    answerNotice,
    requestError,
    pendingConfirm,
    otherLoginHostId,
    anyPending,
    preferenceDisabled,
    cancelPending,
    runAction,
    actionPending,
    actionDisabled,
    setPreference,
    requestCancel: setPendingConfirm,
    dismissCancel: () => setPendingConfirm(null),
    confirmCancel,
  };
}
