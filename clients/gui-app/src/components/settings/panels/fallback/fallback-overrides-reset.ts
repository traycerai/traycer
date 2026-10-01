import type { FallbackPolicy } from "@traycer/protocol/host/fallback-policy";
import type { HostNotificationStoppedReason } from "@traycer/protocol/host/notifications/payloads";
import { FALLBACK_REASON_LABELS } from "@traycer/protocol/host/notifications/presentation";
import {
  fallbackPolicyValuesEqual,
  fallbackSaveInFlight,
  type FallbackPolicyDraftState,
} from "./fallback-policy-draft";

export interface OverrideReset {
  readonly requestId: number;
  readonly reason: HostNotificationStoppedReason | null;
  readonly previous: FallbackPolicy;
  readonly next: FallbackPolicy;
}

export interface OverrideResetUndo {
  readonly message: string;
  readonly disabled: boolean;
}

export function overrideResetUndoState(
  state: FallbackPolicyDraftState,
  reset: OverrideReset | null,
): OverrideResetUndo | null {
  if (
    reset === null ||
    state.unknownSave !== null ||
    state.unrefreshedReset !== null ||
    state.unverifiedHostRow !== null ||
    state.hostError !== null ||
    state.localError !== null ||
    !fallbackPolicyValuesEqual(state.draft, reset.next)
  )
    return null;
  const pending = state.pendingSaves.some(
    (save) => save.requestId === reset.requestId,
  );
  const confirmed =
    state.confirmedViewRevision === state.revision &&
    fallbackPolicyValuesEqual(state.draft, state.persisted);
  if (!pending && !confirmed) return null;
  const subject =
    reset.reason === null
      ? "All problems"
      : FALLBACK_REASON_LABELS[reset.reason];
  const message = pending
    ? "Saving the reset…"
    : `${subject} ${reset.reason === null ? "now follow" : "now follows"} the main plan.`;
  return { message, disabled: pending || fallbackSaveInFlight(state) };
}

/** A current, acknowledged view only; errors and older acknowledgments stay quiet. */
export function overrideChangesSaved(state: FallbackPolicyDraftState): boolean {
  return (
    !fallbackSaveInFlight(state) &&
    state.unknownSave === null &&
    state.unrefreshedReset === null &&
    state.unverifiedHostRow === null &&
    state.hostError === null &&
    state.localError === null &&
    state.confirmedViewRevision === state.revision &&
    fallbackPolicyValuesEqual(state.draft, state.persisted)
  );
}
