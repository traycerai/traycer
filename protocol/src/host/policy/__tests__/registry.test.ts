import { describe, expect, it } from "vitest";
import type { PermissionMode } from "@traycer/protocol/persistence/epic/foundation";
import {
  epicCommunicationGraphEventSchemaV11,
  type EpicCommunicationGraphEventV11,
} from "@traycer/protocol/host/epic/communication-graph";
import type {
  PolicyEvaluationRequest,
  PolicyRegistry,
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
 * Reference `PolicyRegistry` implementation fixtures - the protocol-side
 * registry a closed host vendors or replaces (Task 6, Phase 0, reframed as
 * "reference-6").
 *
 * The reference model: `evaluate()` treats the request's
 * `environment.permissionMode` as the AUTHORITATIVE baseline (one registry
 * follows an agent whose mode changes), layers plugin rules over that mode's
 * defaults, and maps the winning rule's mode to the result
 * (allow → allowed, deny / require_approval → not allowed). `list()` shows
 * the seed mode's defaults + plugin rules.
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

describe("ReferencePolicyRegistry implements the interface", () => {
  it("is assignable to PolicyRegistry and seeds defaults from its mode", () => {
    const registry: PolicyRegistry = new ReferencePolicyRegistry({
      defaultPermissionMode: "full_access",
    });
    expect(registry).toBeInstanceOf(ReferencePolicyRegistry);
    // 6 actions × 6 resources, all allow.
    expect(registry.list()).toHaveLength(36);
    expect(registry.list().every((rule) => rule.mode === "allow")).toBe(true);
  });

  it("loads the supervised deny overrides from defaults.ts", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "supervised",
    });
    const denyIds = registry
      .list()
      .filter((rule) => rule.mode === "deny")
      .map((rule) => rule.ruleId);
    expect(denyIds).toEqual(
      expect.arrayContaining([
        "default:supervised:deny:agent.stop",
        "default:supervised:deny:agent.fork",
        "default:supervised:deny:agent.archive",
        "default:supervised:deny:tool.execute",
      ]),
    );
  });

  it("list() returns a fresh array (callers may not corrupt the registry)", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "full_access",
    });
    const first = registry.list();
    first.length = 0;
    expect(registry.list()).toHaveLength(36);
  });
});

describe("ReferencePolicyRegistry.evaluate", () => {
  it("allows every action × resource under full_access", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "full_access",
    });
    for (const action of policyActionSchema.options) {
      for (const resource of policyResourceSchema.options) {
        const result = registry.evaluate(
          makeRequest(action, resource, "full_access"),
        );
        expect(result.allowed).toBe(true);
        expect(result.effectivePermissionMode).toBe("full_access");
        expect(result.ruleId).toBe(`default:allow:${action}:${resource}`);
      }
    }
  });

  it("denies the high-impact actions and tool.execute under supervised", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "supervised",
    });

    const denied = registry.evaluate(
      makeRequest("agent.stop", "agent", "supervised"),
    );
    expect(denied.allowed).toBe(false);
    expect(denied.ruleId).toBe("default:supervised:deny:agent.stop");
    expect(denied.effectivePermissionMode).toBe("supervised");

    for (const [action, resource] of [
      ["agent.fork", "agent"],
      ["agent.archive", "agent"],
      ["tool.execute", "tool"],
    ] as const) {
      expect(
        registry.evaluate(makeRequest(action, resource, "supervised")).allowed,
      ).toBe(false);
    }

    // Non-destructive actions remain allowed.
    expect(
      registry.evaluate(makeRequest("agent.create", "agent", "supervised"))
        .allowed,
    ).toBe(true);
    expect(
      registry.evaluate(makeRequest("agent.sendMessage", "agent", "supervised"))
        .allowed,
    ).toBe(true);
  });

  it("requires approval for agent.stop on an agent under auto_accept_edits", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "auto_accept_edits",
    });
    const result = registry.evaluate(
      makeRequest("agent.stop", "agent", "auto_accept_edits"),
    );
    expect(result.allowed).toBe(false);
    expect(result.ruleId).toBe(
      "default:auto_accept_edits:require_approval:agent.stop",
    );
    expect(result.reason).toContain("requires approval");

    expect(
      registry.evaluate(
        makeRequest("agent.create", "agent", "auto_accept_edits"),
      ).allowed,
    ).toBe(true);
  });

  it("follows the request's permissionMode baseline (mode changes need no rebuild)", () => {
    // Seeded supervised, but the request carries full_access: the registry
    // evaluates against full_access defaults and echoes that baseline.
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "supervised",
    });
    const escalated = registry.evaluate(
      makeRequest("agent.stop", "agent", "full_access"),
    );
    expect(escalated.allowed).toBe(true);
    expect(escalated.effectivePermissionMode).toBe("full_access");
  });
});

