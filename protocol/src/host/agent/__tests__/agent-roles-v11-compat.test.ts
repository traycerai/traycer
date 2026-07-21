/**
 * Compatibility surface for the additive Agent Roles v1.1 awareness contract
 * (`deferredToPrompt`). Two directions matter:
 *
 * - The released v1.0 shapes are frozen: no new field, no relaxed
 *   validation, so an old peer's understanding of the wire never silently
 *   changes underneath it.
 * - A v1.1 delivery down-projects to a valid v1.0 delivery by folding
 *   `deferredToPrompt` into `unreachable` - the only failure reasons a v1.0
 *   consumer can ever see are the ones it already shipped with.
 */
import { describe, expect, it } from "vitest";
import {
  claimAgentRoleResponseSchema,
  claimAgentRoleResponseSchemaV11,
  downProjectClaimResponseToV10,
  downProjectRelinquishResponseToV10,
  downProjectRoleAwarenessDeliveryToV10,
  relinquishAgentRoleResponseSchema,
  relinquishAgentRoleResponseSchemaV11,
  roleAwarenessDeliverySchema,
  roleAwarenessDeliverySchemaV11,
  roleClaimWireSchema,
} from "@traycer/protocol/host/agent/roles";

const CLAIM = roleClaimWireSchema.parse({
  claimId: "11111111-1111-4111-8111-111111111111",
  agentId: "agent-1",
  role: "Planner",
  scope: "auth migration",
  claimedAt: 10,
});

const FAILED_REASONS_V10 = [
  "sink-closed",
  "timeout",
  "delivery-error",
  "reserved-id-collision",
  "no-active-turn",
] as const;

