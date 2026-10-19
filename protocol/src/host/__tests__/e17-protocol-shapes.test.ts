import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  isRpcErrorCode,
  RPC_ERROR_CODES,
} from "@traycer/protocol/framework/index";
import {
  agentListDowngradeV10ToV9,
  agentListUpgradeV101ToV102,
  agentListV100,
  agentListV101,
  agentListV102,
} from "@traycer/protocol/host/agent/contracts";
import {
  agentSummarySchema,
  listAgentsResponseSchema,
  listAgentsResponseSchemaV100,
  listAgentsResponseSchemaV101,
} from "@traycer/protocol/host/agent/shared";
import { epicListTaskHostsV10 } from "@traycer/protocol/host/epic/contracts";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  credentialUpdatePayloadSchema,
  SESSION_CAPABILITY_CREDENTIAL_UPDATE,
  SESSION_CAPABILITY_MEMBER_CREDENTIAL,
} from "../../host-transport/mux";
import { HOST_LIST_ITEM_GOLDEN_FIXTURE } from "../__fixtures__/host-status-golden-fixture";
import { hostListItemSchema, hostListItemSchemaV10 } from "../host-status";
import {
  UNKNOWN_CONNECTIVITY,
  lastKnownConnectivitySchema,
} from "../last-known-connectivity";
import { sandboxSummarySchema } from "../sandbox-control";
import {
  listTaskHostsRequestSchema,
  listTaskHostsResponseSchema,
  taskHostPrincipalSchema,
  taskHostRowSchema,
} from "../task-host-summary";

/**
 * Wire shapes ticket E17 checkpoint 1 adds: the `principal_mismatch` error
 * code, `agent.list@10.2`, the host list `owner`, the sandbox card's member
 * names, the task host row and `epic.listTaskHosts`, and the member-credential handoff on the
 * `CREDENTIAL_UPDATE` frame. Each case reads the shape through the schema a
 * peer would, so a missing key, a loosened arm or a wrong default fails here
 * rather than on a released client.
 */

describe("principal_mismatch error code", () => {
  it("is an RPC error code a client narrows to instead of folding into RPC_ERROR", () => {
    expect(isRpcErrorCode("principal_mismatch")).toBe(true);
    expect(RPC_ERROR_CODES).toContain("principal_mismatch");
  });

  it("does not widen the narrowing to a neighbouring spelling", () => {
    expect(isRpcErrorCode("PRINCIPAL_MISMATCH")).toBe(false);
    expect(isRpcErrorCode("principal-mismatch")).toBe(false);
  });
});

