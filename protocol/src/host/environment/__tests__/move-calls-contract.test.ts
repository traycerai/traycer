import { describe, expect, it } from "vitest";
import { isRpcErrorCode } from "@traycer/protocol/framework/index";
import {
  environmentMoveAcceptV10,
  environmentMoveOutcomeV10,
  environmentMovePlanV12,
  environmentMovePlanV20,
  environmentMoveStageV10,
  environmentMoveStartV10,
} from "@traycer/protocol/host/environment/move-contracts";
import {
  environmentStatusUpgradeV12ToV13,
  environmentStatusV12,
  environmentStatusV13,
  hostRemoteAccessSetV20,
} from "@traycer/protocol/host/environment-contracts";
import { environmentPreviewLocalFactsV10 } from "@traycer/protocol/host/environment/contracts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const HASH = "a".repeat(64);

function stageAnswer(kind: "personal" | "team") {
  const common = {
    attemptId: UUID,
    planHash: HASH,
    planRevision: 1,
    hostVersion: "1.2.3",
    itemCount: 0,
    keyChoices: [],
    sourceHostId: UUID,
    sharingGeneration: 1,
  };
  return kind === "personal"
    ? {
        evidence: {
          ...common,
          targetKind: "personal" as const,
          environmentId: "env-personal",
          disclosureVersion: 1,
          unexpected: true,
        },
        authorization: { manifestHash: HASH },
      }
    : {
        evidence: {
          ...common,
          targetKind: "team" as const,
          environmentId: "env-team",
          teamId: UUID,
          disclosureVersion: 2 as const,
          unexpected: true,
        },
        authorization: { disclosureHash: HASH },
      };
}

const statusV12Answer = {
  principal: { kind: "personal" as const },
  reachability: "connected",
  bindingGeneration: 1,
  desiredRevision: 1,
  receivedRevision: 1,
  appliedRevision: 1,
  receiptAgeMs: 0,
  items: [],
  pendingUploads: [],
  setup: null,
  remoteAccess: "off" as const,
  consent: null,
  planes: {
    records: "local" as const,
    broker: "local" as const,
    room: "local" as const,
  },
  returnedFromTeam: null,
  stoppedAt: null,
  acceptedUploads: [],
};

