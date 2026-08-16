import { describe, expect, it } from "vitest";
import type { PermissionMode } from "@traycer/protocol/persistence/epic/foundation";
import {
  epicCommunicationGraphEventSchemaV11,
  type EpicCommunicationGraphEventV11,
} from "@traycer/protocol/host/epic/communication-graph";
import {
  policyEvaluationRequestSchema,
  policyEvaluationResultSchema,
  type PolicyEvaluationRequest,
} from "@traycer/protocol/host/policy/contracts";
import {
  defaultPolicyRulesForPermissionMode,
  resolvePolicyDecision,
} from "@traycer/protocol/host/policy/defaults";
import {
  ReferencePolicyRegistry,
  buildPolicyAuditEvent,
} from "@traycer/protocol/host/policy/registry";
import {
  policyActionSchema,
  policyResourceSchema,
  type PolicyAction,
  type PolicyResource,
  type PolicyRule,
} from "@traycer/protocol/host/policy/types";

/**
 * Policy lifecycle end-to-end (Task 8, Phase 0) - protocol-layer integration
 * test over the REAL reference implementation. No host process, no SQLite,
 * no mocks: `types.ts` schemas → `contracts.ts` request/result → `defaults.ts`
 * rule sets + pure decision helpers → `registry.ts`
 * `ReferencePolicyRegistry` + `buildPolicyAuditEvent` + `auditSink`.
 *
 * This is the protocol-side proof that a closed host can vendor the
 * reference registry and get correct per-mode gating and comm-graph
 * `approval` @1.1 audit rows without inventing any policy semantics of its
 * own - exactly the composition the Task 9 two-host acceptance will run.
 */

const MODES: readonly PermissionMode[] = [
  "full_access",
  "supervised",
  "auto_accept_edits",
];

function makeRequest(
  action: PolicyAction,
  resource: PolicyResource,
  permissionMode: PermissionMode,
): PolicyEvaluationRequest {
  return {
    agentId: "agent-a",
    epicId: "epic-1",
    action,
    resource,
    resourceId: null,
    environment: { permissionMode, harnessId: null, isRemote: false },
  };
}

describe("1. full_access: every action × resource is allowed", () => {
  it("allows all 36 combinations with the allow rule as the verdict", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "full_access",
    });

    let evaluated = 0;
    for (const action of policyActionSchema.options) {
      for (const resource of policyResourceSchema.options) {
        const request = makeRequest(action, resource, "full_access");
        // The request and the result are both valid contract rows.
        expect(policyEvaluationRequestSchema.parse(request).action).toBe(
          action,
        );

        const result = registry.evaluate(request);
        expect(policyEvaluationResultSchema.parse(result).allowed).toBe(true);
        expect(result.allowed).toBe(true);
        expect(result.effectivePermissionMode).toBe("full_access");
        expect(result.ruleId).toBe(`default:allow:${action}:${resource}`);
        expect(result.reason).toBe("always");
        evaluated += 1;
      }
    }
    expect(evaluated).toBe(6 * 6);
  });
});

describe("2. supervised: high-impact actions are denied, reasons carry the condition text", () => {
  const DENIED: ReadonlyArray<readonly [PolicyAction, PolicyResource]> = [
    ["agent.stop", "agent"],
    ["agent.fork", "agent"],
    ["agent.archive", "agent"],
    ["tool.execute", "tool"],
  ];

  it("denies stop/fork/archive/tool.execute and cites the governing deny rule", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "supervised",
    });

    for (const [action, resource] of DENIED) {
      const result = registry.evaluate(
        makeRequest(action, resource, "supervised"),
      );
      expect(result.allowed).toBe(false);
      expect(result.effectivePermissionMode).toBe("supervised");
      expect(result.ruleId).toBe(`default:supervised:deny:${action}`);

      // The reason IS the winning deny rule's condition text.
      const denyRule = defaultPolicyRulesForPermissionMode("supervised").find(
        (candidate) =>
          candidate.action === action &&
          candidate.resource === resource &&
          candidate.mode === "deny",
      );
      expect(result.reason).toBe(denyRule?.condition ?? null);
    }
  });

  it("tool.execute's denial reason names the exempt-allowlist condition", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "supervised",
    });
    const tool = registry.evaluate(
      makeRequest("tool.execute", "tool", "supervised"),
    );
    expect(tool.reason).toBe("tool is not on the exempt allowlist");
  });

  it("allows the non-destructive actions sendMessage and create", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "supervised",
    });
    for (const [action, resource] of [
      ["agent.sendMessage", "agent"],
      ["agent.create", "agent"],
    ] as const) {
      const result = registry.evaluate(
        makeRequest(action, resource, "supervised"),
      );
      expect(result.allowed).toBe(true);
      expect(result.ruleId).toBe(`default:allow:${action}:${resource}`);
    }
  });
});

