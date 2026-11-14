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
const PERSONAL = { items: [], holdsSecrets: false };

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
  it("parses a request and answer through each dormant contract", () => {
    expect(
      environmentMovePlanV20.requestSchema.parse({
        target: { kind: "personal", environmentId: "personal" },
        personal: PERSONAL,
      }),
    ).toEqual({
      target: { kind: "personal", environmentId: "personal" },
      personal: PERSONAL,
    });
    expect(
      environmentMovePlanV20.responseSchema.parse({
        planHash: HASH,
        planRevision: 1,
        hostVersion: "1.2.3",
        disclosureVersion: 1,
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
      }),
    ).toEqual({
      planHash: HASH,
      planRevision: 1,
      hostVersion: "1.2.3",
      disclosureVersion: 1,
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
    });

    const stageRequest = {
      target: { kind: "personal" as const, environmentId: "personal" },
      keyChoices: [],
      personal: PERSONAL,
    };
    expect(environmentMoveStageV10.requestSchema.parse(stageRequest)).toEqual(
      stageRequest,
    );
    const stageInput = stageAnswer("personal");
    Reflect.deleteProperty(stageInput.evidence, "unexpected");
    expect(environmentMoveStageV10.responseSchema.parse(stageInput)).toEqual(
      stageInput,
    );

    const startRequest = {
      attemptId: UUID,
      planHash: HASH,
      acceptanceId: UUID,
    };
    expect(environmentMoveStartV10.requestSchema.parse(startRequest)).toEqual(
      startRequest,
    );
    const started = { state: "done", attemptId: UUID, acceptanceId: UUID };
    expect(environmentMoveStartV10.responseSchema.parse(started)).toEqual(
      started,
    );

    const outcomeRequest = { attemptId: "unknown" };
    expect(
      environmentMoveOutcomeV10.requestSchema.parse(outcomeRequest),
    ).toEqual(outcomeRequest);
    const notFound = { state: "not_found", attemptId: "unknown" };
    expect(environmentMoveOutcomeV10.responseSchema.parse(notFound)).toEqual(
      notFound,
    );

    expect(environmentStatusV13.requestSchema.parse({})).toEqual({});
    expect(
      environmentStatusV13.responseSchema.parse(statusV12Answer).move,
    ).toBeNull();

    const previewRequest = {
      environmentId: "personal",
      subject: { kind: "plan" as const, profileId: "profile" },
    };
    expect(
      environmentPreviewLocalFactsV10.requestSchema.parse(previewRequest),
    ).toEqual(previewRequest);
    const previewAnswer = { activeTurns: null, terminals: null };
    expect(
      environmentPreviewLocalFactsV10.responseSchema.parse(previewAnswer),
    ).toEqual(previewAnswer);

    expect(hostRemoteAccessSetV20.requestSchema.parse({})).toEqual({});
    expect(
      hostRemoteAccessSetV20.responseSchema.parse({ state: "off" }),
    ).toEqual({ state: "off" });
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
    for (const length of [63, 65]) {
      expect(() =>
        environmentMoveStageV10.responseSchema.parse({
          ...personal,
          evidence: { ...personal.evidence, planHash: "a".repeat(length) },
        }),
      ).toThrow();
      expect(() =>
        environmentMoveStageV10.responseSchema.parse({
          ...answer,
          evidence: { ...answer.evidence, planHash: "a".repeat(length) },
        }),
      ).toThrow();
      expect(() =>
        environmentMoveStageV10.responseSchema.parse({
          ...personal,
          authorization: { manifestHash: "a".repeat(length) },
        }),
      ).toThrow();
      expect(() =>
        environmentMoveStageV10.responseSchema.parse({
          ...answer,
          authorization: { disclosureHash: "a".repeat(length) },
        }),
      ).toThrow();
    }
    expect(() =>
      environmentMoveStageV10.responseSchema.parse({
        ...answer,
        evidence: { ...answer.evidence, teamId: "not-a-uuid" },
      }),
    ).toThrow();
    for (const field of ["attemptId", "sourceHostId"] as const) {
      expect(() =>
        environmentMoveStageV10.responseSchema.parse({
          ...personal,
          evidence: { ...personal.evidence, [field]: "not-a-uuid" },
        }),
      ).toThrow();
    }
    expect(() =>
      environmentMoveStageV10.responseSchema.parse({
        ...personal,
        evidence: { ...personal.evidence, hostVersion: "" },
      }),
    ).toThrow();
    expect(
      environmentMoveStageV10.responseSchema.parse({
        ...personal,
        evidence: { ...personal.evidence, hostVersion: "v".repeat(128) },
      }).evidence.targetKind,
    ).toBe("personal");
    expect(() =>
      environmentMoveStageV10.responseSchema.parse({
        ...personal,
        evidence: { ...personal.evidence, hostVersion: "v".repeat(129) },
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

  it("refuses an empty outcome id", () => {
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
        personal: PERSONAL,
      }),
    ).toBeTruthy();
    expect(() =>
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: [choice(3073)],
        personal: PERSONAL,
      }),
    ).toThrow();
    expect(() =>
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: [{ key: "", choice: "stays" }],
        personal: PERSONAL,
      }),
    ).toThrow();
    expect(
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: [],
        personal: PERSONAL,
      }),
    ).toEqual({
      target: { kind: "personal", environmentId: "p" },
      keyChoices: [],
      personal: PERSONAL,
    });
    expect(
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: Array.from({ length: 4096 }, () => choice(1)),
        personal: PERSONAL,
      }).keyChoices,
    ).toHaveLength(4096);
    expect(() =>
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: Array.from({ length: 4097 }, () => choice(1)),
        personal: PERSONAL,
      }),
    ).toThrow();
    expect(() =>
      environmentMoveStageV10.requestSchema.parse({
        target: { kind: "personal", environmentId: "p" },
        keyChoices: [{ key: "x", choice: "variable" }],
        personal: PERSONAL,
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

  it("allows status move only for started outcomes", () => {
    expect(
      environmentStatusV13.responseSchema.parse({
        ...statusV12Answer,
        move: { state: "done", attemptId: UUID, acceptanceId: UUID },
      }).move,
    ).toEqual({ state: "done", attemptId: UUID, acceptanceId: UUID });
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
        target: { kind: "team", environmentId: "t", teamId: UUID },
        personal: null,
      }),
    ).toHaveProperty("target.kind", "team");
    expect(() => environmentMovePlanV20.requestSchema.parse({})).toThrow();
    expect(() =>
      environmentMovePlanV20.requestSchema.parse({
        target: { kind: "team", environmentId: "t", teamId: "not-a-uuid" },
        personal: null,
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
    expect(() =>
      environmentMovePlanV20.responseSchema.parse({
        ...response,
        hostVersion: "",
      }),
    ).toThrow();
    expect(
      environmentMovePlanV20.responseSchema.parse({
        ...response,
        hostVersion: "v".repeat(64),
      }).hostVersion,
    ).toBe("v".repeat(64));
    expect(() =>
      environmentMovePlanV20.responseSchema.parse({
        ...response,
        hostVersion: "v".repeat(65),
      }),
    ).toThrow();
    for (const field of [
      "moves",
      "staysOnThisComputer",
      "alreadyInPersonal",
      "differsMasked",
      "looksLikeAKey",
      "sameNameInPersonal",
    ] as const) {
      const missing = { ...response, rows: { ...response.rows } };
      Reflect.deleteProperty(missing.rows, field);
      expect(() =>
        environmentMovePlanV20.responseSchema.parse(missing),
      ).toThrow();
    }
    for (const field of ["guideDiffers", "personalHoldsSecrets"] as const) {
      const missing = { ...response };
      Reflect.deleteProperty(missing, field);
      expect(() =>
        environmentMovePlanV20.responseSchema.parse(missing),
      ).toThrow();
    }
  });

  it("refuses an enabled key and any state but off on remote access set@2.0", () => {
    expect(() =>
      hostRemoteAccessSetV20.requestSchema.parse({ enabled: false }),
    ).toThrow();
    expect(() =>
      hostRemoteAccessSetV20.responseSchema.parse({ state: "turning_off" }),
    ).toThrow();
  });

  it("requires each local fact subject's id and whole non-negative counts", () => {
    expect(
      environmentPreviewLocalFactsV10.requestSchema.parse({
        environmentId: "e",
        subject: { kind: "member", userId: "u" },
      }).subject.kind,
    ).toBe("member");
    expect(() =>
      environmentPreviewLocalFactsV10.requestSchema.parse({
        environmentId: "e",
        subject: { kind: "plan" },
      }),
    ).toThrow();
    expect(() =>
      environmentPreviewLocalFactsV10.requestSchema.parse({
        environmentId: "e",
        subject: { kind: "member" },
      }),
    ).toThrow();
    for (const invalid of [
      { activeTurns: -1, terminals: null },
      { activeTurns: 0, terminals: -1 },
      { activeTurns: 0.5, terminals: null },
      { activeTurns: null, terminals: 0.5 },
    ]) {
      expect(() =>
        environmentPreviewLocalFactsV10.responseSchema.parse(invalid),
      ).toThrow();
    }
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

describe("move request personal field", () => {
  const personalTarget = { kind: "personal" as const, environmentId: "p" };
  const teamTarget = {
    kind: "team" as const,
    environmentId: "t",
    teamId: UUID,
  };
  type Target = typeof personalTarget | typeof teamTarget;
  const requestCases: Array<{
    parse: (input: unknown) => unknown;
    build: (target: Target, personal: unknown) => Record<string, unknown>;
  }> = [
    {
      parse: (input) => environmentMovePlanV20.requestSchema.parse(input),
      build: (target, personal) => ({ target, personal }),
    },
    {
      parse: (input) => environmentMoveStageV10.requestSchema.parse(input),
      build: (target, personal) => ({ target, keyChoices: [], personal }),
    },
  ];

  it("requires personal and accepts null for both request contracts", () => {
    for (const requestCase of requestCases) {
      const missing = requestCase.build(personalTarget, PERSONAL);
      Reflect.deleteProperty(missing, "personal");
      expect(() => requestCase.parse(missing)).toThrow();

      const request = requestCase.build(personalTarget, null);
      expect(requestCase.parse(request)).toEqual(request);
    }
  });

  it("parses personal rows and nullable operating systems for both contracts", () => {
    const row = {
      kind: "variable",
      key: "FOO",
      os: "any",
      value: { value: "bar" },
    };
    const withOperatingSystem = { items: [row], holdsSecrets: true };
    const withoutOperatingSystem = {
      items: [{ ...row, os: null }],
      holdsSecrets: true,
    };
    for (const requestCase of requestCases) {
      const request = requestCase.build(personalTarget, withOperatingSystem);
      expect(requestCase.parse(request)).toEqual(request);

      const nullableOsRequest = requestCase.build(
        personalTarget,
        withoutOperatingSystem,
      );
      expect(requestCase.parse(nullableOsRequest)).toEqual(nullableOsRequest);
    }
  });

  it("bounds personal item count at 4096 for both contracts", () => {
    const row = { kind: "variable", key: "k", os: null, value: null };
    for (const requestCase of requestCases) {
      const accepted = requestCase.build(personalTarget, {
        items: Array.from({ length: 4096 }, () => row),
        holdsSecrets: false,
      });
      expect(() => requestCase.parse(accepted)).not.toThrow();

      const refused = requestCase.build(personalTarget, {
        items: Array.from({ length: 4097 }, () => row),
        holdsSecrets: false,
      });
      expect(() => requestCase.parse(refused)).toThrow();
    }
  });

  it("bounds personal keys at 1..3072 characters for both contracts", () => {
    for (const requestCase of requestCases) {
      const accepted = requestCase.build(personalTarget, {
        items: [
          { kind: "variable", key: "k".repeat(3072), os: null, value: null },
        ],
        holdsSecrets: false,
      });
      expect(requestCase.parse(accepted)).toEqual(accepted);

      for (const key of ["", "k".repeat(3073)]) {
        const refused = requestCase.build(personalTarget, {
          items: [{ kind: "variable", key, os: null, value: null }],
          holdsSecrets: false,
        });
        expect(() => requestCase.parse(refused)).toThrow();
      }
    }
  });

  it("requires holdsSecrets and rejects extra personal and row keys", () => {
    const row = { kind: "variable", key: "k", os: null, value: null };
    for (const requestCase of requestCases) {
      expect(() =>
        requestCase.parse(
          requestCase.build(personalTarget, {
            items: [row],
            holdsSecrets: false,
            extra: true,
          }),
        ),
      ).toThrow();
      expect(() =>
        requestCase.parse(
          requestCase.build(personalTarget, {
            items: [{ ...row, extra: true }],
            holdsSecrets: false,
          }),
        ),
      ).toThrow();
      expect(() =>
        requestCase.parse(requestCase.build(personalTarget, { items: [row] })),
      ).toThrow();
    }
  });

  it("parses a team target with personal null for both contracts", () => {
    for (const requestCase of requestCases) {
      const request = requestCase.build(teamTarget, null);
      expect(requestCase.parse(request)).toEqual(request);
    }
  });
});
