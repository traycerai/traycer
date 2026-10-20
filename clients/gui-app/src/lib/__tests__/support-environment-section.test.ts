import { describe, expect, it } from "vitest";
import type {
  EnvironmentItemStatus,
  EnvironmentReachDiagnosticsResponse,
  EnvironmentSecretsRotationResponse,
  EnvironmentStatusResponse,
  SetupAttempt,
} from "@traycer/protocol/host/environment-schemas";
import {
  SUPPORT_ENVIRONMENT_TEXT_MAX,
  supportEnvironmentSection,
  type SupportEnvironmentReads,
  type SupportEnvironmentRotationRead,
} from "@/lib/support-environment-section";

/**
 * The pure builder behind a support report's environment section. The section
 * is a CLOSED key set (Electron main refuses any other key), so these tests
 * hold the output to exactly what the ruling lists and keep everything it rules
 * out out of it.
 */

const TEAM_NAME = "Acme Robotics ZZ_TEAM_NAME";
const PENDING_UPLOAD_KEY = "ZZ_PENDING_UPLOAD_KEY";

const SECTION_KEYS = [
  "appliedRevision",
  "bindingGeneration",
  "desiredRevision",
  "hostId",
  "items",
  "policy",
  "principal",
  "reachDenials",
  "reachability",
  "receiptAgeMs",
  "receivedRevision",
  "rotations",
  "servedTask",
  "setupAttempts",
];

type RotationRead = NonNullable<EnvironmentSecretsRotationResponse["rotation"]>;
type RotationProducer = RotationRead["producers"][number];

function item(
  overrides: Partial<EnvironmentItemStatus>,
): EnvironmentItemStatus {
  return {
    kind: "variable",
    key: "DATABASE_URL",
    os: "any",
    desiredRevision: 4,
    status: "applied",
    code: "ok",
    args: { exitStatus: null, stage: null, durationMs: null, kind: null },
    brokerEnforced: { enforced: true, evidenceKind: "session_closed" },
    minimumHostVersion: "9.9.9",
    appliedAs: { entryKind: "mcp", name: "ZZ_APPLIED_AS_NAME" },
    ...overrides,
  };
}

function status(
  overrides: Partial<EnvironmentStatusResponse>,
): EnvironmentStatusResponse {
  return {
    principal: { kind: "personal" },
    reachability: "connected",
    bindingGeneration: 3,
    desiredRevision: 7,
    receivedRevision: 7,
    appliedRevision: 6,
    receiptAgeMs: 1200,
    items: [
      item({}),
      item({
        kind: "setup_script",
        key: "setup",
        os: "linux",
        status: "failed",
        code: "script_failed",
        args: {
          exitStatus: 2,
          stage: "install",
          durationMs: 4100,
          kind: "script",
        },
        brokerEnforced: null,
        minimumHostVersion: null,
        appliedAs: null,
      }),
    ],
    pendingUploads: [
      {
        uploadId: "ZZ_UPLOAD_ID",
        kind: "variable",
        key: PENDING_UPLOAD_KEY,
        os: "any",
        queuedAt: 1_700_000_000_000,
        receipt: "pending",
        code: null,
      },
    ],
    setup: { stage: "applying", state: "running" },
    remoteAccess: "on",
    ...overrides,
  };
}

const ATTEMPT: SetupAttempt = {
  attemptId: "attempt-1",
  scriptHash: "sha256:abc123",
  itemRevision: 5,
  trigger: "change",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_004_100,
  exitStatus: 2,
  stageReached: "install",
  result: "failed",
};

const WORKER_PRODUCER: RotationProducer = {
  producer: "worker",
  workerClass: "sandbox",
  incarnation: "ZZ_INCARNATION_W",
  status: "missing",
  evidence: [
    { kind: "session_closed", count: 2 },
    { kind: "probe_refused", count: null },
  ],
};

const HOST_PRODUCER: RotationProducer = {
  producer: "host",
  hostId: "host-2",
  incarnation: "ZZ_INCARNATION_H",
  status: "applies_on_resume",
  evidence: null,
};

function rotationRead(
  secretName: string,
  producers: readonly RotationProducer[],
): SupportEnvironmentRotationRead {
  return {
    secretName,
    rotation: {
      rotationId: "ZZ_ROTATION_ID",
      fromVersionId: "version-1",
      toVersionId: "version-2",
      state: "enforcing",
      issuedAt: 1_700_000_000_000,
      producers: [...producers],
    },
  };
}

function reads(
  overrides: Partial<SupportEnvironmentReads>,
): SupportEnvironmentReads {
  return {
    hostId: "host-1",
    status: status({}),
    setupAttempts: [ATTEMPT],
    policy: {
      source: "account",
      readState: "ready",
      teamState: null,
      teamPolicyVersion: null,
    },
    rotations: [rotationRead("STRIPE_KEY", [WORKER_PRODUCER, HOST_PRODUCER])],
    reachDiagnostics: null,
    ...overrides,
  };
}

