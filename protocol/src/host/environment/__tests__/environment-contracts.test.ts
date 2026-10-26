import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { validateVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/versioned-rpc";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  environmentConfigurationGuideGetUpgradeV10ToV11,
  environmentConfigurationGuideGetV10,
  environmentConfigurationGuideGetV11,
  environmentConfigurationGuideResetV10,
  environmentConfigurationGuideSetV10,
  environmentConfigurationItemsDeleteV10,
  environmentConfigurationItemsPutV10,
  environmentConfigurationItemsV10,
  environmentConfigurationMcpServersDeleteV10,
  environmentConfigurationMcpServersSetEnabledV10,
  environmentConfigurationMcpServersListV10,
  environmentConfigurationMcpServersPutUpgradeV10ToV11,
  environmentConfigurationMcpServersPutV10,
  environmentConfigurationMcpServersPutV11,
  environmentConfigurationPolicyPutV10,
  environmentConfigurationSkillsListV10,
  environmentConfigurationSkillsRemoveV10,
  environmentConfigurationSkillsSetProvidersV10,
  environmentConfigurationSkillsUploadV10,
  environmentHistoryV10,
  environmentPlansListV10,
  environmentPlansUnlinkPreviewV10,
  environmentPlansUnlinkV10,
  ENVIRONMENT_POLICY_MAX_BYTES,
  ENVIRONMENT_SKILL_ARCHIVE_MAX_BYTES,
} from "@traycer/protocol/host/environment/configuration-contracts";
import {
  environmentHostBindV10,
  environmentHostListV10,
  environmentHostListV11,
  environmentHostReadV10,
  environmentListUpgradeV10ToV11,
  environmentListV10,
  environmentListV11,
  environmentMembersInviteV10,
  environmentMembersNoticeSeenV10,
  environmentInvitationsAcceptV10,
  environmentInvitationsListV10,
  environmentMembersSeatsV10,
  environmentMembersRemovePreviewV10,
  environmentMembersRemoveV10,
  environmentMembersSetRoleV10,
  environmentMembersV10,
  environmentSetMainBotV10,
  type EnvironmentMembersResponseV11,
} from "@traycer/protocol/host/environment/contracts";
import {
  ENVIRONMENT_MOVE_ITEM_CHOICE_PREFIX,
  environmentMoveAcceptV10,
  environmentMoveItemChoiceKey,
  environmentMovePlanUpgradeV10ToV11,
  environmentMovePlanUpgradeV11ToV12,
  environmentMovePlanV10,
  environmentMovePlanV11,
  environmentMovePlanV12,
  environmentMoveStopPreviewUpgradeV10ToV11,
  environmentMoveStopPreviewV10,
  environmentMoveStopPreviewV11,
  environmentMoveStopV10,
} from "@traycer/protocol/host/environment/move-contracts";
import { ENVIRONMENT_REDESIGN_RPC_METHODS } from "@traycer/protocol/host/environment/redesign-rpc-methods";

const PERSONAL = {
  environmentId: "env_01J0000000000000000000001",
  ownerKind: "user",
  ownerId: "user-1",
  roomId: "b".repeat(64),
  label: "Personal",
};

const TEAM = {
  environmentId: "env_01J0000000000000000000002",
  ownerKind: "organization",
  ownerId: "team-1",
  roomId: "a".repeat(64),
  label: "acme",
};

describe("environment.list protocol contract", () => {
  it("parses an empty request and a list of personal and team environments", () => {
    expect(environmentListV10.requestSchema.parse({})).toEqual({});
    const response = { environments: [PERSONAL, TEAM] };
    expect(environmentListV10.responseSchema.parse(response)).toEqual(response);
  });

  it("rejects an unknown owner kind, a missing room, or a bare array root", () => {
    const { roomId: _roomId, ...noRoom } = TEAM;
    for (const bad of [
      { environments: [{ ...TEAM, ownerKind: "bot" }] },
      { environments: [noRoom] },
      [PERSONAL],
    ]) {
      expect(environmentListV10.responseSchema.safeParse(bad).success).toBe(
        false,
      );
    }
  });

  it("registers off the released floor with unsupported degrade", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("environment.list");
    const entry = hostRpcRegistry["environment.list"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(1);
    expect(entry[1].versions[0].contract).toBe(environmentListV10);
    expect(entry[1].versions[1].contract).toBe(environmentListV11);
    expect(entry[1].versions[1].upgradeFromPreviousVersion).toBe(
      environmentListUpgradeV10ToV11,
    );
  });
});

describe("environment.host.read / .bind / .list protocol contracts", () => {
  it("answer the host id, its environment and whether the binding is explicit", () => {
    const unbound = {
      hostId: "host-1",
      environment: PERSONAL,
      explicit: false,
      enrolledByUserId: null,
      canUnbind: false,
    };
    const bound = {
      hostId: "host-1",
      environment: TEAM,
      explicit: true,
      enrolledByUserId: "user-1",
      canUnbind: true,
    };
    expect(environmentHostReadV10.requestSchema.parse({})).toEqual({});
    expect(environmentHostReadV10.responseSchema.parse(unbound)).toEqual(
      unbound,
    );
    expect(
      environmentHostBindV10.requestSchema.parse({
        environmentId: TEAM.environmentId,
      }),
    ).toEqual({ environmentId: TEAM.environmentId });
    expect(environmentHostBindV10.responseSchema.parse(bound)).toEqual(bound);
  });

  it("rejects a bind without an environment and a binding missing a field", () => {
    expect(environmentHostBindV10.requestSchema.safeParse({}).success).toBe(
      false,
    );
    expect(
      environmentHostBindV10.requestSchema.safeParse({ environmentId: "" })
        .success,
    ).toBe(false);
    const full = {
      hostId: "host-1",
      environment: PERSONAL,
      explicit: false,
      enrolledByUserId: null,
      canUnbind: false,
    };
    for (const key of ["explicit", "enrolledByUserId", "canUnbind"] as const) {
      const { [key]: _dropped, ...partial } = full;
      expect(
        environmentHostReadV10.responseSchema.safeParse(partial).success,
      ).toBe(false);
    }
    expect(
      environmentHostReadV10.responseSchema.safeParse({
        ...full,
        enrolledByUserId: "",
      }).success,
    ).toBe(false);
  });

  it("register off the released floor with unsupported degrade", () => {
    for (const [method, contract] of [
      ["environment.host.read", environmentHostReadV10],
      ["environment.host.bind", environmentHostBindV10],
      ["environment.host.list", environmentHostListV10],
      ["environment.members", environmentMembersV10],
    ] as const) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].versions[0].contract).toBe(contract);
    }
    // read and bind stay at @1.0; host.list grew @1.1 and @1.2 MINORs,
    // members @1.1 and @1.2.
    expect(hostRpcRegistry["environment.host.read"][1].latestMinor).toBe(0);
    expect(hostRpcRegistry["environment.host.bind"][1].latestMinor).toBe(0);
    expect(hostRpcRegistry["environment.host.list"][1].latestMinor).toBe(2);
    expect(hostRpcRegistry["environment.members"][1].latestMinor).toBe(2);
  });
});

