import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { TuiForkProfileAdmissionSubcode } from "@traycer/protocol/host/agent/tui/unary-schemas";

/**
 * Thrown when the cross-profile fork-admission preflight rejects a launch, before any worktree/binding work has run.
 * Carries the same subcode as the authoritative prepare-launch guard so both outcomes share one UI mapper.
 */
export class TuiForkProfileRejectedError extends Error {
  readonly subcode: TuiForkProfileAdmissionSubcode;
  constructor(subcode: TuiForkProfileAdmissionSubcode, message: string) {
    super(message);
    this.name = "TuiForkProfileRejectedError";
    this.subcode = subcode;
  }
}

/**
 * A cross-profile fork/continue rejection, resolved into copy the dialog can render inline (tech plan "Rejection UX": inline dialog alert, dialog stays open).
 * `residueNote` is populated ONLY for a late (`agent.tui.prepareLaunch`) rejection - the authoritative guard's own message, which may carry the host's static retained-worktree disclosure sentence (`FORK_REJECTION_RESIDUE_DISCLOSURE` in.
 */
export interface TuiForkRejectionView {
  readonly message: string;
  readonly residueNote: string | null;
}

const LATE_GUARD_SUBCODES: ReadonlyArray<TuiForkProfileAdmissionSubcode> = [
  "SCOPE_MISMATCH",
  "FORK_SOURCE_NOT_FOUND",
  "FORK_SOURCE_AMBIGUOUS",
  "SOURCE_NOT_READY",
];

/**
 * Resolves a caught error from a continue/cross-profile fork submit into dialog copy, or `null` when the error isn't a fork-profile-admission rejection at all (e.g. a worktree failure) - the caller renders no inline alert for those and relies on the.
 */
export function resolveTuiForkRejectionView(
  error: unknown,
  labels: { readonly targetLabel: string; readonly sourceLabel: string },
): TuiForkRejectionView | null {
  if (error instanceof TuiForkProfileRejectedError) {
    return buildRejectionView(error.subcode, labels, null);
  }
  const lateGuard = parseLateGuardRejection(error);
  if (lateGuard !== null) {
    return buildRejectionView(lateGuard.subcode, labels, lateGuard.detail);
  }
  return null;
}

function parseLateGuardRejection(error: unknown): {
  readonly subcode: TuiForkProfileAdmissionSubcode;
  readonly detail: string;
} | null {
  if (!(error instanceof HostRpcError)) return null;
  if (error.method !== "agent.tui.prepareLaunch") return null;
  for (const subcode of LATE_GUARD_SUBCODES) {
    const prefix = `${subcode}: `;
    if (error.message.startsWith(prefix)) {
      return { subcode, detail: error.message.slice(prefix.length) };
    }
  }
  return parseProfileLifecycleRejection(error);
}

/**
 * The four fixed message templates `profile-resolver.ts`'s lifecycle-error classes construct (`ProfileNotFoundError`/`ProfileTombstonedError`/ `ProfileSetupPendingError`/`ProfileNotSupportedByProviderError`), matched loosely enough to survive the.
 */
const PROFILE_LIFECYCLE_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /^No profile ".*" is registered for provider ".*"\./,
  /^Profile ".*" for provider ".*" was removed and can no longer be used\./,
  /^Profile ".*" for provider ".*" is still completing setup and cannot be used yet\./,
  /^Provider ".*" does not support managed profiles\./,
];

function parseProfileLifecycleRejection(error: HostRpcError): {
  readonly subcode: TuiForkProfileAdmissionSubcode;
  readonly detail: string;
} | null {
  // The lifecycle family maps to `RPC_ERROR` on the wire (`handler.ts`'s batch-2 400 branch), never `E_INVALID_ARGUMENT` (reserved for `TuiForkScopeGuardError`'s `InvalidArgumentError` base) - checking it narrows the message-pattern match to the failure family.
  if (error.code !== "RPC_ERROR") return null;
  const matches = PROFILE_LIFECYCLE_MESSAGE_PATTERNS.some((pattern) =>
    pattern.test(error.message),
  );
  if (!matches) return null;
  return { subcode: "TARGET_PROFILE_UNAVAILABLE", detail: error.message };
}

function buildRejectionView(
  subcode: TuiForkProfileAdmissionSubcode,
  labels: { readonly targetLabel: string; readonly sourceLabel: string },
  residueNote: string | null,
): TuiForkRejectionView {
  switch (subcode) {
    case "SCOPE_MISMATCH":
      return {
        message: `Can't continue this session under ${labels.targetLabel}. It doesn't share conversation history with ${labels.sourceLabel}. Choose a shared profile, or start a new terminal agent.`,
        residueNote,
      };
    case "TARGET_PROFILE_UNAVAILABLE":
      return {
        message: `Can't continue this session under ${labels.targetLabel}. That profile isn't available right now - it may be signed out, still finishing setup, or no longer supported. Choose a different profile, or start a new terminal agent.`,
        residueNote,
      };
    case "FORK_SOURCE_NOT_FOUND":
    case "FORK_SOURCE_AMBIGUOUS":
      return {
        message:
          "Can't continue this session - the source terminal agent couldn't be identified. Close and reopen this tab, then try again.",
        residueNote,
      };
    case "SOURCE_NOT_READY":
      return {
        message:
          "This session has no conversation yet - send a message before forking.",
        residueNote,
      };
  }
}