describe("agent.list@10.2", () => {
  const BASE_ROW = {
    id: "agent-1",
    parentId: null,
    hostId: "host-1",
    isLocal: true,
    surface: "gui" as const,
    harnessId: "codex" as const,
    title: "Existing chat",
    isSelf: true,
    capabilities: { readTranscript: true, sendMessage: true },
    active: false,
    folderPaths: ["/repo"],
    isWorktree: false,
    runConfig: null,
    sessionState: null,
    lastExit: null,
    archived: false,
    profile: null,
    permissionMode: null,
  };
  const CALLER = { agentId: "agent-1", canSendMessages: true };

  const V102_RESPONSE = listAgentsResponseSchema.parse({
    caller: CALLER,
    scope: "user",
    agents: [
      {
        ...BASE_ROW,
        reach: "same_principal",
        hostConnectivity: UNKNOWN_CONNECTIVITY,
      },
      {
        ...BASE_ROW,
        id: "agent-2",
        isSelf: false,
        reach: "other_principal",
        hostConnectivity: {
          kind: "known",
          connectivity: "offline",
          observedAt: 1_791_000_000_000,
        },
      },
      {
        ...BASE_ROW,
        id: "agent-3",
        isSelf: false,
        reach: null,
        hostConnectivity: { kind: "unknown" },
      },
    ],
  });

  const V101_RESPONSE = listAgentsResponseSchemaV101.parse({
    caller: CALLER,
    scope: "user",
    agents: [BASE_ROW, { ...BASE_ROW, id: "agent-2", isSelf: false }],
  });

  it("keeps reach and hostConnectivity on the head schema", () => {
    expect(V102_RESPONSE.agents.map((row) => row.reach)).toEqual([
      "same_principal",
      "other_principal",
      null,
    ]);
    expect(V102_RESPONSE.agents[1].hostConnectivity).toEqual({
      kind: "known",
      connectivity: "offline",
      observedAt: 1_791_000_000_000,
    });
  });

  it("requires both keys on the head row, so a 10.1 row cannot ride as a 10.2 one", () => {
    expect(agentSummarySchema.safeParse(BASE_ROW).success).toBe(false);
    expect(
      agentSummarySchema.safeParse({ ...BASE_ROW, reach: null }).success,
    ).toBe(false);
    expect(
      agentSummarySchema.safeParse({
        ...BASE_ROW,
        hostConnectivity: UNKNOWN_CONNECTIVITY,
      }).success,
    ).toBe(false);
    expect(
      agentSummarySchema.safeParse({
        ...BASE_ROW,
        reach: "other_principal",
        hostConnectivity: UNKNOWN_CONNECTIVITY,
      }).success,
    ).toBe(true);
  });

  it("refuses a reach value outside same_principal, other_principal and null", () => {
    expect(
      agentSummarySchema.safeParse({
        ...BASE_ROW,
        reach: "someone_else",
        hostConnectivity: UNKNOWN_CONNECTIVITY,
      }).success,
    ).toBe(false);
  });

  it("strips both keys from every row when a 10.1 caller's contract parses a 10.2 answer", () => {
    const asTenOne = listAgentsResponseSchemaV101.parse(V102_RESPONSE);

    expect(asTenOne.agents).toHaveLength(3);
    for (const row of asTenOne.agents) {
      expect(Object.hasOwn(row, "reach")).toBe(false);
      expect(Object.hasOwn(row, "hostConnectivity")).toBe(false);
    }
    // Nothing else about the row moved.
    expect(asTenOne.agents[1]).toMatchObject({
      id: "agent-2",
      archived: false,
      harnessId: "codex",
    });
  });

  it("names the frozen schemas on the @10.0 and @10.1 contracts and the canonical one on the head", () => {
    expect(agentListV100.responseSchema).toBe(listAgentsResponseSchemaV100);
    expect(agentListV101.responseSchema).toBe(listAgentsResponseSchemaV101);
    expect(agentListV102.responseSchema).toBe(listAgentsResponseSchema);
    expect(agentListV102.schemaVersion).toEqual({ major: 10, minor: 2 });
  });

  it("upgrades a 10.1 response by stamping reach: null and hostConnectivity: unknown on every row", () => {
    const upgraded = agentListUpgradeV101ToV102.upgradeResponse(V101_RESPONSE);

    expect(upgraded.agents).toHaveLength(2);
    for (const row of upgraded.agents) {
      expect(row.reach).toBeNull();
      expect(row.hostConnectivity).toEqual({ kind: "unknown" });
      // `unknown`, never `offline`: an older host was never asked.
      expect(row.hostConnectivity.kind).not.toBe("known");
    }
    expect(upgraded.caller).toEqual(V101_RESPONSE.caller);
    expect(upgraded.scope).toBe(V101_RESPONSE.scope);
    expect(upgraded.agents.map((row) => row.id)).toEqual([
      "agent-1",
      "agent-2",
    ]);
    expect(() => listAgentsResponseSchema.parse(upgraded)).not.toThrow();
  });

  it("leaves the request untouched on the 10.1 -> 10.2 upgrade", () => {
    const request = {
      epicId: "epic-1",
      senderAgentId: "agent-1",
      scope: "all" as const,
    };
    expect(agentListUpgradeV101ToV102.from).toEqual({ major: 10, minor: 1 });
    expect(agentListUpgradeV101ToV102.to).toEqual({ major: 10, minor: 2 });
    expect(agentListUpgradeV101ToV102.upgradeRequest(request)).toEqual(request);
  });

  it("registers 10.2 as the latest minor of major 10, over the 10.0 and 10.1 contracts", () => {
    const line = hostRpcRegistry["agent.list"][10];

    expect(line.latestMinor).toBe(2);
    expect(line.versions[0].contract).toBe(agentListV100);
    expect(line.versions[1].contract).toBe(agentListV101);
    expect(line.versions[2].contract).toBe(agentListV102);
  });

  it("starts the 10 -> 9 bridge at 10.2 and drops both keys on the way out", () => {
    expect(agentListDowngradeV10ToV9.from).toEqual({ major: 10, minor: 2 });
    expect(agentListDowngradeV10ToV9.to).toEqual({ major: 9, minor: 2 });

    const downgraded =
      agentListDowngradeV10ToV9.downgradeResponse(V102_RESPONSE);

    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) throw new Error("expected the downgrade to succeed");
    expect(downgraded.value.agents).toHaveLength(3);
    for (const row of downgraded.value.agents) {
      expect(Object.hasOwn(row, "reach")).toBe(false);
      expect(Object.hasOwn(row, "hostConnectivity")).toBe(false);
      expect(row.archived).toBe(false);
    }
  });

  it("carries a 10.2 answer down to a major-9 caller through the registry without either key", () => {
    const result = downgradeResponseAcrossMajors(
      hostRpcRegistry["agent.list"],
      10,
      9,
      V102_RESPONSE,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the downgrade to succeed");
    for (const row of result.value.agents) {
      expect(Object.hasOwn(row, "reach")).toBe(false);
      expect(Object.hasOwn(row, "hostConnectivity")).toBe(false);
    }
  });
});