describe("environment.host.list protocol contract", () => {
  it("parses an environment id and every host bound to it", () => {
    expect(
      environmentHostListV10.requestSchema.parse({
        environmentId: TEAM.environmentId,
      }),
    ).toEqual({ environmentId: TEAM.environmentId });
    const response = {
      hosts: [
        {
          hostId: "host-1",
          hostLabel: "studio",
          hostPlatform: "darwin-arm64",
          enrolledByUserId: "user-1",
          kind: "personal",
          boundAt: 1_700_000_000_000,
        },
        {
          hostId: "host-2",
          hostLabel: null,
          hostPlatform: null,
          enrolledByUserId: "user-2",
          kind: "sandbox",
          boundAt: 1_700_000_000_001,
        },
      ],
    };
    expect(environmentHostListV10.responseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("rejects a request without an environment, a host without its enroller or kind, a kind it does not know, or a bare array root", () => {
    expect(environmentHostListV10.requestSchema.safeParse({}).success).toBe(
      false,
    );
    const host = {
      hostId: "host-1",
      hostLabel: null,
      hostPlatform: null,
      enrolledByUserId: "user-1",
      kind: "personal",
      boundAt: 1,
    };
    const { enrolledByUserId: _enrolledBy, ...noEnroller } = host;
    const { kind: _kind, ...noKind } = host;
    for (const bad of [
      { hosts: [noEnroller] },
      { hosts: [noKind] },
      { hosts: [{ ...host, kind: "laptop" }] },
      [host],
    ]) {
      expect(environmentHostListV10.responseSchema.safeParse(bad).success).toBe(
        false,
      );
    }
  });
});

describe("environment.members protocol contract", () => {
  it("parses a first-page request, a cursor, and a page of members with a next cursor", () => {
    for (const request of [
      { environmentId: TEAM.environmentId, cursor: null },
      { environmentId: TEAM.environmentId, cursor: "user-2" },
    ]) {
      expect(environmentMembersV10.requestSchema.parse(request)).toEqual(
        request,
      );
    }
    const response = {
      members: [
        { userId: "user-1", displayName: "Ada", avatarUrl: "https://a/1.png" },
        { userId: "user-2", displayName: null, avatarUrl: null },
      ],
      nextCursor: "user-2",
    };
    expect(environmentMembersV10.responseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("rejects a request without a cursor, a member without a user id, an empty name, an empty next cursor, or a bare array root", () => {
    expect(
      environmentMembersV10.requestSchema.safeParse({
        environmentId: TEAM.environmentId,
      }).success,
    ).toBe(false);
    const member = { userId: "user-1", displayName: "Ada", avatarUrl: null };
    const { userId: _userId, ...noUser } = member;
    for (const bad of [
      { members: [noUser], nextCursor: null },
      { members: [{ ...member, displayName: "" }], nextCursor: null },
      { members: [member], nextCursor: "" },
      [member],
    ]) {
      expect(environmentMembersV10.responseSchema.safeParse(bad).success).toBe(
        false,
      );
    }
  });
});

describe("environment.setMainBot protocol contract", () => {
  const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

  it("round-trips a request and the response naming the main bot", () => {
    const request = { environmentId: TEAM.environmentId, botId: BOT_ID };
    expect(environmentSetMainBotV10.requestSchema.parse(request)).toEqual(
      request,
    );
    const response = { environmentId: TEAM.environmentId, mainBotId: BOT_ID };
    expect(environmentSetMainBotV10.responseSchema.parse(response)).toEqual(
      response,
    );
  });

  it("rejects an environment id over 36 characters, an empty one, and a bot id of the wrong shape", () => {
    for (const bad of [
      { environmentId: "e".repeat(37), botId: BOT_ID },
      { environmentId: "", botId: BOT_ID },
      { environmentId: TEAM.environmentId, botId: "not-a-bot" },
      { botId: BOT_ID },
    ]) {
      expect(
        environmentSetMainBotV10.requestSchema.safeParse(bad).success,
      ).toBe(false);
    }
    expect(
      environmentSetMainBotV10.requestSchema.safeParse({
        environmentId: "e".repeat(36),
        botId: BOT_ID,
      }).success,
    ).toBe(true);
  });

  it("registers off the released floor with unsupported degrade", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("environment.setMainBot");
    const entry = hostRpcRegistry["environment.setMainBot"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(environmentSetMainBotV10);
  });
});

describe("environment.list@1.1, environment.host.list@1.1 and environment.members@1.1 upgrade from @1.0 through the registry", () => {
  const ONE_ZERO = { major: 1, minor: 0 } as const;
  const ONE_ONE = { major: 1, minor: 1 } as const;
  const ONE_TWO = { major: 1, minor: 2 } as const;

  it("upgrades environment.list: a user-owned environment is the caller's own personal one, any other is a team they only view", () => {
    const response = environmentListV10.responseSchema.parse({
      environments: [PERSONAL, TEAM],
    });
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["environment.list"],
      ONE_ZERO,
      ONE_ONE,
      response,
    );
    expect(upgraded).toEqual({
      environments: [
        {
          ...PERSONAL,
          effectiveRole: "owner",
          kind: "personal",
          hostCount: 0,
          providerHandle: null,
        },
        {
          ...TEAM,
          effectiveRole: "viewer",
          kind: "team",
          hostCount: 0,
          providerHandle: null,
        },
      ],
    });
    // The upgraded answer is a valid @1.1 answer, and the request is untouched.
    expect(environmentListV11.responseSchema.parse(upgraded)).toEqual(upgraded);
    expect(
      upgradeRequestToVersion(
        hostRpcRegistry["environment.list"],
        ONE_ZERO,
        ONE_ONE,
        environmentListV10.requestSchema.parse({}),
      ),
    ).toEqual({});
    expect(environmentListUpgradeV10ToV11.to).toEqual(ONE_ONE);
  });

  it("parses an @1.1 environment with its role, kind, host count and provider handle, and rejects a role it does not know", () => {
    const team = {
      ...TEAM,
      effectiveRole: "admin",
      kind: "team",
      hostCount: 3,
      providerHandle: "acme",
    };
    expect(
      environmentListV11.responseSchema.parse({ environments: [team] }),
    ).toEqual({ environments: [team] });
    for (const bad of [
      { ...team, effectiveRole: "superuser" },
      { ...team, kind: "group" },
      { ...team, hostCount: -1 },
      { ...team, providerHandle: "" },
    ]) {
      expect(
        environmentListV11.responseSchema.safeParse({ environments: [bad] })
          .success,
      ).toBe(false);
    }
  });

  it("upgrades environment.host.list: every host is not known to be reachable, never reported, with no apply states", () => {
    const host = {
      hostId: "host-1",
      hostLabel: "studio",
      hostPlatform: "darwin-arm64",
      enrolledByUserId: "user-1",
      kind: "personal",
      boundAt: 1_700_000_000_000,
    };
    const response = environmentHostListV10.responseSchema.parse({
      hosts: [host],
    });
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["environment.host.list"],
      ONE_ZERO,
      ONE_ONE,
      response,
    );
    expect(upgraded).toEqual({
      hosts: [{ ...host, reachable: false, lastReportedAt: null, applied: [] }],
    });
    const request = environmentHostListV10.requestSchema.parse({
      environmentId: TEAM.environmentId,
    });
    expect(
      upgradeRequestToVersion(
        hostRpcRegistry["environment.host.list"],
        ONE_ZERO,
        ONE_ONE,
        request,
      ),
    ).toEqual(request);
  });

  it("upgrades environment.host.list@1.1 to @1.2: every host has not said whether it has a Local row", () => {
    const host = {
      hostId: "host-1",
      hostLabel: "studio",
      hostPlatform: "darwin-arm64",
      enrolledByUserId: "user-1",
      kind: "personal",
      boundAt: 1_700_000_000_000,
      reachable: true,
      lastReportedAt: 1_700_000_000_000,
      applied: [],
    };
    const response = environmentHostListV11.responseSchema.parse({
      hosts: [host, { ...host, hostId: "host-2" }],
    });
    expect(
      upgradeResponseToVersion(
        hostRpcRegistry["environment.host.list"],
        ONE_ONE,
        ONE_TWO,
        response,
      ),
    ).toEqual({
      hosts: [
        { ...host, hasLocalRow: null },
        { ...host, hostId: "host-2", hasLocalRow: null },
      ],
    });
  });

  it("keeps hasLocalRow on an @1.2 host, and a @1.1 caller's reparse drops it", () => {
    const v11 =
      hostRpcRegistry["environment.host.list"][1].versions[1].contract;
    const v12 =
      hostRpcRegistry["environment.host.list"][1].versions[2].contract;
    const host = {
      hostId: "host-1",
      hostLabel: "studio",
      hostPlatform: "darwin-arm64",
      enrolledByUserId: "user-1",
      kind: "personal",
      boundAt: 1_700_000_000_000,
      reachable: true,
      lastReportedAt: 1_700_000_000_000,
      applied: [],
    };
    const answer = { hosts: [{ ...host, hasLocalRow: true }] };
    expect(v12.responseSchema.parse(answer)).toEqual(answer);
    expect(v11.responseSchema.parse(answer)).toEqual({ hosts: [host] });
  });

  it("parses an @1.1 host with null enroller and bind time, which @1.0 rejects, and rejects an unknown apply state", () => {
    const v10 =
      hostRpcRegistry["environment.host.list"][1].versions[0].contract;
    const v11 =
      hostRpcRegistry["environment.host.list"][1].versions[1].contract;
    const host = {
      hostId: "host-1",
      hostLabel: null,
      hostPlatform: null,
      enrolledByUserId: null,
      kind: "personal",
      boundAt: null,
      reachable: true,
      lastReportedAt: 1_700_000_000_000,
      applied: [
        {
          itemKey: "variable:A:B",
          state: "not_applied",
          reason: "permission_denied",
          at: 1,
        },
      ],
    };
    expect(v11.responseSchema.parse({ hosts: [host] })).toEqual({
      hosts: [host],
    });
    expect(v10.responseSchema.safeParse({ hosts: [host] }).success).toBe(false);
    expect(
      v11.responseSchema.safeParse({
        hosts: [
          { ...host, applied: [{ ...host.applied[0], state: "exploded" }] },
        ],
      }).success,
    ).toBe(false);
  });

  it("upgrades environment.members: each member is the least role with no plan or invitation, and the page has no notice", () => {
    const response = environmentMembersV10.responseSchema.parse({
      members: [
        { userId: "user-1", displayName: "Ada", avatarUrl: null },
        { userId: "user-2", displayName: null, avatarUrl: "https://a/2.png" },
      ],
      nextCursor: "user-2",
    });
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["environment.members"],
      ONE_ZERO,
      ONE_ONE,
      response,
    );
    expect(upgraded).toEqual({
      members: response.members.map((member) => ({
        ...member,
        effectiveRole: "viewer",
        linkedPlan: false,
        inviteState: null,
        invitedAddress: null,
      })),
      nextCursor: "user-2",
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    });
  });

  it("upgrades an environment.members@1.1 page to @1.2 with each member's email null, and parses an @1.2 email", () => {
    const v11Page: EnvironmentMembersResponseV11 = {
      members: [
        {
          userId: "user-1",
          displayName: "Ada",
          avatarUrl: null,
          effectiveRole: "admin",
          linkedPlan: false,
          inviteState: "accepted",
          invitedAddress: null,
        },
      ],
      nextCursor: null,
      legacyRoleNoticeSeenAt: 1_700_000_000_000,
      legacyMembers: ["Grace"],
    };
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["environment.members"],
      ONE_ONE,
      ONE_TWO,
      v11Page,
    );
    expect(upgraded).toEqual({
      ...v11Page,
      members: [{ ...v11Page.members[0], email: null }],
    });

    const v12 = hostRpcRegistry["environment.members"][1].versions[2].contract;
    const withEmail = {
      ...v11Page,
      members: [{ ...v11Page.members[0], email: "ada@example.com" }],
    };
    expect(v12.responseSchema.parse(withEmail)).toEqual(withEmail);
    expect(
      v12.responseSchema.safeParse({
        ...v11Page,
        members: [{ ...v11Page.members[0], email: "" }],
      }).success,
    ).toBe(false);
  });

  it("parses an @1.1 member carrying an invitation and rejects a role or invite state it does not know", () => {
    const v11 = hostRpcRegistry["environment.members"][1].versions[1].contract;
    const member = {
      userId: "user-1",
      displayName: null,
      avatarUrl: null,
      effectiveRole: "editor",
      linkedPlan: true,
      inviteState: "pending",
      invitedAddress: "ada@example.com",
    };
    const page = {
      members: [member],
      nextCursor: null,
      legacyRoleNoticeSeenAt: 1_700_000_000_000,
      legacyMembers: ["Grace"],
    };
    expect(v11.responseSchema.parse(page)).toEqual(page);
    for (const bad of [
      { ...member, effectiveRole: "owner" },
      { ...member, inviteState: "expired" },
      { ...member, invitedAddress: "" },
    ]) {
      expect(
        v11.responseSchema.safeParse({ ...page, members: [bad] }).success,
      ).toBe(false);
    }
  });
});

interface RedesignWireCase {
  readonly method: keyof typeof ENVIRONMENT_REDESIGN_RPC_METHODS;
  readonly contract: {
    readonly requestSchema: z.ZodType;
    readonly responseSchema: z.ZodType;
  };
  readonly request: unknown;
  readonly badRequest: unknown;
  readonly response: unknown;
  readonly badResponse: unknown;
}

const MOVE_ROW = {
  kind: "variable",
  key: "API_BASE",
  os: null,
  label: "API_BASE",
  detail: null,
};
const ITEM_ADDRESS = {
  environmentId: TEAM.environmentId,
  kind: "variable",
  key: "API_BASE",
  os: "any",
  revision: 3,
};

const REDESIGN_WIRE_CASES: readonly RedesignWireCase[] = [
  {
    method: "environment.move.plan",
    contract: environmentMovePlanV10,
    request: {},
    badRequest: "plan",
    response: {
      planHash: "h1",
      planRevision: 2,
      hostVersion: "1.4.0",
      disclosureVersion: 1,
      rows: {
        moves: [MOVE_ROW],
        staysOnThisComputer: [],
        alreadyInPersonal: [],
        differsMasked: [],
        looksLikeAKey: [],
      },
    },
    badResponse: {
      planHash: "h1",
      planRevision: 2,
      hostVersion: "1.4.0",
      disclosureVersion: 1,
      rows: { moves: [MOVE_ROW] },
    },
  },
  {
    method: "environment.move.accept",
    contract: environmentMoveAcceptV10,
    request: {
      planHash: "h1",
      keyChoices: [{ key: "TOKEN", choice: "secret" }],
    },
    badRequest: {
      planHash: "h1",
      keyChoices: [{ key: "TOKEN", choice: "sell" }],
    },
    response: { outcome: "accepted", attemptId: "a1", consentId: "c1" },
    badResponse: { outcome: "accepted", attemptId: "a1" },
  },
  {
    method: "environment.move.stopPreview",
    contract: environmentMoveStopPreviewV10,
    request: {},
    badRequest: 7,
    response: {
      managed: [MOVE_ROW],
      needsChoice: [{ row: MOVE_ROW, reason: "edited_here" }],
    },
    badResponse: {
      managed: [],
      needsChoice: [{ row: MOVE_ROW, reason: "forgotten" }],
    },
  },
  {
    method: "environment.move.stop",
    contract: environmentMoveStopV10,
    request: {
      choices: [{ kind: "variable", key: "TOKEN", choice: "keep_locally" }],
    },
    badRequest: {
      choices: [{ kind: "variable", key: "TOKEN", choice: "burn" }],
    },
    response: { outcome: "stopped" },
    badResponse: { outcome: "gone" },
  },
  {
    method: "environment.configuration.items",
    contract: environmentConfigurationItemsV10,
    request: { environmentId: TEAM.environmentId },
    badRequest: { environmentId: "" },
    response: {
      items: [
        {
          kind: "variable",
          key: "API_BASE",
          os: "any",
          value: "https://api.example.com",
          revision: 3,
          updatedAt: 1_700_000_000_000,
          writtenBy: { source: "live", hostId: null, hostName: null },
        },
      ],
    },
    badResponse: {
      items: [
        {
          kind: "variable",
          key: "API_BASE",
          os: "any",
          value: "x",
          updatedAt: 1,
          writtenBy: { source: "live", hostId: null, hostName: null },
        },
      ],
    },
  },
  {
    method: "environment.configuration.items.put",
    contract: environmentConfigurationItemsPutV10,
    request: { ...ITEM_ADDRESS, value: { url: "https://a" }, revision: null },
    badRequest: { ...ITEM_ADDRESS, revision: null },
    response: { outcome: "saved", revision: 4 },
    badResponse: { outcome: "merged" },
  },
  {
    method: "environment.configuration.items.delete",
    contract: environmentConfigurationItemsDeleteV10,
    request: ITEM_ADDRESS,
    badRequest: { ...ITEM_ADDRESS, os: "plan9" },
    response: { outcome: "conflict", current: null },
    badResponse: { outcome: "conflict" },
  },
  {
    method: "environment.configuration.mcpServers.put",
    contract: environmentConfigurationMcpServersPutV10,
    request: {
      environmentId: TEAM.environmentId,
      serverId: null,
      name: "docs",
      transport: "http",
      url: "https://mcp.example.com",
      command: null,
      args: [],
      env: ["DOCS_TOKEN"],
      toolToggles: { claude: { search: true } },
      credential: { kind: "pat", pat: "ghp_x" },
    },
    badRequest: {
      environmentId: TEAM.environmentId,
      serverId: null,
      name: "docs",
      transport: "websocket",
      url: null,
      command: null,
      args: [],
      env: [],
      toolToggles: {},
      credential: { kind: "unchanged" },
    },
    response: { outcome: "refused", reason: "invalid_body" },
    badResponse: { outcome: "saved" },
  },
  {
    method: "environment.configuration.mcpServers.list",
    contract: environmentConfigurationMcpServersListV10,
    request: { environmentId: TEAM.environmentId },
    badRequest: {},
    response: {
      servers: [
        {
          serverId: "3f1c0d1e-0000-4000-8000-000000000001",
          name: "docs",
          transport: "http",
          url: "https://mcp.example.com",
          command: null,
          args: [],
          env: [],
          credential: {
            kind: "secret",
            secretId: "secret-1",
            secretName: "DOCS_TOKEN",
            owned: false,
          },
          item: {
            key: "docs",
            revision: 4,
            toolToggles: { claude: { search: false } },
            offFor: ["codex"],
          },
        },
        {
          serverId: "3f1c0d1e-0000-4000-8000-000000000002",
          name: "local",
          transport: "stdio",
          url: null,
          command: "npx",
          args: ["-y", "server"],
          env: [],
          credential: {
            kind: "none",
            secretId: null,
            secretName: null,
            owned: false,
          },
          item: null,
        },
      ],
    },
    badResponse: { servers: [{ serverId: "s", name: "docs" }] },
  },
  {
    method: "environment.configuration.mcpServers.delete",
    contract: environmentConfigurationMcpServersDeleteV10,
    request: { environmentId: TEAM.environmentId, serverId: "s-1" },
    badRequest: { environmentId: TEAM.environmentId, serverId: "" },
    response: { outcome: "saved", reason: null },
    badResponse: { outcome: "not_served", reason: null },
  },
  {
    method: "environment.configuration.mcpServers.setEnabled",
    contract: environmentConfigurationMcpServersSetEnabledV10,
    request: {
      environmentId: TEAM.environmentId,
      serverId: "s-1",
      enabled: false,
    },
    badRequest: { environmentId: TEAM.environmentId, serverId: "s-1" },
    response: { outcome: "saved", reason: null },
    badResponse: { outcome: "not_served", reason: null },
  },
  {
    method: "environment.configuration.skills.list",
    contract: environmentConfigurationSkillsListV10,
    request: { environmentId: TEAM.environmentId },
    badRequest: { environmentId: "" },
    response: {
      outcome: "listed",
      revision: null,
      skills: [
        {
          name: "release-notes",
          description: null,
          origin: "room",
          edited: false,
          offFor: ["codex"],
        },
      ],
    },
    badResponse: { outcome: "listed", skills: [] },
  },
  {
    method: "environment.configuration.skills.remove",
    contract: environmentConfigurationSkillsRemoveV10,
    request: { environmentId: TEAM.environmentId, name: "release-notes" },
    badRequest: { environmentId: TEAM.environmentId, name: "" },
    response: { outcome: "refused", reason: "not_found" },
    badResponse: { outcome: "saved", reason: null },
  },
  {
    method: "environment.configuration.skills.setProviders",
    contract: environmentConfigurationSkillsSetProvidersV10,
    request: {
      environmentId: TEAM.environmentId,
      name: "release-notes",
      offFor: ["codex"],
      revision: null,
    },
    badRequest: {
      environmentId: TEAM.environmentId,
      name: "release-notes",
      offFor: "codex",
      revision: null,
    },
    response: { outcome: "stale", revision: "abc123", reason: null },
    badResponse: { outcome: "saved", reason: null },
  },
  {
    method: "environment.configuration.skills.upload",
    contract: environmentConfigurationSkillsUploadV10,
    request: {
      environmentId: TEAM.environmentId,
      name: "lint-fix",
      archive: "H4sIAAAAAAAA",
    },
    badRequest: {
      environmentId: TEAM.environmentId,
      name: "lint-fix",
      archive: "not base64!",
    },
    response: { outcome: "not_served", reason: null },
    badResponse: { outcome: "elsewhere", reason: null },
  },
  {
    method: "environment.configuration.policy.put",
    contract: environmentConfigurationPolicyPutV10,
    request: {
      environmentId: TEAM.environmentId,
      body: "{}",
      policyVersion: "7",
    },
    badRequest: {
      environmentId: TEAM.environmentId,
      body: "{}",
      policyVersion: "07",
    },
    response: { outcome: "forbidden", reason: null },
    badResponse: { outcome: "forbidden", reason: "" },
  },
  {
    method: "environment.configuration.guide.get",
    contract: environmentConfigurationGuideGetV10,
    request: { environmentId: TEAM.environmentId },
    badRequest: {},
    response: { outcome: "ok", text: "Prefer small models.", revision: "r1" },
    badResponse: { outcome: "ok", text: "Prefer small models." },
  },
  {
    method: "environment.configuration.guide.set",
    contract: environmentConfigurationGuideSetV10,
    request: { environmentId: TEAM.environmentId, text: "t", revision: "r1" },
    badRequest: { environmentId: TEAM.environmentId, text: "t", revision: "" },
    response: { outcome: "conflict" },
    badResponse: { outcome: "ok" },
  },
  {
    method: "environment.configuration.guide.reset",
    contract: environmentConfigurationGuideResetV10,
    request: { environmentId: TEAM.environmentId },
    badRequest: { environmentId: "" },
    response: { outcome: "not_served" },
    badResponse: { outcome: "conflict" },
  },
  {
    method: "environment.history",
    contract: environmentHistoryV10,
    request: { environmentId: TEAM.environmentId, subject: null },
    badRequest: {
      environmentId: TEAM.environmentId,
      subject: { kind: "variable" },
    },
    response: {
      entries: [
        {
          at: 1,
          actor: { label: "Ada", tombstoned: false },
          operation: "put",
          outcome: "saved",
        },
      ],
      readerScope: "own",
      hostStates: [],
    },
    badResponse: { entries: [], readerScope: "everything", hostStates: [] },
  },
  {
    method: "environment.plans.list",
    contract: environmentPlansListV10,
    request: { environmentId: TEAM.environmentId },
    badRequest: {},
    response: {
      plans: [
        {
          profileId: "p1",
          harness: "claude-code",
          status: "linked",
          linkedBy: { name: "Ada", you: true },
        },
      ],
    },
    badResponse: {
      plans: [
        {
          profileId: "p1",
          harness: "claude-code",
          status: "gone",
          linkedBy: null,
        },
      ],
    },
  },
  {
    method: "environment.plans.unlinkPreview",
    contract: environmentPlansUnlinkPreviewV10,
    request: { environmentId: TEAM.environmentId, profileId: "p1" },
    badRequest: { environmentId: TEAM.environmentId },
    response: { activeTurns: null, localHostId: null, keepsWorking: ["Docs"] },
    badResponse: { activeTurns: -1, localHostId: null, keepsWorking: [] },
  },
  {
    method: "environment.plans.unlink",
    contract: environmentPlansUnlinkV10,
    request: { environmentId: TEAM.environmentId, profileId: "p1" },
    badRequest: { environmentId: "", profileId: "p1" },
    response: { outcome: "not_linked" },
    badResponse: { outcome: "linked" },
  },
  {
    method: "environment.members.invite",
    contract: environmentMembersInviteV10,
    request: {
      environmentId: TEAM.environmentId,
      email: "a@b.co",
      role: "editor",
    },
    badRequest: {
      environmentId: TEAM.environmentId,
      email: "a@b.co",
      role: "owner",
    },
    response: { outcome: "sent", seatDelta: { used: 3, total: 5 } },
    badResponse: { outcome: "sent" },
  },
  {
    method: "environment.members.setRole",
    contract: environmentMembersSetRoleV10,
    request: {
      environmentId: TEAM.environmentId,
      userId: "u1",
      role: "viewer",
    },
    badRequest: {
      environmentId: TEAM.environmentId,
      userId: "",
      role: "viewer",
    },
    response: { outcome: "last_admin" },
    badResponse: { outcome: "demoted" },
  },
  {
    method: "environment.members.remove",
    contract: environmentMembersRemoveV10,
    request: { environmentId: TEAM.environmentId, userId: "u1" },
    badRequest: { environmentId: TEAM.environmentId },
    response: { outcome: "pending", receiptId: "r1" },
    badResponse: { outcome: "pending" },
  },
  {
    method: "environment.members.removePreview",
    contract: environmentMembersRemovePreviewV10,
    request: { environmentId: TEAM.environmentId, userId: "u1" },
    badRequest: { userId: "u1" },
    response: {
      activeTurns: 2,
      terminals: 1,
      localHostId: "host-1",
      sharedSignIns: ["GitHub"],
      paidSandboxes: [{ name: "build", startedBy: "Ada" }],
      linkedPlan: null,
    },
    badResponse: {
      activeTurns: null,
      terminals: null,
      localHostId: null,
      sharedSignIns: [],
      paidSandboxes: [{ name: "build" }],
      linkedPlan: null,
    },
  },
  {
    method: "environment.members.seats",
    contract: environmentMembersSeatsV10,
    request: { environmentId: TEAM.environmentId },
    badRequest: { environmentId: "" },
    response: { seats: { used: 4, total: 5 } },
    badResponse: { seats: { used: -1, total: 5 } },
  },
  {
    method: "environment.invitations.list",
    contract: environmentInvitationsListV10,
    request: {},
    badRequest: "list",
    response: {
      invitations: [
        {
          environmentId: TEAM.environmentId,
          teamName: "Acme",
          role: "editor",
          paidPlan: true,
        },
      ],
    },
    badResponse: {
      invitations: [
        {
          environmentId: TEAM.environmentId,
          teamName: "Acme",
          role: "editor",
        },
      ],
    },
  },
  {
    method: "environment.invitations.accept",
    contract: environmentInvitationsAcceptV10,
    request: { environmentId: TEAM.environmentId },
    badRequest: { environmentId: "" },
    response: { outcome: "accepted" },
    badResponse: { outcome: "declined" },
  },
  {
    method: "environment.members.noticeSeen",
    contract: environmentMembersNoticeSeenV10,
    request: { environmentId: TEAM.environmentId },
    badRequest: { environmentId: "" },
    response: { outcome: "recorded" },
    badResponse: { outcome: "dismissed" },
  },
];

describe("the environments redesign's new @1.0 methods", () => {
  it.each(REDESIGN_WIRE_CASES.map((c) => [c.method, c] as const))(
    "%s is registered off the released floor with degrade unsupported, major 1 only",
    (_method, wire) => {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(wire.method);
      const entry = hostRpcRegistry[wire.method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(Object.keys(entry).filter((key) => /^\d+$/.test(key))).toEqual([
        "1",
      ]);
      expect(entry[1].latestMinor).toBe(
        wire.method === "environment.move.plan"
          ? 2
          : wire.method === "environment.move.stopPreview" ||
              wire.method === "environment.configuration.mcpServers.put" ||
              wire.method === "environment.configuration.guide.get"
            ? 1
            : 0,
      );
      expect(entry[1].versions[0].contract).toBe(wire.contract);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
    },
  );

  it.each(REDESIGN_WIRE_CASES.map((c) => [c.method, c] as const))(
    "%s parses a valid request and response and rejects a malformed one of each",
    (_method, wire) => {
      expect(wire.contract.requestSchema.safeParse(wire.request).success).toBe(
        true,
      );
      expect(
        wire.contract.requestSchema.safeParse(wire.badRequest).success,
      ).toBe(false);
      expect(
        wire.contract.responseSchema.safeParse(wire.response).success,
      ).toBe(true);
      expect(
        wire.contract.responseSchema.safeParse(wire.badResponse).success,
      ).toBe(false);
    },
  );

  it("mcpServers.put@1.1 takes a picked secret and names the saved server; a 1.0 answer upgrades with no id", () => {
    const entry = hostRpcRegistry["environment.configuration.mcpServers.put"];
    expect(entry[1].versions[1].contract).toBe(
      environmentConfigurationMcpServersPutV11,
    );
    const picked = {
      environmentId: TEAM.environmentId,
      serverId: null,
      name: "docs",
      transport: "http",
      url: "https://mcp.example.com",
      command: null,
      args: [],
      env: [],
      toolToggles: {},
      offFor: ["codex"],
      credential: { kind: "secret", secretId: "secret-1" },
    };
    expect(
      environmentConfigurationMcpServersPutV11.requestSchema.safeParse(picked)
        .success,
    ).toBe(true);
    expect(
      environmentConfigurationMcpServersPutV10.requestSchema.safeParse(picked)
        .success,
    ).toBe(false);
    expect(
      environmentConfigurationMcpServersPutUpgradeV10ToV11.upgradeResponse({
        outcome: "saved",
        reason: null,
      }),
    ).toEqual({ outcome: "saved", reason: null, serverId: null });
    const released = {
      environmentId: TEAM.environmentId,
      serverId: null,
      name: "docs",
      transport: "http" as const,
      url: "https://mcp.example.com",
      command: null,
      args: [],
      env: [],
      toolToggles: {},
      credential: { kind: "none" as const },
    };
    expect(
      environmentConfigurationMcpServersPutUpgradeV10ToV11.upgradeRequest(
        released,
      ),
    ).toEqual({ ...released, offFor: [] });
  });

  it("registers every redesign method in the host registry, and none of them is missing from this table", () => {
    expect(REDESIGN_WIRE_CASES.map((wire) => wire.method).sort()).toEqual(
      Object.keys(ENVIRONMENT_REDESIGN_RPC_METHODS)
        .sort()
        .filter(
          (method) =>
            method !== "environment.review.heldApply" &&
            method !== "environment.review.record",
        ),
    );
  });

  it("answers a move row with a name and never a value", () => {
    const leaky = { ...MOVE_ROW, value: "sk-live-123", secret: "sk-live-123" };
    const plan = environmentMovePlanV10.responseSchema.parse({
      planHash: "h1",
      planRevision: 0,
      hostVersion: "1.4.0",
      disclosureVersion: 1,
      rows: {
        moves: [leaky],
        staysOnThisComputer: [leaky],
        alreadyInPersonal: [leaky],
        differsMasked: [leaky],
        looksLikeAKey: [leaky],
      },
    });
    for (const rows of Object.values(plan.rows)) {
      expect(rows[0]).toEqual(MOVE_ROW);
    }
    const preview = environmentMoveStopPreviewV10.responseSchema.parse({
      managed: [leaky],
      needsChoice: [{ row: leaky, reason: "depended_on" }],
    });
    expect(preview.managed[0]).toEqual(MOVE_ROW);
    expect(preview.needsChoice[0].row).toEqual(MOVE_ROW);
  });

  it("opens environment.move.plan@1.1 with sameNameInPersonal, which a @1.0 answer upgrades to empty", () => {
    const line = hostRpcRegistry["environment.move.plan"][1];
    expect(line.versions[1].contract).toBe(environmentMovePlanV11);
    expect(line.versions[1].upgradeFromPreviousVersion).toBe(
      environmentMovePlanUpgradeV10ToV11,
    );
    const v10 = environmentMovePlanV10.responseSchema.parse({
      planHash: "h1",
      planRevision: 0,
      hostVersion: "1.39.0",
      disclosureVersion: 1,
      rows: {
        moves: [MOVE_ROW],
        staysOnThisComputer: [],
        alreadyInPersonal: [],
        differsMasked: [],
        looksLikeAKey: [],
      },
    });
    const upgraded = environmentMovePlanUpgradeV10ToV11.upgradeResponse(v10);
    expect(upgraded.rows.sameNameInPersonal).toEqual([]);
    expect(upgraded.guideDiffers).toBe(false);
    expect(upgraded.rows.moves).toEqual([MOVE_ROW]);
    const leaky = { ...MOVE_ROW, value: "sk-live-123" };
    const v11 = environmentMovePlanV11.responseSchema.parse({
      ...v10,
      rows: { ...v10.rows, sameNameInPersonal: [leaky] },
    });
    expect(v11.rows.sameNameInPersonal).toEqual([MOVE_ROW]);
    expect(
      environmentMovePlanV11.responseSchema.parse(v10).rows.sameNameInPersonal,
    ).toEqual([]);
    expect(environmentMovePlanV11.responseSchema.parse(v10).guideDiffers).toBe(
      false,
    );
    expect(
      environmentMovePlanV11.responseSchema.parse({
        ...v10,
        guideDiffers: true,
      }).guideDiffers,
    ).toBe(true);
  });

  it("opens environment.move.plan@1.2 as the line's latest, upgrading a @1.1 answer with personalHoldsSecrets and itemChoices false", () => {
    const line = hostRpcRegistry["environment.move.plan"][1];
    expect(line.latestMinor).toBe(2);
    expect(line.versions[2].contract).toBe(environmentMovePlanV12);
    expect(line.versions[2].upgradeFromPreviousVersion).toBe(
      environmentMovePlanUpgradeV11ToV12,
    );
    const v11 = environmentMovePlanV11.responseSchema.parse({
      planHash: "h1",
      planRevision: 0,
      hostVersion: "1.39.0",
      disclosureVersion: 1,
      rows: {
        moves: [MOVE_ROW],
        staysOnThisComputer: [],
        alreadyInPersonal: [],
        differsMasked: [],
        looksLikeAKey: [],
      },
    });
    const upgraded = environmentMovePlanUpgradeV11ToV12.upgradeResponse(v11);
    expect(upgraded.personalHoldsSecrets).toBe(false);
    expect(upgraded.itemChoices).toBe(false);
    expect(upgraded.rows.moves).toEqual([MOVE_ROW]);
    const parsed = environmentMovePlanV12.responseSchema.parse(v11);
    expect(parsed.personalHoldsSecrets).toBe(false);
    expect(parsed.itemChoices).toBe(false);
    const answered = environmentMovePlanV12.responseSchema.parse({
      ...v11,
      personalHoldsSecrets: true,
      itemChoices: true,
    });
    expect(answered.personalHoldsSecrets).toBe(true);
    expect(answered.itemChoices).toBe(true);
  });

  it("sends a Moves row's choice under item:<kind>:<key>", () => {
    const key = environmentMoveItemChoiceKey("variable", "X");
    expect(key).toBe("item:variable:X");
    expect(key.startsWith(ENVIRONMENT_MOVE_ITEM_CHOICE_PREFIX)).toBe(true);
    expect(
      environmentMoveItemChoiceKey("env_override", "claude-code:A_B"),
    ).toBe("item:env_override:claude-code:A_B");
  });

  it("opens environment.move.stopPreview@1.1 with origin and usedBy on each row that needs a choice", () => {
    const line = hostRpcRegistry["environment.move.stopPreview"][1];
    expect(line.versions[1].contract).toBe(environmentMoveStopPreviewV11);
    expect(line.versions[1].upgradeFromPreviousVersion).toBe(
      environmentMoveStopPreviewUpgradeV10ToV11,
    );
    const user = { ...MOVE_ROW, key: "WORK", label: "WORK" };
    const parsed = environmentMoveStopPreviewV11.responseSchema.parse({
      managed: [MOVE_ROW],
      needsChoice: [
        {
          row: MOVE_ROW,
          reason: "edited_here",
          origin: "from_this_computer",
          usedBy: [],
        },
        {
          row: MOVE_ROW,
          reason: "depended_on",
          origin: "depended_on",
          usedBy: [{ ...user, value: "sk-live-123" }],
        },
      ],
    });
    expect(parsed.needsChoice.map((entry) => entry.origin)).toEqual([
      "from_this_computer",
      "depended_on",
    ]);
    expect(parsed.needsChoice[1].usedBy).toEqual([user]);
    expect(
      environmentMoveStopPreviewV11.responseSchema.safeParse({
        managed: [],
        needsChoice: [{ row: MOVE_ROW, reason: "edited_here" }],
      }).success,
    ).toBe(false);
    expect(
      environmentMoveStopPreviewV11.responseSchema.safeParse({
        managed: [],
        needsChoice: [
          {
            row: MOVE_ROW,
            reason: "edited_here",
            origin: "forgotten",
            usedBy: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("upgrades a @1.0 stop preview answer: edited_here becomes changed_here, depended_on gets no usedBy", () => {
    const v10 = environmentMoveStopPreviewV10.responseSchema.parse({
      managed: [MOVE_ROW],
      needsChoice: [
        { row: MOVE_ROW, reason: "edited_here" },
        { row: MOVE_ROW, reason: "depended_on" },
      ],
    });

    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["environment.move.stopPreview"],
      { major: 1, minor: 0 },
      { major: 1, minor: 1 },
      v10,
    );

    expect(upgraded).toEqual({
      managed: [MOVE_ROW],
      needsChoice: [
        {
          row: MOVE_ROW,
          reason: "edited_here",
          origin: "changed_here",
          usedBy: [],
        },
        {
          row: MOVE_ROW,
          reason: "depended_on",
          origin: "depended_on",
          usedBy: [],
        },
      ],
    });
  });

  it("carries a value only on environment.configuration.items", () => {
    const item = {
      kind: "variable",
      key: "API_BASE",
      os: "any",
      value: { nested: ["x"] },
      revision: 1,
      updatedAt: 1,
      writtenBy: { source: "live", hostId: "h", hostName: "studio" },
    };
    expect(
      environmentConfigurationItemsV10.responseSchema.parse({ items: [item] })
        .items[0].value,
    ).toEqual({ nested: ["x"] });
    expect(
      environmentConfigurationItemsPutV10.responseSchema.parse({
        outcome: "saved",
        revision: 2,
        value: "leak",
      }),
    ).toEqual({ outcome: "saved", revision: 2 });
    expect(
      environmentConfigurationMcpServersPutV10.responseSchema.parse({
        outcome: "saved",
        reason: null,
        credential: { kind: "pat", pat: "ghp_x" },
      }),
    ).toEqual({ outcome: "saved", reason: null });
    expect(
      environmentPlansListV10.responseSchema.parse({
        plans: [
          {
            profileId: "p1",
            harness: "claude-code",
            status: "linked",
            linkedBy: null,
            token: "t0k3n",
          },
        ],
      }).plans[0],
    ).toEqual({
      profileId: "p1",
      harness: "claude-code",
      status: "linked",
      linkedBy: null,
    });
  });

  it("answers an item write with a conflict naming who moved the row, or nothing when the row is gone", () => {
    const conflict = {
      outcome: "conflict",
      current: {
        revision: 5,
        changedBy: "Grace",
        changedAt: 1_700_000_000_000,
      },
    };
    for (const contract of [
      environmentConfigurationItemsPutV10,
      environmentConfigurationItemsDeleteV10,
    ]) {
      expect(contract.responseSchema.parse(conflict)).toEqual(conflict);
      expect(
        contract.responseSchema.parse({ outcome: "saved", revision: null }),
      ).toEqual({ outcome: "saved", revision: null });
    }
  });

  it("answers not_served on the guide and skill methods, and only where the contract names it", () => {
    expect(
      environmentConfigurationGuideGetV10.responseSchema.parse({
        outcome: "not_served",
      }),
    ).toEqual({ outcome: "not_served" });
    expect(
      environmentConfigurationGuideSetV10.responseSchema.parse({
        outcome: "not_served",
      }),
    ).toEqual({ outcome: "not_served" });
    expect(
      environmentConfigurationGuideResetV10.responseSchema.parse({
        outcome: "not_served",
      }),
    ).toEqual({ outcome: "not_served" });
    expect(
      environmentConfigurationSkillsUploadV10.responseSchema.parse({
        outcome: "not_served",
        reason: null,
      }),
    ).toEqual({ outcome: "not_served", reason: null });
    // The mcp-server and policy writes answer from authn and never name it.
    for (const contract of [
      environmentConfigurationMcpServersPutV10,
      environmentConfigurationPolicyPutV10,
    ]) {
      expect(
        contract.responseSchema.safeParse({
          outcome: "not_served",
          reason: null,
        }).success,
      ).toBe(false);
    }
  });

  it("answers history hostStates for a host that never reported with at: null and lastReportedAt: null, and never fills either in", () => {
    const unreported = {
      hostId: "host-2",
      hostName: "laptop",
      state: "waiting_resume",
      reason: null,
      at: null,
      lastReportedAt: null,
    };
    const reported = {
      hostId: "host-1",
      hostName: "studio",
      state: "not_applied",
      reason: "permission_denied",
      at: 1_700_000_000_000,
      lastReportedAt: 1_700_000_000_001,
    };
    const parsed = environmentHistoryV10.responseSchema.parse({
      entries: [],
      readerScope: "status_only",
      hostStates: [reported, unreported],
    });
    expect(parsed.hostStates).toEqual([reported, unreported]);
    expect(parsed.hostStates[1].at).toBeNull();
    expect(parsed.hostStates[1].lastReportedAt).toBeNull();
    // A null is not a missing key, and a negative time is still refused.
    const { at: _at, ...noAt } = unreported;
    for (const bad of [noAt, { ...unreported, at: -1 }]) {
      expect(
        environmentHistoryV10.responseSchema.safeParse({
          entries: [],
          readerScope: "full",
          hostStates: [bad],
        }).success,
      ).toBe(false);
    }
  });

  it("caps a skill archive at ENVIRONMENT_SKILL_ARCHIVE_MAX_BYTES of base64-decoded bytes", () => {
    const maxBase64Length =
      Math.ceil(ENVIRONMENT_SKILL_ARCHIVE_MAX_BYTES / 3) * 4;
    const at = (length: number) => ({
      environmentId: TEAM.environmentId,
      name: "skill",
      archive: "A".repeat(length),
    });
    expect(
      environmentConfigurationSkillsUploadV10.requestSchema.safeParse(
        at(maxBase64Length),
      ).success,
    ).toBe(true);
    expect(
      environmentConfigurationSkillsUploadV10.requestSchema.safeParse(
        at(maxBase64Length + 4),
      ).success,
    ).toBe(false);
  });

  it("caps a policy body at 64 KiB", () => {
    expect(ENVIRONMENT_POLICY_MAX_BYTES).toBe(64 * 1024);
    const at = (length: number) => ({
      environmentId: TEAM.environmentId,
      body: "x".repeat(length),
      policyVersion: null,
    });
    expect(
      environmentConfigurationPolicyPutV10.requestSchema.safeParse(
        at(ENVIRONMENT_POLICY_MAX_BYTES),
      ).success,
    ).toBe(true);
    expect(
      environmentConfigurationPolicyPutV10.requestSchema.safeParse(
        at(ENVIRONMENT_POLICY_MAX_BYTES + 1),
      ).success,
    ).toBe(false);
  });
});

describe("environment.configuration.guide.get@1.1", () => {
  const ONE_ZERO = { major: 1, minor: 0 } as const;
  const ONE_ONE = { major: 1, minor: 1 } as const;
  const line = hostRpcRegistry["environment.configuration.guide.get"][1];

  it("registers the @1.1 contract as the latest minor, gated on the caller's projection", () => {
    expect(line.latestMinor).toBe(1);
    expect(line.versions[1].contract).toBe(environmentConfigurationGuideGetV11);
    expect(line.versions[1].upgradeFromPreviousVersion).toBe(
      environmentConfigurationGuideGetUpgradeV10ToV11,
    );
    expect(line.versions[1].responseGrowthProjectionGated).toBe(true);
  });

  it("parses the unset arm with its revision, and rejects an unset arm without one or with an empty one", () => {
    expect(
      environmentConfigurationGuideGetV11.responseSchema.parse({
        outcome: "unset",
        revision: "r0",
      }),
    ).toEqual({ outcome: "unset", revision: "r0" });
    for (const bad of [
      { outcome: "unset" },
      { outcome: "unset", revision: "" },
      { outcome: "absent", revision: "r0" },
    ]) {
      expect(
        environmentConfigurationGuideGetV11.responseSchema.safeParse(bad)
          .success,
      ).toBe(false);
    }
  });

  it("does not parse the unset arm as an @1.0 answer", () => {
    expect(
      environmentConfigurationGuideGetV10.responseSchema.safeParse({
        outcome: "unset",
        revision: "r0",
      }).success,
    ).toBe(false);
  });

  it("upgrades an @1.0 answer and request unchanged", () => {
    const ok = environmentConfigurationGuideGetV10.responseSchema.parse({
      outcome: "ok",
      text: "Prefer small models.",
      revision: "r1",
    });
    expect(
      upgradeResponseToVersion(
        hostRpcRegistry["environment.configuration.guide.get"],
        ONE_ZERO,
        ONE_ONE,
        ok,
      ),
    ).toEqual(ok);
    const request = { environmentId: TEAM.environmentId };
    expect(
      upgradeRequestToVersion(
        hostRpcRegistry["environment.configuration.guide.get"],
        ONE_ZERO,
        ONE_ONE,
        request,
      ),
    ).toEqual(request);
  });
});
