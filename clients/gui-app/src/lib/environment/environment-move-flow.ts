import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import { recordMoveAcceptance } from "@traycer-clients/shared/environment/move-acceptance";
import type {
  EnvironmentMoveOutcomeAnswer,
  EnvironmentMoveStageRequest,
  EnvironmentMoveStageResponse,
  EnvironmentMoveStartRequest,
  EnvironmentMoveStaysChoice,
  EnvironmentOperationTarget,
} from "@traycer/protocol/host/environment/move-contracts";

/**
 * The two host calls a move or a give makes after the person's click, on the
 * computer that moves. Reading the plan is not one of them: it draws the
 * sheet and can never stage or end an attempt.
 */
export interface EnvironmentMoveHost {
  readonly stage: (
    request: EnvironmentMoveStageRequest,
  ) => Promise<EnvironmentMoveStageResponse>;
  readonly start: (
    request: EnvironmentMoveStartRequest,
  ) => Promise<EnvironmentMoveOutcomeAnswer>;
}

/** What the person accepted: the computer, where it goes, and the drawn plan. */
export interface EnvironmentMoveAcceptance {
  readonly hostId: string;
  readonly target: EnvironmentOperationTarget;
  readonly planHash: string;
  readonly keyChoices: readonly EnvironmentMoveStaysChoice[];
}

/**
 * - `started`: the computer has the acceptance and moves itself; what it
 *   answered at once is `outcome`, and `environment.status` carries it on.
 * - `plan_changed`: what the computer staged is not the list the person
 *   read, so nothing was accepted and the sheet reads the plan again.
 * - `not_awaiting`: the computer has no move waiting.
 * - `refused`: authn did not take the acceptance.
 */
export type EnvironmentMoveResult =
  | {
      readonly kind: "started";
      readonly outcome: EnvironmentMoveOutcomeAnswer;
    }
  | { readonly kind: "plan_changed" }
  | { readonly kind: "not_awaiting" }
  | { readonly kind: "refused" };

/** Every choice is `stays`, so the same keys in the same order are the same choices. */
function sameChoices(
  staged: readonly EnvironmentMoveStaysChoice[],
  sent: readonly EnvironmentMoveStaysChoice[],
): boolean {
  return (
    staged.length === sent.length &&
    staged.every((choice, index) => choice.key === sent[index]?.key)
  );
}

/** Whether the computer staged exactly what the person accepted. */
function stagedAsAccepted(
  staged: EnvironmentMoveStageResponse,
  accepted: EnvironmentMoveAcceptance,
): boolean {
  const { evidence } = staged;
  const target = accepted.target;
  return (
    evidence.planHash === accepted.planHash &&
    evidence.sourceHostId === accepted.hostId &&
    evidence.targetKind === target.kind &&
    evidence.environmentId === target.environmentId &&
    (evidence.targetKind !== "team" ||
      (target.kind === "team" && evidence.teamId === target.teamId)) &&
    sameChoices(evidence.keyChoices, accepted.keyChoices)
  );
}

function isNotAwaiting(error: unknown): boolean {
  return error instanceof HostRpcError && error.code === "E_MOVE_NOT_AWAITING";
}

/**
 * The person's click on a move or a give: the computer stages the accepted
 * list, the app records the acceptance at authn on the person's sign-in, and
 * then hands the computer that acceptance. The computer moves itself; the app
 * never asks it to record the consent.
 *
 * Throws what a call throws, other than the computer's `E_MOVE_NOT_AWAITING`.
 */
export async function runEnvironmentMove(
  host: EnvironmentMoveHost,
  cloud: EnvironmentCloud,
  accepted: EnvironmentMoveAcceptance,
): Promise<EnvironmentMoveResult> {
  try {
    const staged = await host.stage({
      target: accepted.target,
      keyChoices: [...accepted.keyChoices],
    });
    if (!stagedAsAccepted(staged, accepted)) return { kind: "plan_changed" };
    const acceptance = await recordMoveAcceptance(
      cloud,
      accepted.hostId,
      staged,
    );
    if (acceptance.kind === "refused") return { kind: "refused" };
    const outcome = await host.start({
      attemptId: staged.evidence.attemptId,
      planHash: staged.evidence.planHash,
      acceptanceId: acceptance.acceptanceId,
    });
    return { kind: "started", outcome };
  } catch (error) {
    if (isNotAwaiting(error)) return { kind: "not_awaiting" };
    throw error;
  }
}
