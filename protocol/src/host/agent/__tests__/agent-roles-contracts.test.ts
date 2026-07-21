/**
 * The `agent.roles.*` wire contracts, and the negotiated stream minor that
 * carries role awareness.
 *
 * Two things here are load-bearing:
 *
 * 1. These methods are advertised ONLY because Sprint 02 also ships their
 *    resolvers. A method advertised without a resolver negotiates fine and then
 *    dies at dispatch with "Unknown method" - exactly how `agent.tui.
 *    listHarnesses` shipped. The host-side resolver-coverage tripwire is what
 *    actually proves the resolvers exist; this file proves the advertisement.
 *
 * 2. The `role-awareness` frame lives ONLY in `agent.inbox.subscribe@1.1`. The
 *    @1.0 union is frozen and must REJECT it: a monitor that negotiated @1.0
 *    never agreed to receive that frame, and sending it anyway is the host
 *    breaking the negotiated contract - not a "graceful" degrade the peer
 *    happens to drop.
 */
import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import {
  agentInboxSubscribeServerFrameSchemaV10,
  agentInboxSubscribeServerFrameSchemaV11,
} from "@traycer/protocol/host/agent/inbox";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  agentRolesClaimV10,
  agentRolesClaimV11,
  agentRolesListV10,
  agentRolesRelinquishV10,
  agentRolesRelinquishV11,
  claimAgentRoleRequestSchema,
  claimAgentRoleResponseSchema,
  relinquishAgentRoleRequestSchema,
  relinquishAgentRoleResponseSchema,
} from "@traycer/protocol/host/agent/roles";

const ROLE_METHODS = [
  "agent.roles.claim",
  "agent.roles.list",
  "agent.roles.relinquish",
] as const;

const VALID_CLAIM_REQUEST = {
  epicId: "epic-1",
  claimantAgentId: "agent-1",
  role: "Planner",
  scope: "auth migration",
};

describe("agent.roles.* contracts", () => {
  it("declares v1.0 contracts bound to their method names", () => {
    expect(agentRolesClaimV10.method).toBe("agent.roles.claim");
    expect(agentRolesListV10.method).toBe("agent.roles.list");
    expect(agentRolesRelinquishV10.method).toBe("agent.roles.relinquish");

    for (const contract of [
      agentRolesClaimV10,
      agentRolesListV10,
      agentRolesRelinquishV10,
    ]) {
      expect(contract.schemaVersion).toEqual({ major: 1, minor: 0 });
    }
  });

  it("is now ADVERTISED, and lands in the same change as its resolvers", () => {
    // Sprint 01 asserted the opposite: absent from the registry, because a
    // method advertised without a resolver negotiates and then dies at dispatch
    // with "Unknown method" (the `agent.tui.listHarnesses` defect). Sprint 02
    // adds the resolvers, so registration is now correct — and the host-side
    // resolver-coverage tripwire is what proves the resolvers actually exist.
    for (const method of ROLE_METHODS) {
      expect(Object.hasOwn(hostRpcRegistry, method)).toBe(true);
    }
  });

  it("is NON-FLOOR and declares its missing-peer behavior", () => {
    // New method names are fatal on the floor channel's equal-set handshake, so
    // these must ride the optional manifest and say what an old peer does.
    for (const method of ROLE_METHODS) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      expect(hostRpcRegistry[method].degrade).toEqual({ kind: "unsupported" });
    }
  });
});