describe("3. auto_accept_edits: agent.stop requires approval on ANY resource", () => {
  it("gates agent.stop on every resource class and allows every other action", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "auto_accept_edits",
    });

    for (const action of policyActionSchema.options) {
      for (const resource of policyResourceSchema.options) {
        const result = registry.evaluate(
          makeRequest(action, resource, "auto_accept_edits"),
        );
        if (action === "agent.stop") {
          // The stop gate is resource-class-independent.
          expect(result.allowed).toBe(false);
          expect(result.reason).toContain("requires approval");
          expect(result.ruleId).toContain(
            "default:auto_accept_edits:require_approval:agent.stop",
          );
        } else {
          expect(result.allowed).toBe(true);
        }
      }
    }
  });

  it("the agent-resource stop keeps its stable ruleId and full reason", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "auto_accept_edits",
    });
    const result = registry.evaluate(
      makeRequest("agent.stop", "agent", "auto_accept_edits"),
    );
    expect(result.ruleId).toBe(
      "default:auto_accept_edits:require_approval:agent.stop",
    );
    expect(result.reason).toBe(
      "requires approval: target agent differs from the acting agent",
    );
  });
});

describe("4. plugin rule override beats the default deny by priority", () => {
  const PLUGIN_ALLOW_STOP: PolicyRule = {
    ruleId: "plugin:allow:agent.stop",
    action: "agent.stop",
    resource: "agent",
    impact: "high",
    condition: "operator granted a one-off stop exemption",
    mode: "allow",
    priority: 20,
  };

  it("a priority-20 allow rule overrides the supervised priority-10 deny", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "supervised",
    });
    // Baseline: the default deny governs.
    expect(
      registry.evaluate(makeRequest("agent.stop", "agent", "supervised"))
        .allowed,
    ).toBe(false);

    registry.register(PLUGIN_ALLOW_STOP);

    // The plugin rule's higher priority flips the verdict.
    const result = registry.evaluate(
      makeRequest("agent.stop", "agent", "supervised"),
    );
    expect(result.allowed).toBe(true);
    expect(result.ruleId).toBe(PLUGIN_ALLOW_STOP.ruleId);
    expect(result.reason).toBe(PLUGIN_ALLOW_STOP.condition);
  });

  it("unregistering the plugin restores the default deny", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "supervised",
    });
    registry.register(PLUGIN_ALLOW_STOP);
    registry.unregister(PLUGIN_ALLOW_STOP.ruleId);
    expect(
      registry.evaluate(makeRequest("agent.stop", "agent", "supervised"))
        .allowed,
    ).toBe(false);
  });
});

describe("5. buildPolicyAuditEvent constructs comm-graph @1.1 approval events", () => {
  it("maps a denied decision to a valid approval/denied event with requester identity", () => {
    const request = makeRequest("agent.stop", "agent", "supervised");
    const decision = resolvePolicyDecision(
      request,
      defaultPolicyRulesForPermissionMode("supervised"),
    );
    const result = {
      allowed: false,
      reason: decision?.rule.condition ?? null,
      ruleId: decision?.rule.ruleId ?? null,
      evaluatedAt: 1_753_000_000_000,
      effectivePermissionMode: "supervised" as const,
    };
    const event = buildPolicyAuditEvent({ id: 1, request, result, decision });

    // The approval @1.1 shape: kind, requester identity, approvalId, status,
    // and the gated action.
    expect(event.kind).toBe("approval");
    expect(event.senderAgentId).toBe(request.agentId);
    expect(event.approvalId).toBeTruthy();
    expect(event.approvalId).toContain("policy:");
    expect(event.status).toBe("denied");
    expect(event.targetAction).toBe("agent.stop");

    // Validates as a comm-graph @1.1 row and keeps the decision's timestamp.
    expect(epicCommunicationGraphEventSchemaV11.parse(event).kind).toBe(
      "approval",
    );
    expect(event.timestamp).toBe(result.evaluatedAt);

    // Fields owned by other @1.1 kinds stay null.
    expect(event.toolName).toBeNull();
    expect(event.agentId).toBeNull();
    expect(event.hostId).toBeNull();
    expect(event.resourceType).toBeNull();
  });

  it("maps every decision status: granted / pending / denied", () => {
    const cases: ReadonlyArray<{
      request: PolicyEvaluationRequest;
      expected: "granted" | "pending" | "denied";
    }> = [
      {
        request: makeRequest("agent.create", "agent", "full_access"),
        expected: "granted",
      },
      {
        request: makeRequest("agent.stop", "agent", "auto_accept_edits"),
        expected: "pending",
      },
      {
        request: makeRequest("agent.stop", "agent", "supervised"),
        expected: "denied",
      },
    ];

    cases.forEach(({ request, expected }, index) => {
      const decision = resolvePolicyDecision(
        request,
        defaultPolicyRulesForPermissionMode(request.environment.permissionMode),
      );
      const result = {
        allowed: decision !== null && decision.mode === "allow",
        reason: decision?.rule.condition ?? null,
        ruleId: decision?.rule.ruleId ?? null,
        evaluatedAt: 1_753_000_000_000 + index,
        effectivePermissionMode: request.environment.permissionMode,
      };
      const event = buildPolicyAuditEvent({
        id: index + 1,
        request,
        result,
        decision,
      });

      expect(event.status).toBe(expected);
      expect(event.targetAction).toBe(request.action);
      expect(event.senderAgentId).toBe(request.agentId);
      expect(event.approvalId).toContain("policy:");
      expect(
        epicCommunicationGraphEventSchemaV11.safeParse(event).success,
      ).toBe(true);
    });
  });
});