describe("host list owner (?include=owner)", () => {
  it("accepts a user owner", () => {
    const row = {
      ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
      owner: { kind: "user" as const, id: "user-1" },
    };

    expect(hostListItemSchema.parse(row).owner).toEqual({
      kind: "user",
      id: "user-1",
    });
  });

  it("accepts a team owner with its display name", () => {
    const row = {
      ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
      owner: { kind: "team" as const, id: "team-1", name: "Platform" },
    };

    expect(hostListItemSchema.parse(row).owner).toEqual({
      kind: "team",
      id: "team-1",
      name: "Platform",
    });
  });

  it("still parses a row that carries no owner, the row a client that does not ask gets", () => {
    const parsed = hostListItemSchema.parse(HOST_LIST_ITEM_GOLDEN_FIXTURE);

    expect(Object.hasOwn(parsed, "owner")).toBe(false);
  });

  it("refuses a team owner without a name, an empty name, and an unknown kind", () => {
    for (const owner of [
      { kind: "team", id: "team-1" },
      { kind: "team", id: "team-1", name: "" },
      { kind: "org", id: "org-1" },
      { kind: "user", id: "" },
    ]) {
      expect(
        hostListItemSchema.safeParse({
          ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
          owner,
        }).success,
        JSON.stringify(owner),
      ).toBe(false);
    }
  });

  it("refuses a name on the user arm and a stray key on the team arm (both arms are strict)", () => {
    expect(
      hostListItemSchema.safeParse({
        ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
        owner: { kind: "user", id: "user-1", name: "Ada" },
      }).success,
    ).toBe(false);
    expect(
      hostListItemSchema.safeParse({
        ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
        owner: { kind: "team", id: "team-1", name: "Platform", role: "admin" },
      }).success,
    ).toBe(false);
  });

  it("is not carried by the frozen @1.0 row, which is strict and so refuses it", () => {
    expect(
      hostListItemSchemaV10.safeParse(HOST_LIST_ITEM_GOLDEN_FIXTURE).success,
    ).toBe(true);
    expect(
      hostListItemSchemaV10.safeParse({
        ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
        owner: { kind: "user", id: "user-1" },
      }).success,
    ).toBe(false);
    expect(
      hostListItemSchemaV10.safeParse({
        ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
        owner: { kind: "team", id: "team-1", name: "Platform" },
      }).success,
    ).toBe(false);
  });
});