describe("agent.roles.claim / agent.roles.relinquish v1.1 (advertised with host projection)", () => {
  it("declares v1.1 contracts bound to the same method names and major version", () => {
    expect(agentRolesClaimV11.method).toBe("agent.roles.claim");
    expect(agentRolesRelinquishV11.method).toBe("agent.roles.relinquish");

    for (const contract of [agentRolesClaimV11, agentRolesRelinquishV11]) {
      expect(contract.schemaVersion).toEqual({ major: 1, minor: 1 });
    }
  });

  it("reuses the EXACT v1.0 request schemas - v1.1 only changes what the response can say", () => {
    expect(agentRolesClaimV11.requestSchema).toBe(claimAgentRoleRequestSchema);
    expect(agentRolesRelinquishV11.requestSchema).toBe(
      relinquishAgentRoleRequestSchema,
    );
  });

  it("is installed as latestMinor 1 alongside the frozen v1.0 slot", () => {
    // Advertising minor 1 lands in the same change as the host resolvers that
    // produce `deferredToPrompt` and the v1.0 negotiated fold.
    for (const method of [
      "agent.roles.claim",
      "agent.roles.relinquish",
    ] as const) {
      const line = hostRpcRegistry[method][1];
      expect(line.latestMinor).toBe(1);
      expect(Object.keys(line.versions).sort()).toEqual(["0", "1"]);
      expect(line.versions[0].contract.schemaVersion).toEqual({
        major: 1,
        minor: 0,
      });
      expect(line.versions[1].contract.schemaVersion).toEqual({
        major: 1,
        minor: 1,
      });
    }
  });

  it("keeps the released v1.0 response schemas object-identical (no preprocess wrappers)", () => {
    expect(agentRolesClaimV10.responseSchema).toBe(
      claimAgentRoleResponseSchema,
    );
    expect(agentRolesRelinquishV10.responseSchema).toBe(
      relinquishAgentRoleResponseSchema,
    );
  });

  it("agent.roles.list has no v1.1 - listing is unaffected by prompt-cutover awareness", () => {
    expect(agentRolesListV10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(hostRpcRegistry["agent.roles.list"][1].latestMinor).toBe(0);
  });
});

describe("request shape: no field can name an agent other than the caller", () => {
  const PEER_NAMING = /target|receiver|owner|assignee|forAgent|onBehalf/i;

  it("offers no way to claim on another agent's behalf", () => {
    const keys = Object.keys(claimAgentRoleRequestSchema.shape);

    expect(keys).toEqual(["epicId", "claimantAgentId", "role", "scope"]);
    expect(keys.filter((key) => PEER_NAMING.test(key))).toEqual([]);
  });

  it("offers no way to relinquish a peer's claim by naming the peer", () => {
    const keys = Object.keys(relinquishAgentRoleRequestSchema.shape);

    expect(keys).toEqual(["epicId", "claimantAgentId", "claimId"]);
    expect(keys.filter((key) => PEER_NAMING.test(key))).toEqual([]);
  });
});

describe("request validation", () => {
  it("normalizes role and scope on the way in", () => {
    const parsed = claimAgentRoleRequestSchema.parse({
      ...VALID_CLAIM_REQUEST,
      role: "  Planner  ",
      scope: "auth\tmigration",
    });

    expect(parsed.role).toBe("Planner");
    expect(parsed.scope).toBe("auth migration");
  });

  it("rejects role/scope the shared vocabulary rejects", () => {
    expect(() =>
      claimAgentRoleRequestSchema.parse({ ...VALID_CLAIM_REQUEST, role: "" }),
    ).toThrow();
    expect(() =>
      claimAgentRoleRequestSchema.parse({
        ...VALID_CLAIM_REQUEST,
        role: "a".repeat(49),
      }),
    ).toThrow();
    expect(() =>
      claimAgentRoleRequestSchema.parse({
        ...VALID_CLAIM_REQUEST,
        scope: "bad\u0000scope",
      }),
    ).toThrow();
  });

  it("requires a UUID claimId, so a claim can never be addressed by role string", () => {
    expect(() =>
      relinquishAgentRoleRequestSchema.parse({
        epicId: "epic-1",
        claimantAgentId: "agent-1",
        claimId: "Planner",
      }),
    ).toThrow();
  });

  it("TOLERATES an unknown extra key - deliberately not .strict()", () => {
    // A strict v1.0 request schema would make a v1.0 host REJECT a v1.1
    // client's additive field, which is the compatibility break this protocol
    // exists to avoid. This test exists to fail if someone "hardens" these
    // schemas with .strict() later.
    expect(() =>
      claimAgentRoleRequestSchema.parse({
        ...VALID_CLAIM_REQUEST,
        fieldFromAFutureMinor: "ignored",
      }),
    ).not.toThrow();
  });
});

describe("role awareness rides the NEGOTIATED stream minor", () => {
  const ROLE_AWARENESS_FRAME = {
    kind: "role-awareness",
    hasBinaryPayload: false,
    event: {
      kind: "role-claimed",
      epicId: "epic-1",
      claim: {
        claimId: "11111111-1111-4111-8111-111111111111",
        agentId: "agent-1",
        role: "Planner",
        scope: "auth migration",
        claimedAt: 10,
      },
      at: 20,
    },
  };

  it("@1.0 REJECTS the frame - a v1.0 monitor never agreed to receive it", () => {
    expect(
      agentInboxSubscribeServerFrameSchemaV10.safeParse(ROLE_AWARENESS_FRAME)
        .success,
    ).toBe(false);
  });

  it("@1.1 accepts it", () => {
    expect(
      agentInboxSubscribeServerFrameSchemaV11.safeParse(ROLE_AWARENESS_FRAME)
        .success,
    ).toBe(true);
  });

  it("@1.1 is purely additive - every @1.0 frame still parses", () => {
    const pong = { kind: "pong", hasBinaryPayload: false };
    expect(
      agentInboxSubscribeServerFrameSchemaV10.safeParse(pong).success,
    ).toBe(true);
    expect(
      agentInboxSubscribeServerFrameSchemaV11.safeParse(pong).success,
    ).toBe(true);
  });

  it("installs BOTH minors, with @1.1 latest", () => {
    const line = hostStreamRpcRegistry["agent.inbox.subscribe"][1];
    expect(line.latestMinor).toBe(1);
    expect(Object.keys(line.versions).sort()).toEqual(["0", "1"]);
  });
});