describe("supportEnvironmentSection", () => {
  it("has exactly the fourteen ruled keys, however much the host sent", () => {
    const section = supportEnvironmentSection(reads({}));
    expect(Object.keys(section).sort()).toEqual(SECTION_KEYS);
  });

  it("maps a realistic status field for field", () => {
    const section = supportEnvironmentSection(reads({}));
    expect(section).toMatchObject({
      hostId: "host-1",
      principal: "personal",
      reachability: "connected",
      bindingGeneration: 3,
      desiredRevision: 7,
      receivedRevision: 7,
      appliedRevision: 6,
      receiptAgeMs: 1200,
    });
    expect(section.items).toEqual([
      {
        kind: "variable",
        key: "DATABASE_URL",
        os: "any",
        status: "applied",
        code: "ok",
        args: { exitStatus: null, stage: null, durationMs: null, kind: null },
      },
      {
        kind: "setup_script",
        key: "setup",
        os: "linux",
        status: "failed",
        code: "script_failed",
        args: {
          exitStatus: 2,
          stage: "install",
          durationMs: 4100,
          kind: "script",
        },
      },
    ]);
    expect(section.setupAttempts).toEqual([
      {
        attemptId: "attempt-1",
        scriptHash: "sha256:abc123",
        trigger: "change",
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_004_100,
        exitStatus: 2,
        stageReached: "install",
        result: "failed",
      },
    ]);
    expect(section.policy).toEqual({
      source: "account",
      readState: "ready",
      teamState: null,
      teamPolicyVersion: null,
    });
  });

  it("gives the principal as a category only: the team's name is nowhere in the section", () => {
    const section = supportEnvironmentSection(
      reads({
        status: status({ principal: { kind: "team", teamName: TEAM_NAME } }),
      }),
    );
    expect(section.principal).toBe("team");
    expect(JSON.stringify(section)).not.toContain(TEAM_NAME);
    expect(JSON.stringify(section)).not.toContain("Acme");
  });

  it("keeps a personal principal personal and a missing one null", () => {
    expect(
      supportEnvironmentSection(
        reads({ status: status({ principal: { kind: "personal" } }) }),
      ).principal,
    ).toBe("personal");
    expect(
      supportEnvironmentSection(reads({ status: status({ principal: null }) }))
        .principal,
    ).toBeNull();
  });

  it("never carries what the ruling rules out, even when the host sent it", () => {
    const section = supportEnvironmentSection(reads({}));
    const serialized = JSON.stringify(section);
    // Pending uploads (and the other status members the section leaves out).
    expect(section).not.toHaveProperty("pendingUploads");
    expect(serialized).not.toContain(PENDING_UPLOAD_KEY);
    expect(serialized).not.toContain("ZZ_UPLOAD_ID");
    expect(serialized).not.toContain("ZZ_APPLIED_AS_NAME");
    expect(serialized).not.toContain("9.9.9");
    expect(serialized).not.toContain("remoteAccess");
    // The rotation's own ids and its producers' incarnations.
    expect(serialized).not.toContain("ZZ_ROTATION_ID");
    expect(serialized).not.toContain("ZZ_INCARNATION_W");
    expect(serialized).not.toContain("ZZ_INCARNATION_H");
    expect(serialized).not.toContain("version-2");
  });

  it("builds each item with exactly the six item keys and the four args keys", () => {
    const section = supportEnvironmentSection(reads({}));
    for (const entry of section.items) {
      expect(Object.keys(entry).sort()).toEqual([
        "args",
        "code",
        "key",
        "kind",
        "os",
        "status",
      ]);
      expect(Object.keys(entry.args).sort()).toEqual([
        "durationMs",
        "exitStatus",
        "kind",
        "stage",
      ]);
    }
  });

  it("builds each setup attempt without its item revision", () => {
    const section = supportEnvironmentSection(reads({}));
    expect(Object.keys(section.setupAttempts?.[0] ?? {}).sort()).toEqual([
      "attemptId",
      "endedAt",
      "exitStatus",
      "result",
      "scriptHash",
      "stageReached",
      "startedAt",
      "trigger",
    ]);
  });

  it("truncates an item key to 3072 and a secret name to 128 characters", () => {
    const section = supportEnvironmentSection(
      reads({
        status: status({ items: [item({ key: "k".repeat(4000) })] }),
        rotations: [rotationRead("s".repeat(200), [WORKER_PRODUCER])],
      }),
    );
    expect(section.items[0]?.key).toHaveLength(
      SUPPORT_ENVIRONMENT_TEXT_MAX.itemKey,
    );
    expect(section.items[0]?.key).toHaveLength(3072);
    expect(section.rotations?.[0]?.secretName).toHaveLength(
      SUPPORT_ENVIRONMENT_TEXT_MAX.secretName,
    );
    expect(section.rotations?.[0]?.secretName).toHaveLength(128);
  });

  it("leaves a name at exactly its limit whole", () => {
    const section = supportEnvironmentSection(
      reads({
        status: status({ items: [item({ key: "k".repeat(3072) })] }),
        rotations: [rotationRead("s".repeat(128), [WORKER_PRODUCER])],
      }),
    );
    expect(section.items[0]?.key).toBe("k".repeat(3072));
    expect(section.rotations?.[0]?.secretName).toBe("s".repeat(128));
  });

  it("truncates a code to 64, a hash to 128 and an opaque id to 256 characters", () => {
    const section = supportEnvironmentSection(
      reads({
        hostId: "h".repeat(300),
        status: status({ reachability: "r".repeat(100) }),
        setupAttempts: [
          {
            ...ATTEMPT,
            scriptHash: "x".repeat(200),
            attemptId: "a".repeat(300),
          },
        ],
        rotations: [
          rotationRead("STRIPE_KEY", [
            { ...HOST_PRODUCER, hostId: "p".repeat(300) },
          ]),
        ],
      }),
    );
    expect(section.hostId).toHaveLength(256);
    expect(section.reachability).toHaveLength(64);
    expect(section.setupAttempts?.[0]?.scriptHash).toHaveLength(128);
    expect(section.setupAttempts?.[0]?.attemptId).toHaveLength(256);
    expect(section.rotations?.[0]?.producers[0]?.hostId).toHaveLength(256);
  });

  it("builds producers in the secret.rotated shape: hostName null, workerClass and hostId per arm", () => {
    const section = supportEnvironmentSection(reads({}));
    expect(section.rotations).toEqual([
      {
        secretName: "STRIPE_KEY",
        state: "enforcing",
        producers: [
          {
            producer: "worker",
            workerClass: "sandbox",
            hostId: null,
            hostName: null,
            status: "missing",
            evidence: [
              { kind: "session_closed", count: 2 },
              { kind: "probe_refused", count: null },
            ],
          },
          {
            producer: "host",
            workerClass: null,
            hostId: "host-2",
            hostName: null,
            status: "applies_on_resume",
            evidence: null,
          },
        ],
      },
    ]);
  });

  it("leaves a secret whose rotation is null out of the section", () => {
    const section = supportEnvironmentSection(
      reads({
        rotations: [
          { secretName: "NEVER_ROTATED", rotation: null },
          rotationRead("STRIPE_KEY", [WORKER_PRODUCER]),
        ],
      }),
    );
    expect(section.rotations?.map((entry) => entry.secretName)).toEqual([
      "STRIPE_KEY",
    ]);
    expect(JSON.stringify(section)).not.toContain("NEVER_ROTATED");
  });

  it("gives an empty list, not null, when every listed secret has no rotation", () => {
    const section = supportEnvironmentSection(
      reads({ rotations: [{ secretName: "NEVER_ROTATED", rotation: null }] }),
    );
    expect(section.rotations).toEqual([]);
  });

  it("maps two denials and the served task, with ids capped at 256 and codes at 64", () => {
    const diagnostics: EnvironmentReachDiagnosticsResponse = {
      denials: [
        {
          denialId: "d".repeat(300),
          at: 1_700_000_000_000,
          sourceHostRef: "s".repeat(300),
          targetHostRef: "t".repeat(300),
          taskRef: "k".repeat(300),
          reason: "principal_mismatch",
          sourcePrincipal: "personal",
          targetPrincipal: "team",
          count: 3,
        },
        {
          denialId: "denial-2",
          at: 1_700_000_001_000,
          sourceHostRef: "host-ref-b",
          targetHostRef: "host-ref-c",
          taskRef: null,
          reason: "principal_mismatch",
          sourcePrincipal: "unknown",
          targetPrincipal: "unknown",
          count: 1,
        },
      ],
      servedTask: {
        taskRef: "m".repeat(300),
        otherHostPrincipals: ["team", "unknown"],
      },
    };

    const section = supportEnvironmentSection(
      reads({ reachDiagnostics: diagnostics }),
    );

    expect(section.reachDenials).toHaveLength(2);
    expect(section.reachDenials?.[0]).toEqual({
      denialId: "d".repeat(256),
      at: 1_700_000_000_000,
      sourceHostRef: "s".repeat(256),
      targetHostRef: "t".repeat(256),
      taskRef: "k".repeat(256),
      reason: "principal_mismatch",
      sourcePrincipal: "personal",
      targetPrincipal: "team",
      count: 3,
    });
    expect(section.reachDenials?.[1]).toEqual({
      denialId: "denial-2",
      at: 1_700_000_001_000,
      sourceHostRef: "host-ref-b",
      targetHostRef: "host-ref-c",
      taskRef: null,
      reason: "principal_mismatch",
      sourcePrincipal: "unknown",
      targetPrincipal: "unknown",
      count: 1,
    });
    expect(section.servedTask).toEqual({
      taskRef: "m".repeat(256),
      otherHostPrincipals: ["team", "unknown"],
    });
  });

  it("holds each denial and the served task to their ruled keys, so no label or owner id rides along", () => {
    const section = supportEnvironmentSection(
      reads({
        reachDiagnostics: {
          denials: [
            {
              denialId: "denial-1",
              at: 1_700_000_000_000,
              sourceHostRef: "host-ref-a",
              targetHostRef: "host-ref-b",
              taskRef: "task-ref-1",
              reason: "principal_mismatch",
              sourcePrincipal: "personal",
              targetPrincipal: "team",
              count: 1,
            },
          ],
          servedTask: { taskRef: "task-ref-1", otherHostPrincipals: [] },
        },
      }),
    );
    expect(Object.keys(section.reachDenials?.[0] ?? {}).sort()).toEqual([
      "at",
      "count",
      "denialId",
      "reason",
      "sourceHostRef",
      "sourcePrincipal",
      "targetHostRef",
      "targetPrincipal",
      "taskRef",
    ]);
    expect(Object.keys(section.servedTask ?? {}).sort()).toEqual([
      "otherHostPrincipals",
      "taskRef",
    ]);
  });

  it("gives null for both reach members when the reach read is null", () => {
    const section = supportEnvironmentSection(
      reads({ reachDiagnostics: null }),
    );
    expect(section.reachDenials).toBeNull();
    expect(section.servedTask).toBeNull();
  });

  it("gives an empty denial list and a null served task for a quiet host", () => {
    const section = supportEnvironmentSection(
      reads({ reachDiagnostics: { denials: [], servedTask: null } }),
    );
    expect(section.reachDenials).toEqual([]);
    expect(section.servedTask).toBeNull();
  });

  it("passes unread setup attempts, policy and rotations through as null", () => {
    const section = supportEnvironmentSection(
      reads({ setupAttempts: null, policy: null, rotations: null }),
    );
    expect(section.setupAttempts).toBeNull();
    expect(section.policy).toBeNull();
    expect(section.rotations).toBeNull();
  });

  it("carries a team host's policy state and version through, and null for a personal host", () => {
    const team = supportEnvironmentSection(
      reads({
        policy: {
          source: "account",
          readState: "fresh",
          teamState: "applied",
          teamPolicyVersion: "42",
        },
      }),
    );
    const lapsed = supportEnvironmentSection(
      reads({
        policy: {
          source: "account",
          readState: "fresh",
          teamState: "lapsed",
          teamPolicyVersion: "42",
        },
      }),
    );
    const none = supportEnvironmentSection(
      reads({
        policy: {
          source: "account",
          readState: "fresh",
          teamState: "none",
          teamPolicyVersion: null,
        },
      }),
    );
    const personal = supportEnvironmentSection(reads({}));

    expect(team.policy).toEqual({
      source: "account",
      readState: "fresh",
      teamState: "applied",
      teamPolicyVersion: "42",
    });
    expect(lapsed.policy).toMatchObject({
      teamState: "lapsed",
      teamPolicyVersion: "42",
    });
    expect(none.policy).toMatchObject({
      teamState: "none",
      teamPolicyVersion: null,
    });
    expect(personal.policy).toMatchObject({
      teamState: null,
      teamPolicyVersion: null,
    });
  });

  it("holds the policy's keys to the ruled four, so no policy body can ride along", () => {
    const section = supportEnvironmentSection(
      reads({
        policy: {
          source: "account",
          readState: "fresh",
          teamState: "applied",
          teamPolicyVersion: "7",
        },
      }),
    );

    expect(Object.keys(section.policy ?? {}).sort()).toEqual([
      "readState",
      "source",
      "teamPolicyVersion",
      "teamState",
    ]);
  });

  it("caps the team state and version at the code length, as every closed code is", () => {
    const long = "x".repeat(SUPPORT_ENVIRONMENT_TEXT_MAX.code + 40);
    const section = supportEnvironmentSection(
      reads({
        policy: {
          source: "account",
          readState: "fresh",
          teamState: long,
          teamPolicyVersion: long,
        },
      }),
    );

    expect(section.policy?.teamState).toHaveLength(
      SUPPORT_ENVIRONMENT_TEXT_MAX.code,
    );
    expect(section.policy?.teamPolicyVersion).toHaveLength(
      SUPPORT_ENVIRONMENT_TEXT_MAX.code,
    );
  });
});