describe("v1.0 awareness/response shapes are frozen", () => {
  it("roleAwarenessDeliverySchema (v1.0) has exactly its released fields - no deferredToPrompt", () => {
    expect(Object.keys(roleAwarenessDeliverySchema.shape).sort()).toEqual(
      ["deliveredTo", "failed", "unreachable"].sort(),
    );
  });

  it("claimAgentRoleResponseSchema (v1.0) has exactly its released fields", () => {
    expect(Object.keys(claimAgentRoleResponseSchema.shape).sort()).toEqual(
      ["awareness", "claim", "created", "overlapping"].sort(),
    );
  });

  it("relinquishAgentRoleResponseSchema (v1.0) has exactly its released fields", () => {
    expect(Object.keys(relinquishAgentRoleResponseSchema.shape).sort()).toEqual(
      ["awareness", "released"].sort(),
    );
  });

  it("rejects a delivery that names a failure reason outside the released enum", () => {
    expect(() =>
      roleAwarenessDeliverySchema.parse({
        deliveredTo: [],
        unreachable: [],
        failed: [{ agentId: "agent-1", reason: "not-a-real-reason" }],
      }),
    ).toThrow();
  });

  it("v1.0 claim safeParse rejects malformed awareness without throwing", () => {
    const result = claimAgentRoleResponseSchema.safeParse({
      claim: CLAIM,
      created: true,
      overlapping: [],
      awareness: {
        deliveredTo: "not-an-array",
        unreachable: [],
        failed: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it("v1.0 relinquish safeParse rejects malformed awareness without throwing", () => {
    const result = relinquishAgentRoleResponseSchema.safeParse({
      released: true,
      awareness: {
        deliveredTo: [],
        unreachable: [],
        failed: [{ agentId: "agent-1", reason: "not-a-real-reason" }],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("v1.1 round-trips all four mutually exclusive recipient categories", () => {
  it("preserves deliveredTo, deferredToPrompt, unreachable, and failed independently", () => {
    const delivery = {
      deliveredTo: ["agent-delivered"],
      deferredToPrompt: ["agent-deferred"],
      unreachable: ["agent-unreachable"],
      failed: [{ agentId: "agent-failed", reason: "timeout" as const }],
    };

    const parsed = roleAwarenessDeliverySchemaV11.parse(delivery);

    expect(parsed).toEqual(delivery);
    expect(parsed.deliveredTo).not.toEqual(
      expect.arrayContaining(["agent-deferred", "agent-unreachable"]),
    );
  });

  it("round-trips a full claim response through v1.1", () => {
    const response = {
      claim: CLAIM,
      created: true,
      overlapping: [],
      awareness: {
        deliveredTo: [],
        deferredToPrompt: ["agent-2"],
        unreachable: [],
        failed: [],
      },
    };

    expect(claimAgentRoleResponseSchemaV11.parse(response)).toEqual(response);
  });

  it("round-trips a full relinquish response through v1.1", () => {
    const response = {
      released: true,
      awareness: {
        deliveredTo: [],
        deferredToPrompt: ["agent-2"],
        unreachable: [],
        failed: [],
      },
    };

    expect(relinquishAgentRoleResponseSchemaV11.parse(response)).toEqual(
      response,
    );
  });

  it("accepts every released v1.0 failure reason unchanged", () => {
    for (const reason of FAILED_REASONS_V10) {
      expect(() =>
        roleAwarenessDeliverySchemaV11.parse({
          deliveredTo: [],
          deferredToPrompt: [],
          unreachable: [],
          failed: [{ agentId: "agent-1", reason }],
        }),
      ).not.toThrow();
    }
  });
});

describe("down-projection to v1.0 folds deferredToPrompt into unreachable", () => {
  it("moves deferredToPrompt ids into unreachable, leaving deliveredTo and failed untouched", () => {
    const projected = downProjectRoleAwarenessDeliveryToV10({
      deliveredTo: ["agent-delivered"],
      deferredToPrompt: ["agent-deferred-1", "agent-deferred-2"],
      unreachable: ["agent-unreachable"],
      failed: [{ agentId: "agent-failed", reason: "timeout" }],
    });

    expect(projected).toEqual({
      deliveredTo: ["agent-delivered"],
      unreachable: [
        "agent-unreachable",
        "agent-deferred-1",
        "agent-deferred-2",
      ],
      failed: [{ agentId: "agent-failed", reason: "timeout" }],
    });
    // The projected shape must itself be a valid v1.0 delivery.
    expect(() => roleAwarenessDeliverySchema.parse(projected)).not.toThrow();
  });

  it("invents no new failure reason - every projected failed entry keeps its original v1.0-legal reason", () => {
    const projected = downProjectRoleAwarenessDeliveryToV10({
      deliveredTo: [],
      deferredToPrompt: ["agent-deferred"],
      unreachable: [],
      failed: FAILED_REASONS_V10.map((reason, index) => ({
        agentId: `agent-${index}`,
        reason,
      })),
    });

    expect(projected.failed.map((entry) => entry.reason).sort()).toEqual(
      [...FAILED_REASONS_V10].sort(),
    );
  });

  it("projects a full claim response to the exact v1.0 response shape", () => {
    const v11Response = claimAgentRoleResponseSchemaV11.parse({
      claim: CLAIM,
      created: true,
      overlapping: [],
      awareness: {
        deliveredTo: [],
        deferredToPrompt: ["agent-2"],
        unreachable: ["agent-3"],
        failed: [],
      },
    });

    const projected = downProjectClaimResponseToV10(v11Response);

    expect(() => claimAgentRoleResponseSchema.parse(projected)).not.toThrow();
    expect(projected.awareness.unreachable).toEqual(["agent-3", "agent-2"]);
    expect(Object.keys(projected)).not.toContain("deferredToPrompt");
  });

  it("projects a full relinquish response to the exact v1.0 response shape", () => {
    const v11Response = relinquishAgentRoleResponseSchemaV11.parse({
      released: true,
      awareness: {
        deliveredTo: [],
        deferredToPrompt: ["agent-2"],
        unreachable: [],
        failed: [],
      },
    });

    const projected = downProjectRelinquishResponseToV10(v11Response);

    expect(() =>
      relinquishAgentRoleResponseSchema.parse(projected),
    ).not.toThrow();
    expect(projected.awareness.unreachable).toEqual(["agent-2"]);
  });
});