describe("ReferencePolicyRegistry plugin rules", () => {
  const SECRET_SEND_DENY: PolicyRule = {
    ruleId: "plugin:deny:secret.sendMessage",
    action: "agent.sendMessage",
    resource: "secret",
    impact: "high",
    condition: "always",
    mode: "deny",
    priority: 10,
  };

  it("register() overrides the allow-all baseline; unregister() restores it", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "full_access",
    });
    expect(
      registry.evaluate(
        makeRequest("agent.sendMessage", "secret", "full_access"),
      ).allowed,
    ).toBe(true);

    registry.register(SECRET_SEND_DENY);
    const denied = registry.evaluate(
      makeRequest("agent.sendMessage", "secret", "full_access"),
    );
    expect(denied.allowed).toBe(false);
    expect(denied.ruleId).toBe(SECRET_SEND_DENY.ruleId);

    registry.unregister(SECRET_SEND_DENY.ruleId);
    expect(
      registry.evaluate(
        makeRequest("agent.sendMessage", "secret", "full_access"),
      ).allowed,
    ).toBe(true);
  });

  it("register() upserts by ruleId and unregister() removes the single entry", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "full_access",
    });
    registry.register(SECRET_SEND_DENY);
    // Re-register with a different condition: replaces, not appends.
    registry.register({ ...SECRET_SEND_DENY, condition: "v2" });
    expect(
      registry.list().filter((rule) => rule.ruleId === SECRET_SEND_DENY.ruleId),
    ).toHaveLength(1);

    registry.unregister(SECRET_SEND_DENY.ruleId);
    expect(
      registry.list().filter((rule) => rule.ruleId === SECRET_SEND_DENY.ruleId),
    ).toHaveLength(0);
    expect(
      registry.evaluate(
        makeRequest("agent.sendMessage", "secret", "full_access"),
      ).allowed,
    ).toBe(true);
  });

  it("unregister() of an unknown id is a no-op", () => {
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "full_access",
    });
    expect(() => registry.unregister("does-not-exist")).not.toThrow();
    expect(registry.list()).toHaveLength(36);
  });
});

describe("policy audit events", () => {
  it("builds a valid approval event for a denied decision", () => {
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

    // The event shape must be a valid comm-graph @1.1 row.
    expect(epicCommunicationGraphEventSchemaV11.parse(event).kind).toBe(
      "approval",
    );
    expect(event.status).toBe("denied");
    expect(event.senderAgentId).toBe("agent-a");
    expect(event.targetAction).toBe("agent.stop");
    expect(event.approvalId).toContain("policy:");
    // Fields owned by other @1.1 kinds stay null.
    expect(event.toolName).toBeNull();
    expect(event.hostId).toBeNull();
    expect(event.agentId).toBeNull();
  });

  it("maps require_approval to pending and allow to granted", () => {
    const request = makeRequest("agent.stop", "agent", "auto_accept_edits");
    const decision = resolvePolicyDecision(
      request,
      defaultPolicyRulesForPermissionMode("auto_accept_edits"),
    );
    const base = {
      id: 2,
      request,
      decision,
      result: {
        allowed: false,
        reason: `requires approval: ${decision?.rule.condition ?? ""}`,
        ruleId: decision?.rule.ruleId ?? null,
        evaluatedAt: 1_753_000_000_001,
        effectivePermissionMode: "auto_accept_edits" as const,
      },
    };
    expect(buildPolicyAuditEvent(base).status).toBe("pending");

    const allowedRequest = makeRequest(
      "agent.create",
      "agent",
      "auto_accept_edits",
    );
    const allowedDecision = resolvePolicyDecision(
      allowedRequest,
      defaultPolicyRulesForPermissionMode("auto_accept_edits"),
    );
    expect(
      buildPolicyAuditEvent({
        id: 3,
        request: allowedRequest,
        decision: allowedDecision,
        result: {
          allowed: true,
          reason: allowedDecision?.rule.condition ?? null,
          ruleId: allowedDecision?.rule.ruleId ?? null,
          evaluatedAt: 1_753_000_000_002,
          effectivePermissionMode: "auto_accept_edits" as const,
        },
      }).status,
    ).toBe("granted");
  });

  it("a registry with an auditSink emits one valid event per evaluation", () => {
    const events: EpicCommunicationGraphEventV11[] = [];
    const registry = new ReferencePolicyRegistry({
      defaultPermissionMode: "supervised",
      auditSink: (event) => events.push(event),
    });

    registry.evaluate(makeRequest("agent.stop", "agent", "supervised"));
    registry.evaluate(makeRequest("agent.create", "agent", "supervised"));

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(
        epicCommunicationGraphEventSchemaV11.safeParse(event).success,
      ).toBe(true);
    }
    expect(events[0].status).toBe("denied");
    expect(events[1].status).toBe("granted");
  });
});
