/**
 * What the UI is allowed to say about ONE outstanding write command, and which
 * actions it may offer.
 *
 * Pure, so the six states can be pinned without rendering anything. The rules
 * it encodes are not stylistic - each state is a different fact about WHERE the
 * write is, and collapsing any two of them tells the user something untrue:
 *
 * - `queued` is accepted locally and NOT sent. Nothing durable holds it, so the
 *   copy must not imply it is saved anywhere.
 * - `sending` is in flight.
 * - `unknown-outcome` is sent with no answer. The queue NEVER auto-retries it
 *   (see `command-overlay.ts`), so it must not read as in-flight - and retry is
 *   the user's decision to take, never one this surface takes for them.
 * - `rejected` is the authority refusing. Terminal.
 * - `superseded` is a remote merge winning. Terminal, and reachable FROM
 *   `committed`, so a record can be superseded after it was committed.
 * - `committed` is HOST-committed, never "saved": a commit is one host's
 *   statement, and a concurrent write from another host can still supersede it.
 *
 * `E_EPIC_READ_ONLY` is pulled out of `rejected` as its own stage. It is a
 * distinct host verdict - the epic cannot be written at all, so retrying is
 * futile rather than merely unlikely - and old hosts never emit it.
 */
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";

/** The host's verdict when the epic itself refuses writes. Non-retryable. */
const READ_ONLY_CODE = "E_EPIC_READ_ONLY";

export type EpicWriteCommandStage =
  | "queued"
  | "sending"
  | "unknown-outcome"
  | "committed"
  | "rejected"
  | "read-only"
  | "superseded";

export interface EpicWriteCommandPresentation {
  readonly stage: EpicWriteCommandStage;
  /** Short status, shown beside the change. */
  readonly statusLabel: string;
  /**
   * The sentence under it. For an authority verdict this is the HOST's own
   * message, never a client-side paraphrase - `CommandResolution.reason` is
   * specified as "human-readable, from the authority. Never synthesised
   * client-side."
   */
  readonly detail: string;
  /**
   * Whether to OFFER a retry. Never a trigger to take one: an
   * `unknown-outcome` command may already have been applied, and the whole
   * reason the queue leaves it alone is that only the user can decide to
   * re-issue it.
   */
  readonly canRetry: boolean;
  /**
   * Whether the record can be acknowledged away. Terminal records only - the
   * queue refuses to discard a pending one, because removing the overlay while
   * the write is still in flight is a silent rollback wearing a different hat.
   *
   * This is the affordance that keeps the sync indicator honest: a terminal
   * record stays in the queue until the user clears it, so WITHOUT a way to
   * clear it the indicator could never legitimately go green again.
   */
  readonly canDiscard: boolean;
}

/** What the user asked for, in their words rather than the wire's. */
export function describeEpicWriteCommandIntent(
  intent: EpicWriteCommandIntent,
): string {
  switch (intent.kind) {
    case "rename-artifact":
      return `Rename to “${intent.title}”`;
    case "delete-artifact":
      return "Delete";
    case "reparent-artifact":
      return intent.parentId === null ? "Move to top level" : "Move";
    case "update-artifact-status":
      return "Change status";
    case "update-epic-title":
      return `Rename epic to “${intent.title}”`;
  }
}

export function presentEpicWriteCommand(
  command: CommandRecord<EpicWriteCommandIntent>,
): EpicWriteCommandPresentation {
  // Delivery is read BEFORE state: an `unknown-outcome` command is still
  // `pending`, and reporting it as pending is exactly the over-claim this
  // stage exists to prevent - nothing is in flight and nothing will be
  // without the user.
  if (command.delivery === "unknown-outcome") {
    return {
      stage: "unknown-outcome",
      statusLabel: "Outcome unknown",
      detail:
        "This was sent, but its result never came back, so it may or may not have been applied. It is not retried automatically.",
      canRetry: true,
      canDiscard: false,
    };
  }
  switch (command.state) {
    case "pending":
      return command.delivery === "sending"
        ? {
            stage: "sending",
            statusLabel: "Sending",
            detail: "This change is on its way to the host.",
            canRetry: false,
            canDiscard: false,
          }
        : {
            stage: "queued",
            statusLabel: "Not sent yet",
            detail:
              "This change is waiting in this window and has not reached the host. Keep the window open until it sends.",
            canRetry: false,
            canDiscard: false,
          };
    case "committed":
      return presentCommitted(command.resolution);
    case "rejected":
      return presentRejected(command.resolution);
    case "superseded":
      return {
        stage: "superseded",
        statusLabel: "Replaced",
        detail:
          "A newer change from another device replaced this one. Make it again if you still want it.",
        canRetry: false,
        canDiscard: true,
      };
  }
}

/**
 * `hostId` names the machine that committed it, and the copy says so. A commit
 * is host-committed, not epic-global: shared epics have several participants
 * whose hosts write the same epic, so UX language must never imply the change
 * is durable everywhere.
 */
function presentCommitted(
  resolution: CommandRecord<EpicWriteCommandIntent>["resolution"],
): EpicWriteCommandPresentation {
  const host =
    resolution !== null && resolution.kind === "committed"
      ? resolution.hostId
      : null;
  return {
    stage: "committed",
    statusLabel: "Applied by the host",
    detail:
      host === null
        ? "The host applied this change. A change from another device can still replace it."
        : `Host ${host} applied this change. A change from another device can still replace it.`,
    canRetry: false,
    canDiscard: true,
  };
}

function presentRejected(
  resolution: CommandRecord<EpicWriteCommandIntent>["resolution"],
): EpicWriteCommandPresentation {
  if (resolution === null || resolution.kind !== "rejected") {
    return {
      stage: "rejected",
      statusLabel: "Refused",
      detail: "The host refused this change.",
      canRetry: false,
      canDiscard: true,
    };
  }
  if (resolution.code === READ_ONLY_CODE) {
    return {
      stage: "read-only",
      statusLabel: "This epic is read-only",
      detail: resolution.reason,
      // Never a retry: read-only is a property of the epic, not a transient
      // failure, so re-sending the same change can only be refused again.
      canRetry: false,
      canDiscard: true,
    };
  }
  return {
    stage: "rejected",
    statusLabel: "Refused",
    detail: resolution.reason,
    canRetry: resolution.retryable,
    canDiscard: true,
  };
}