describe("SandboxSummary createdBy and wakePayer", () => {
  const SANDBOX_ROW = {
    id: "sbx_1",
    hostId: "8f6f2d7e-1f43-4c1e-9d63-1e3a7d2c9b10",
    kind: "agent",
    provider: "tensorlake",
    region: "us-east",
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: 20480,
    displayName: "build-box",
    state: "awake",
    frozen: false,
    failureCode: null,
    idleMinutes: null,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    createdAt: 1_791_000_000_000,
    lastTransitionAt: 1_791_000_010_000,
    lastActivityAt: null,
    destroyedAt: null,
    priceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
  };

  it("reads both as null from a server that predates them", () => {
    const parsed = sandboxSummarySchema.parse(SANDBOX_ROW);

    expect(parsed.createdBy).toBeNull();
    expect(parsed.wakePayer).toBeNull();
  });

  it("parses a member with a display name and one without", () => {
    const parsed = sandboxSummarySchema.parse({
      ...SANDBOX_ROW,
      createdBy: { userId: "user-1", displayName: "Ada" },
      wakePayer: { userId: "user-2", displayName: null },
    });

    expect(parsed.createdBy).toEqual({ userId: "user-1", displayName: "Ada" });
    expect(parsed.wakePayer).toEqual({ userId: "user-2", displayName: null });
  });

  it("keeps explicit nulls as nulls", () => {
    const parsed = sandboxSummarySchema.parse({
      ...SANDBOX_ROW,
      createdBy: null,
      wakePayer: null,
    });

    expect(parsed.createdBy).toBeNull();
    expect(parsed.wakePayer).toBeNull();
  });

  it("refuses a member with no user id, so the card never names an anonymous payer", () => {
    expect(
      sandboxSummarySchema.safeParse({
        ...SANDBOX_ROW,
        createdBy: { userId: "", displayName: "Ada" },
      }).success,
    ).toBe(false);
    expect(
      sandboxSummarySchema.safeParse({
        ...SANDBOX_ROW,
        wakePayer: { displayName: "Ada" },
      }).success,
    ).toBe(false);
  });
});

describe("last known connectivity", () => {
  it("parses a known observation of either connectivity", () => {
    for (const connectivity of ["connectable", "offline"] as const) {
      expect(
        lastKnownConnectivitySchema.parse({
          kind: "known",
          connectivity,
          observedAt: 1_791_000_000_000,
        }),
      ).toEqual({ kind: "known", connectivity, observedAt: 1_791_000_000_000 });
    }
  });

  it("rejects a known observation whose connectivity is unknown", () => {
    expect(
      lastKnownConnectivitySchema.safeParse({
        kind: "known",
        connectivity: "unknown",
        observedAt: 1_791_000_000_000,
      }).success,
    ).toBe(false);
  });

  it("rejects an offline kind: unknown is its own arm and is never offline", () => {
    expect(
      lastKnownConnectivitySchema.safeParse({ kind: "offline" }).success,
    ).toBe(false);
    expect(lastKnownConnectivitySchema.parse({ kind: "unknown" })).toEqual({
      kind: "unknown",
    });
    expect(UNKNOWN_CONNECTIVITY).toEqual({ kind: "unknown" });
  });

  it("rejects a known observation with no usable time", () => {
    for (const observedAt of [-1, 1.5, "yesterday"]) {
      expect(
        lastKnownConnectivitySchema.safeParse({
          kind: "known",
          connectivity: "connectable",
          observedAt,
        }).success,
        String(observedAt),
      ).toBe(false);
    }
  });
});

