import type { EnvironmentStatusResponseV13 } from "@traycer/protocol/host/environment-schemas";
import type {
  EnvironmentMovePlanResponseV20,
  EnvironmentMoveStageResponse,
} from "@traycer/protocol/host/environment/move-contracts";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";

export const GIVE_TEAM_ID = "2b7e9d10-4c5a-4f6e-8d3b-a1c2e3f40516";
export const GIVE_PLAN_HASH = "a".repeat(64);
export const GIVE_ATTEMPT_ID = "c3d4e5f6-0718-4a29-8b3c-4d5e6f708192";
export const GIVE_ACCEPTANCE_ID = "a7b8c9d0-e1f2-4a3b-8c5d-6e7f8091a2b3";
export const GIVE_DISCLOSURE_HASH = "b".repeat(64);

export const GIVE_PLAN: EnvironmentMovePlanResponseV20 = {
  planHash: GIVE_PLAN_HASH,
  planRevision: 1,
  hostVersion: "1.5.0",
  disclosureVersion: 2,
  rows: {
    moves: [],
    staysOnThisComputer: [],
    alreadyInPersonal: [],
    differsMasked: [],
  },
  guideDiffers: false,
  personalHoldsSecrets: false,
};

export function giveStageFixture(args: {
  readonly hostId: string;
  readonly environmentId: string;
  readonly teamId: string;
}): EnvironmentMoveStageResponse {
  return {
    evidence: {
      attemptId: GIVE_ATTEMPT_ID,
      planHash: GIVE_PLAN_HASH,
      planRevision: 1,
      hostVersion: "1.5.0",
      itemCount: 0,
      keyChoices: [],
      sourceHostId: args.hostId,
      sharingGeneration: 1,
      targetKind: "team",
      environmentId: args.environmentId,
      teamId: args.teamId,
      disclosureVersion: 2,
    },
    authorization: { disclosureHash: GIVE_DISCLOSURE_HASH },
  };
}

export function giveMoveStatus(
  state: "running" | "needs_person" | "done",
  attemptId: string,
): EnvironmentStatusResponseV13 {
  let move: EnvironmentStatusResponseV13["move"];
  switch (state) {
    case "needs_person":
      move = {
        state: "needs_person",
        reason: "consumed",
        attemptId,
        acceptanceId: GIVE_ACCEPTANCE_ID,
      };
      break;
    case "done":
      move = { state: "done", attemptId, acceptanceId: GIVE_ACCEPTANCE_ID };
      break;
    case "running":
      move = { state: "running", attemptId, acceptanceId: GIVE_ACCEPTANCE_ID };
      break;
  }
  return environmentStatusFixture({ move });
}