describe("dormant move call contracts", () => {
  it("keeps each dormant method and wire version explicit", () => {
    expect(environmentMovePlanV20.method).toBe("environment.move.plan");
    expect(environmentMovePlanV20.schemaVersion).toEqual({
      major: 2,
      minor: 0,
    });
    expect(environmentMoveStageV10.method).toBe("environment.move.stage");
    expect(environmentMoveStageV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(environmentMoveStartV10.method).toBe("environment.move.start");
    expect(environmentMoveStartV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(environmentMoveOutcomeV10.method).toBe("environment.move.outcome");
    expect(environmentMoveOutcomeV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(environmentMovePlanV12.method).toBe("environment.move.plan");
    expect(environmentMovePlanV12.schemaVersion).toEqual({
      major: 1,
      minor: 2,
    });
    expect(environmentMoveAcceptV10.method).toBe("environment.move.accept");
    expect(environmentMoveAcceptV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(environmentStatusV12.method).toBe("environment.status");
    expect(environmentStatusV12.schemaVersion).toEqual({ major: 1, minor: 2 });
    expect(environmentStatusV13.method).toBe("environment.status");
    expect(environmentStatusV13.schemaVersion).toEqual({ major: 1, minor: 3 });
    expect(environmentPreviewLocalFactsV10.method).toBe(
      "environment.previewLocalFacts",
    );
    expect(environmentPreviewLocalFactsV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(hostRemoteAccessSetV20.method).toBe("host.remoteAccess.set");
    expect(hostRemoteAccessSetV20.schemaVersion).toEqual({
      major: 2,
      minor: 0,
    });
  });

  it("flattens each stage answer to exactly authn's acceptance request", () => {
    const personal = environmentMoveStageV10.responseSchema.parse(
      stageAnswer("personal"),
    );
    if (personal.evidence.targetKind !== "personal")
      throw new Error("personal arm");
    const personalRequest = { ...personal.evidence, ...personal.authorization };
    expect(Object.keys(personalRequest).sort()).toEqual(
      [
        "targetKind",
        "environmentId",
        "disclosureVersion",
        "manifestHash",
        "attemptId",
        "planHash",
        "planRevision",
        "hostVersion",
        "itemCount",
        "keyChoices",
        "sourceHostId",
        "sharingGeneration",
      ].sort(),
    );
    expect(personalRequest).not.toHaveProperty("unexpected");

    const team = environmentMoveStageV10.responseSchema.parse(
      stageAnswer("team"),
    );
    if (team.evidence.targetKind !== "team") throw new Error("team arm");
    const teamRequest = { ...team.evidence, ...team.authorization };
    expect(Object.keys(teamRequest).sort()).toEqual(
      [
        "targetKind",
        "teamId",
        "environmentId",
        "disclosureVersion",
        "disclosureHash",
        "attemptId",
        "planHash",
        "planRevision",
        "hostVersion",
        "itemCount",
        "keyChoices",
        "sourceHostId",
        "sharingGeneration",
      ].sort(),
    );
    expect(teamRequest.disclosureVersion).toBe(2);
    expect(teamRequest).not.toHaveProperty("unexpected");
  });

  it("upgrades a parsed status@1.2 answer without changing it except for move", () => {
    const oldAnswer =
      environmentStatusV12.responseSchema.parse(statusV12Answer);
    const upgraded =
      environmentStatusUpgradeV12ToV13.upgradeResponse(oldAnswer);
    expect(upgraded).toEqual({ ...oldAnswer, move: null });
    expect(environmentStatusV13.responseSchema.parse(upgraded)).toEqual(
      upgraded,
    );
  });

  it("keeps stage hash and team disclosure bounds on both sides", () => {
    const answer = stageAnswer("team");
    expect(environmentMoveStageV10.responseSchema.parse(answer)).toBeTruthy();
    expect(() =>
      environmentMoveStageV10.responseSchema.parse({
        ...answer,
        evidence: { ...answer.evidence, disclosureVersion: 3 },
      }),
    ).toThrow();
    const personal = stageAnswer("personal");
    expect(() =>
      environmentMoveStageV10.responseSchema.parse({
        ...personal,
        evidence: { ...personal.evidence, planHash: "A".repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      environmentMoveStageV10.responseSchema.parse({
        ...personal,
        authorization: { manifestHash: "A".repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      environmentMoveStageV10.responseSchema.parse({
        ...answer,
        evidence: { ...answer.evidence, planHash: "A".repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      environmentMoveStageV10.responseSchema.parse({
        ...answer,
        authorization: { disclosureHash: "A".repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      environmentMoveStageV10.responseSchema.parse({
        ...answer,
        evidence: { ...answer.evidence, teamId: "not-a-uuid" },
      }),
    ).toThrow();
  });

  it("bounds start ids but lets a mismatching non-empty hash reach the host", () => {
    const valid = { attemptId: UUID, planHash: "x", acceptanceId: UUID };
    expect(environmentMoveStartV10.requestSchema.parse(valid)).toEqual(valid);
    expect(() =>
      environmentMoveStartV10.requestSchema.parse({ ...valid, attemptId: "x" }),
    ).toThrow();
    expect(() =>
      environmentMoveStartV10.requestSchema.parse({
        ...valid,
        acceptanceId: "x",
      }),
    ).toThrow();
    expect(() =>
      environmentMoveStartV10.requestSchema.parse({ ...valid, planHash: "" }),
    ).toThrow();
  });

  it("allows unknown non-empty outcome ids to receive not_found", () => {
    expect(
      environmentMoveOutcomeV10.requestSchema.parse({ attemptId: "unknown" }),
    ).toEqual({ attemptId: "unknown" });
    expect(
      environmentMoveOutcomeV10.responseSchema.parse({
        state: "not_found",
        attemptId: "unknown",
      }),
    ).toEqual({ state: "not_found", attemptId: "unknown" });
    expect(() =>
      environmentMoveOutcomeV10.requestSchema.parse({ attemptId: "" }),
    ).toThrow();
  });

  it("bounds stays choices and stage key choices, including the empty list", () => {
    const choice = (length: number) => ({
      key: "k".repeat(length),
      choice: "stays",
    });
    expect(
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: [choice(3072)],
      }),
    ).toBeTruthy();
    expect(() =>
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: [choice(3073)],
      }),
    ).toThrow();
    expect(
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: [],
      }),
    ).toEqual({
      target: { kind: "personal", environmentId: "p" },
      keyChoices: [],
    });
    expect(
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: Array.from({ length: 4096 }, () => choice(1)),
      }).keyChoices,
    ).toHaveLength(4096);
    expect(() =>
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: Array.from({ length: 4097 }, () => choice(1)),
      }),
    ).toThrow();
    expect(() =>
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: [{ key: "x", choice: "variable" }],
      }),
    ).toThrow();
  });

  it("accepts every open outcome arm and rejects empty details", () => {
    const cases = [
      { state: "running", attemptId: UUID, acceptanceId: UUID },
      {
        state: "retry",
        attemptId: UUID,
        acceptanceId: UUID,
        cause: "future_cause",
      },
      {
        state: "needs_person",
        attemptId: UUID,
        acceptanceId: UUID,
        reason: "future_reason",
      },
      { state: "done", attemptId: UUID, acceptanceId: UUID },
    ];
    for (const answer of cases) {
      expect(environmentMoveStartV10.responseSchema.parse(answer)).toEqual(
        answer,
      );
      expect(environmentMoveOutcomeV10.responseSchema.parse(answer)).toEqual(
        answer,
      );
    }
    expect(() =>
      environmentMoveOutcomeV10.responseSchema.parse({
        state: "retry",
        attemptId: UUID,
        acceptanceId: UUID,
        cause: "",
      }),
    ).toThrow();
    expect(() =>
      environmentMoveStartV10.responseSchema.parse({
        state: "needs_person",
        attemptId: UUID,
        acceptanceId: UUID,
        reason: "",
      }),
    ).toThrow();
  });

  it("allows status move only for started outcomes and defaults it to null", () => {
    expect(
      environmentStatusV13.responseSchema.parse({
        ...statusV12Answer,
        move: { state: "done", attemptId: UUID, acceptanceId: UUID },
      }).move,
    ).toEqual({ state: "done", attemptId: UUID, acceptanceId: UUID });
    expect(
      environmentStatusV13.responseSchema.parse(statusV12Answer).move,
    ).toBeNull();
    expect(() =>
      environmentStatusV13.responseSchema.parse({
        ...statusV12Answer,
        move: { state: "not_found", attemptId: "x" },
      }),
    ).toThrow();
  });

  it("requires plan@2.0 target and required response fields while stripping itemChoices", () => {
    expect(
      environmentMovePlanV20.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
      }),
    ).toEqual({ target: { kind: "personal", environmentId: "p" } });
    expect(
      environmentMovePlanV20.requestSchema.parse({
        target: { kind: "team", environmentId: "t", teamId: UUID },
      }),
    ).toHaveProperty("target.kind", "team");
    expect(() => environmentMovePlanV20.requestSchema.parse({})).toThrow();
    expect(() =>
      environmentMovePlanV20.requestSchema.parse({
        target: { kind: "team", environmentId: "t", teamId: "not-a-uuid" },
      }),
    ).toThrow();
    const response = {
      planHash: HASH,
      planRevision: 1,
      hostVersion: "1.2.3",
      disclosureVersion: 2,
      rows: {
        moves: [],
        staysOnThisComputer: [],
        alreadyInPersonal: [],
        differsMasked: [],
        looksLikeAKey: [],
        sameNameInPersonal: [],
      },
      guideDiffers: false,
      personalHoldsSecrets: false,
      itemChoices: true,
    };
    expect(
      environmentMovePlanV20.responseSchema.parse(response),
    ).not.toHaveProperty("itemChoices");
    for (const key of [
      "sameNameInPersonal",
      "guideDiffers",
      "personalHoldsSecrets",
    ] as const) {
      const malformed =
        key === "sameNameInPersonal"
          ? {
              ...response,
              rows: {
                moves: [],
                staysOnThisComputer: [],
                alreadyInPersonal: [],
                differsMasked: [],
                looksLikeAKey: [],
              },
            }
          : { ...response, [key]: undefined };
      expect(() =>
        environmentMovePlanV20.responseSchema.parse(malformed),
      ).toThrow();
    }
  });

  it("keeps remote access set@2.0 off only", () => {
    expect(hostRemoteAccessSetV20.requestSchema.parse({})).toEqual({});
    expect(() =>
      hostRemoteAccessSetV20.requestSchema.parse({ enabled: false }),
    ).toThrow();
    expect(
      hostRemoteAccessSetV20.responseSchema.parse({ state: "off" }),
    ).toEqual({ state: "off" });
    expect(() =>
      hostRemoteAccessSetV20.responseSchema.parse({ state: "turning_off" }),
    ).toThrow();
  });

  it("accepts both local fact subject kinds and nullable counts", () => {
    expect(
      environmentPreviewLocalFactsV10.requestSchema.parse({
        environmentId: "e",
        subject: { kind: "plan", profileId: "p" },
      }).subject.kind,
    ).toBe("plan");
    expect(
      environmentPreviewLocalFactsV10.requestSchema.parse({
        environmentId: "e",
        subject: { kind: "member", userId: "u" },
      }).subject.kind,
    ).toBe("member");
    expect(
      environmentPreviewLocalFactsV10.responseSchema.parse({
        activeTurns: null,
        terminals: null,
      }),
    ).toEqual({ activeTurns: null, terminals: null });
    expect(() =>
      environmentPreviewLocalFactsV10.responseSchema.parse({
        activeTurns: -1,
        terminals: 0,
      }),
    ).toThrow();
  });

  it("recognizes E_MOVE_NOT_AWAITING and preserves shipped plan and accept shapes", () => {
    expect(isRpcErrorCode("E_MOVE_NOT_AWAITING")).toBe(true);
    expect(environmentMovePlanV12.requestSchema.parse({})).toEqual({});
    expect(
      environmentMoveAcceptV10.responseSchema.parse({
        outcome: "not_awaiting",
      }),
    ).toEqual({ outcome: "not_awaiting" });
  });
});