describe("TaskHostRow", () => {
  const ROW = {
    hostId: "host-9",
    label: "Ada's laptop",
    principal: { kind: "user" as const, id: "user-9" },
    reach: "other_principal" as const,
  };

  it("parses a row", () => {
    expect(taskHostRowSchema.parse(ROW)).toEqual(ROW);
  });

  it("parses a team principal beside a user one", () => {
    const parsed = taskHostRowSchema.parse({
      ...ROW,
      principal: { kind: "team", id: "team-1" },
      reach: "same_principal",
    });

    expect(parsed.principal).toEqual({ kind: "team", id: "team-1" });
    expect(parsed.reach).toBe("same_principal");
    expect(
      taskHostPrincipalSchema.parse({ kind: "team", id: "team-1" }),
    ).toEqual({ kind: "team", id: "team-1" });
  });

  it("accepts a null label", () => {
    const parsed = taskHostRowSchema.parse({ ...ROW, label: null });

    expect(parsed.label).toBeNull();
  });

  it("is tolerant of a field a newer server adds, and strips it", () => {
    const parsed = taskHostRowSchema.parse({ ...ROW, sandboxId: "sbx_1" });

    expect(Object.hasOwn(parsed, "sandboxId")).toBe(false);
    expect(parsed).toEqual(ROW);
  });

  it("strips a field a newer server adds to the principal, rather than refusing the row", () => {
    const parsed = taskHostRowSchema.parse({
      ...ROW,
      principal: { kind: "team", id: "team-1", name: "Platform" },
    });

    expect(Object.hasOwn(parsed.principal, "name")).toBe(false);
  });

  it("refuses a principal kind outside user and team", () => {
    for (const kind of ["org", "USER", ""]) {
      expect(
        taskHostRowSchema.safeParse({ ...ROW, principal: { kind, id: "x-1" } })
          .success,
        kind,
      ).toBe(false);
      expect(
        taskHostPrincipalSchema.safeParse({ kind, id: "x-1" }).success,
        kind,
      ).toBe(false);
    }
  });

  it("refuses an empty host id and an empty principal id", () => {
    expect(taskHostRowSchema.safeParse({ ...ROW, hostId: "" }).success).toBe(
      false,
    );
    expect(
      taskHostRowSchema.safeParse({
        ...ROW,
        principal: { kind: "user", id: "" },
      }).success,
    ).toBe(false);
    expect(
      taskHostRowSchema.safeParse({
        ...ROW,
        principal: { kind: "team", id: "" },
      }).success,
    ).toBe(false);
  });

  it("refuses a reach outside the two arms, null included", () => {
    for (const reach of [null, "someone_else", ""]) {
      expect(
        taskHostRowSchema.safeParse({ ...ROW, reach }).success,
        String(reach),
      ).toBe(false);
    }
    expect(
      taskHostRowSchema.safeParse({ ...ROW, reach: "same_principal" }).success,
    ).toBe(true);
  });

  it("refuses a row missing its host id, label, principal or reach", () => {
    for (const field of ["hostId", "label", "principal", "reach"] as const) {
      const { [field]: _omitted, ...without } = ROW;
      expect(taskHostRowSchema.safeParse(without).success, field).toBe(false);
    }
  });
});

