import { HostRpcError } from "../host-transport/host-messenger";
import type { EnvironmentCloud } from "./environment-cloud";
import { recordMoveAcceptance } from "./move-acceptance";
import type {
  EnvironmentMoveOutcomeAnswer,
  EnvironmentMovePersonal,
  EnvironmentMoveStageRequest,
  EnvironmentMoveStageResponse,
  EnvironmentMoveStartRequest,
  EnvironmentMoveStaysChoice,
  EnvironmentOperationTarget,
} from "@traycer/protocol/host/environment/move-contracts";

/** Reading the plan is not one of them: it can never stage or end an attempt. */
export interface EnvironmentMoveHost {
  readonly stage: (
    request: EnvironmentMoveStageRequest,
  ) => Promise<EnvironmentMoveStageResponse>;
  readonly start: (
    request: EnvironmentMoveStartRequest,
  ) => Promise<EnvironmentMoveOutcomeAnswer>;
}

/** `personal` is the exact read the plan was drawn against; null for a give. */
export interface EnvironmentMoveAcceptance {
  readonly hostId: string;
  readonly target: EnvironmentOperationTarget;
  readonly planHash: string;
  readonly keyChoices: readonly EnvironmentMoveStaysChoice[];
  readonly personal: EnvironmentMovePersonal;
}

/** `plan_changed`: the computer staged a list other than the one read, so nothing was accepted. */
export type EnvironmentMoveResult =
  | {
      readonly kind: "started";
      readonly outcome: EnvironmentMoveOutcomeAnswer;
    }
  | { readonly kind: "plan_changed" }
  | { readonly kind: "not_awaiting" }
  | { readonly kind: "local_source_unread"; readonly message: string }
  | { readonly kind: "refused" }
  | { readonly kind: "sign_in_changed" };

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

const SIGN_IN_CHANGED = { kind: "sign_in_changed" } as const;

function isNotAwaiting(error: unknown): boolean {
  return error instanceof HostRpcError && error.code === "E_MOVE_NOT_AWAITING";
}

/**
 * The computer moves itself; the app never asks it to record the consent. Once a
 * call answers, nothing more is sent or reported unless `cloud`'s sign-in is current.
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
      personal: accepted.personal,
    });
    if (!cloud.onOriginSignIn()) return SIGN_IN_CHANGED;
    if (!stagedAsAccepted(staged, accepted)) return { kind: "plan_changed" };
    const acceptance = await recordMoveAcceptance(
      cloud,
      accepted.hostId,
      staged,
    );
    if (!cloud.onOriginSignIn()) return SIGN_IN_CHANGED;
    if (acceptance.kind === "refused") return { kind: "refused" };
    const outcome = await host.start({
      attemptId: staged.evidence.attemptId,
      planHash: staged.evidence.planHash,
      acceptanceId: acceptance.acceptanceId,
    });
    if (!cloud.onOriginSignIn()) return SIGN_IN_CHANGED;
    return { kind: "started", outcome };
  } catch (error) {
    if (!cloud.onOriginSignIn()) return SIGN_IN_CHANGED;
    if (isNotAwaiting(error)) return { kind: "not_awaiting" };
    if (
      accepted.target.kind === "personal" &&
      error instanceof HostRpcError &&
      error.method === "environment.move.stage" &&
      error.code === "E_MOVE_LOCAL_SOURCE_UNREAD"
    ) {
      return { kind: "local_source_unread", message: error.message };
    }
    throw error;
  }
}