describe("6. audit sink integration: one valid approval event per evaluation", () => {
  it("emits exactly one event per evaluation, in order, matching each decision", () => {
    const events: EpicCommunicationGraphEventV11[] = [];
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "supervised",
      auditSink: (event) => events.push(event),
    });

    const stop = registry.evaluate(
      makeRequest("agent.stop", "agent", "supervised"),
    );
    const create = registry.evaluate(
      makeRequest("agent.create", "agent", "supervised"),
    );
    const tool = registry.evaluate(
      makeRequest("tool.execute", "tool", "supervised"),
    );

    expect(events).toHaveLength(3);

    // Every emitted event is a valid comm-graph @1.1 approval row.
    for (const event of events) {
      expect(
        epicCommunicationGraphEventSchemaV11.safeParse(event).success,
      ).toBe(true);
      expect(event.kind).toBe("approval");
      expect(event.senderAgentId).toBe("agent-a");
      expect(event.approvalId).toBeTruthy();
      expect(event.status).not.toBeNull();
    }

    // One event per evaluation, in evaluation order, with the right status,
    // action, and the registry's provisional id (= evaluatedAt).
    const [stopEvent, createEvent, toolEvent] = events;
    expect(stopEvent.status).toBe("denied");
    expect(stopEvent.targetAction).toBe("agent.stop");
    expect(stopEvent.timestamp).toBe(stop.evaluatedAt);
    expect(stopEvent.approvalId).toBe(`policy:agent-a:${stop.evaluatedAt}`);

    expect(createEvent.status).toBe("granted");
    expect(createEvent.targetAction).toBe("agent.create");
    expect(createEvent.timestamp).toBe(create.evaluatedAt);

    expect(toolEvent.status).toBe("denied");
    expect(toolEvent.targetAction).toBe("tool.execute");
    expect(toolEvent.timestamp).toBe(tool.evaluatedAt);
  });
});

// Sanity anchor: every default rule set still validates and resolves.
describe("contract composition across types, contracts, defaults and registry", () => {
  it("every default rule set is schema-valid and decides via the pure helper", () => {
    for (const mode of MODES) {
      const rules = defaultPolicyRulesForPermissionMode(mode);
      const registry = new ReferencePolicyRegistry({
        defaultPermissionMode: mode,
      });
      expect(registry.list().length).toBe(rules.length);

      for (const rule of rules) {
        expect(rule).toEqual(
          expect.objectContaining({
            action: expect.stringMatching(/^agent\.|^tool\./),
            resource: expect.stringMatching(/^[a-z]+$/),
          }),
        );
      }

      // The registry's verdict for a sample request agrees with the pure
      // decision helper over the same rule set - contract composition holds.
      const request = makeRequest("agent.stop", "agent", mode);
      const pure = resolvePolicyDecision(request, rules);
      const viaRegistry = registry.evaluate(request);
      const expectedAllowed = pure !== null ? pure.mode === "allow" : false;
      expect(viaRegistry.allowed).toBe(expectedAllowed);
      expect(viaRegistry.ruleId).toBe(pure?.rule.ruleId ?? null);
    }
  });
});