describe("epic.listTaskHosts", () => {
  const ROW = {
    hostId: "host-9",
    label: null,
    principal: { kind: "user" as const, id: "user-9" },
    reach: "other_principal" as const,
  };

  it("needs a non-empty task id on the request", () => {
    expect(listTaskHostsRequestSchema.parse({ taskId: "epic-1" })).toEqual({
      taskId: "epic-1",
    });
    expect(listTaskHostsRequestSchema.safeParse({ taskId: "" }).success).toBe(
      false,
    );
    expect(listTaskHostsRequestSchema.safeParse({}).success).toBe(false);
  });

  it("parses the response's hosts array, empty or not", () => {
    expect(listTaskHostsResponseSchema.parse({ hosts: [] })).toEqual({
      hosts: [],
    });
    expect(
      listTaskHostsResponseSchema.parse({
        hosts: [ROW, { ...ROW, label: "x" }],
      }).hosts,
    ).toEqual([ROW, { ...ROW, label: "x" }]);
  });

  it("refuses a response whose hosts is missing or holds a bad row", () => {
    expect(listTaskHostsResponseSchema.safeParse({}).success).toBe(false);
    expect(
      listTaskHostsResponseSchema.safeParse({
        hosts: [{ ...ROW, reach: "someone_else" }],
      }).success,
    ).toBe(false);
  });

  it("strips a field a newer server adds to the response and to a row", () => {
    const parsed = listTaskHostsResponseSchema.parse({
      hosts: [{ ...ROW, sandboxId: "sbx_1" }],
      nextCursor: "c1",
    });

    expect(Object.hasOwn(parsed, "nextCursor")).toBe(false);
    expect(Object.hasOwn(parsed.hosts[0], "sandboxId")).toBe(false);
  });

  it("names the method and version 1.0 on the contract, over the same schemas", () => {
    expect(epicListTaskHostsV10.method).toBe("epic.listTaskHosts");
    expect(epicListTaskHostsV10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(epicListTaskHostsV10.requestSchema).toBe(listTaskHostsRequestSchema);
    expect(epicListTaskHostsV10.responseSchema).toBe(
      listTaskHostsResponseSchema,
    );
  });

  it("registers 1.0 as the only version of major 1, degrading to unsupported", () => {
    const entry = hostRpcRegistry["epic.listTaskHosts"];

    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(epicListTaskHostsV10);
    expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
    expect(entry.degrade).toEqual({ kind: "unsupported" });
  });
});

describe("credentialUpdatePayloadSchema", () => {
  const HANDOFF = {
    token: "member-access",
    refreshToken: "member-refresh",
    familyId: "family-1",
    provisionedAt: "2026-10-16T12:00:00.000Z",
  };

  it("pins the wire value of the member-credential capability tag, apart from credentialUpdate", () => {
    expect(SESSION_CAPABILITY_MEMBER_CREDENTIAL).toBe("memberCredential");
    expect(SESSION_CAPABILITY_MEMBER_CREDENTIAL).not.toBe(
      SESSION_CAPABILITY_CREDENTIAL_UPDATE,
    );
  });

  it("reads a released-shape bearer frame with memberCredential: null", () => {
    expect(credentialUpdatePayloadSchema.parse({ bearer: "x" })).toEqual({
      bearer: "x",
      memberCredential: null,
    });
  });

  it("rejects a frame with a null bearer and no member credential, absent or null", () => {
    expect(
      credentialUpdatePayloadSchema.safeParse({ bearer: null }).success,
    ).toBe(false);
    expect(
      credentialUpdatePayloadSchema.safeParse({
        bearer: null,
        memberCredential: null,
      }).success,
    ).toBe(false);
  });

  it("accepts a member credential beside a null bearer, and beside a bearer", () => {
    expect(
      credentialUpdatePayloadSchema.parse({
        bearer: null,
        memberCredential: HANDOFF,
      }),
    ).toEqual({ bearer: null, memberCredential: HANDOFF });
    expect(
      credentialUpdatePayloadSchema.parse({
        bearer: "x",
        memberCredential: HANDOFF,
      }),
    ).toEqual({ bearer: "x", memberCredential: HANDOFF });
  });

  it("rejects a provisionedAt that is not an ISO millisecond timestamp", () => {
    for (const provisionedAt of [
      "yesterday",
      "2026-10-16",
      "2026-10-16T12:00:00Z",
      "2026-10-16T12:00:00.5Z",
      "",
    ]) {
      expect(
        credentialUpdatePayloadSchema.safeParse({
          bearer: null,
          memberCredential: { ...HANDOFF, provisionedAt },
        }).success,
        provisionedAt,
      ).toBe(false);
    }
  });

  it("rejects an extra key inside memberCredential (the handoff is strict)", () => {
    expect(
      credentialUpdatePayloadSchema.safeParse({
        bearer: null,
        memberCredential: { ...HANDOFF, scope: "admin" },
      }).success,
    ).toBe(false);
  });

  it("rejects a handoff missing a field or carrying an empty one", () => {
    for (const field of [
      "token",
      "refreshToken",
      "familyId",
      "provisionedAt",
    ] as const) {
      const { [field]: _omitted, ...without } = HANDOFF;
      expect(
        credentialUpdatePayloadSchema.safeParse({
          bearer: null,
          memberCredential: without,
        }).success,
        `missing ${field}`,
      ).toBe(false);
    }
    expect(
      credentialUpdatePayloadSchema.safeParse({
        bearer: null,
        memberCredential: { ...HANDOFF, token: "" },
      }).success,
    ).toBe(false);
  });
});
