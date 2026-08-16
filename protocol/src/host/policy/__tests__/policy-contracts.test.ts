import { describe, expect, it } from "vitest";
import type { PermissionMode } from "@traycer/protocol/persistence/epic/foundation";
import {
  policyActionSchema,
  policyImpactSchema,
  policyResourceSchema,
  policyRuleModeSchema,
  policyRuleSchema,
  type PolicyAction,
  type PolicyResource,
} from "@traycer/protocol/host/policy/types";
import {
  policyEnvironmentSchema,
  policyEvaluationRequestSchema,
  policyEvaluationResultSchema,
  type PolicyEvaluationRequest,
} from "@traycer/protocol/host/policy/contracts";
import {
  defaultPolicyRulesForPermissionMode,
  matchingPolicyRules,
  resolvePolicyDecision,
} from "@traycer/protocol/host/policy/defaults";

/**
 * `protocol/src/host/policy` contract fixtures - Task 3 of Phase 0.
 *
 * The module is contracts-only: schemas, the in-process registry interface,
 * and the pure default rule sets. `resolvePolicyDecision` is the pure
 * matching semantics the host resolver will apply, which is what makes the
 * "full_access allows everything / supervised denies high-impact actions"
 * acceptance criteria testable without any host wiring.
 *
 * NOTE on conditions: the pure helpers match on `action` + `resource` only -
 * condition strings are opaque to the protocol (the host resolver evaluates
 * them). The defaults use `"always"` for unconditional rules and defer the
 * few conditional ones (supervised's exempt-tool allowlist, auto_accept_edits'
 * self-stop exemption) to the resolver; the tests below pin the pure
 * decision, not the resolver's condition refinement.
 */

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

const MODES: readonly PermissionMode[] = [
  "full_access",
  "supervised",
  "auto_accept_edits",
];

describe("policy enums", () => {
  it("accepts every documented action and rejects unknown ones", () => {
    for (const action of [
      "agent.create",
      "agent.stop",
      "agent.fork",
      "tool.execute",
      "agent.sendMessage",
      "agent.archive",
    ]) {
      expect(policyActionSchema.parse(action)).toBe(action);
    }
    expect(policyActionSchema.safeParse("agent.destroy").success).toBe(false);
  });

  it("accepts every documented resource and rejects unknown ones", () => {
    for (const resource of [
      "agent",
      "tool",
      "epic",
      "workspace",
      "secret",
      "host",
    ]) {
      expect(policyResourceSchema.parse(resource)).toBe(resource);
    }
    expect(policyResourceSchema.safeParse("cluster").success).toBe(false);
  });

  it("accepts every documented impact and rejects unknown ones", () => {
    for (const impact of ["none", "low", "medium", "high", "critical"]) {
      expect(policyImpactSchema.parse(impact)).toBe(impact);
    }
    expect(policyImpactSchema.safeParse("severe").success).toBe(false);
  });

  it("accepts every documented rule mode and rejects unknown ones", () => {
    for (const mode of ["allow", "deny", "require_approval"]) {
      expect(policyRuleModeSchema.parse(mode)).toBe(mode);
    }
    expect(policyRuleModeSchema.safeParse("escalate").success).toBe(false);
  });
});

describe("policyRuleSchema", () => {
  it("parses a complete rule and defaults priority to 0", () => {
    const rule = policyRuleSchema.parse({
      ruleId: "r1",
      action: "agent.stop",
      resource: "agent",
      impact: "high",
      condition: "target agent differs from the acting agent",
      mode: "require_approval",
    });
    expect(rule.ruleId).toBe("r1");
    expect(rule.mode).toBe("require_approval");
    expect(rule.priority).toBe(0);
  });

  it("parses an explicit priority and a non-always condition", () => {
    const rule = policyRuleSchema.parse({
      ruleId: "r2",
      action: "tool.execute",
      resource: "tool",
      impact: "medium",
      condition: "tool is not on the exempt allowlist",
      mode: "deny",
      priority: 10,
    });
    expect(rule.priority).toBe(10);
    expect(rule.condition).toBe("tool is not on the exempt allowlist");
  });

  it("rejects a rule missing required fields", () => {
    expect(
      policyRuleSchema.safeParse({ ruleId: "r3", action: "agent.stop" })
        .success,
    ).toBe(false);
  });

  it("rejects a rule with an out-of-enum value", () => {
    expect(
      policyRuleSchema.safeParse({
        ruleId: "r4",
        action: "agent.stop",
        resource: "agent",
        impact: "high",
        condition: "always",
        mode: "allow_everything",
      }).success,
    ).toBe(false);
  });
});

describe("policyEvaluationRequestSchema", () => {
  it("validates for every action × resource combo", () => {
    for (const action of policyActionSchema.options) {
      for (const resource of policyResourceSchema.options) {
        const parsed = policyEvaluationRequestSchema.parse(
          makeRequest(action, resource, "full_access"),
        );
        expect(parsed.action).toBe(action);
        expect(parsed.resource).toBe(resource);
      }
    }
  });

  it("defaults isRemote to false and accepts a concrete resourceId", () => {
    const parsed = policyEvaluationRequestSchema.parse({
      agentId: "agent-a",
      epicId: "epic-1",
      action: "tool.execute",
      resource: "tool",
      resourceId: "read_file",
      environment: {
        permissionMode: "supervised",
        harnessId: "claude",
      },
    });
    expect(parsed.environment.isRemote).toBe(false);
    expect(parsed.environment.harnessId).toBe("claude");
    expect(parsed.resourceId).toBe("read_file");
  });

  it("requires permissionMode, action and resource", () => {
    expect(
      policyEvaluationRequestSchema.safeParse({
        agentId: "agent-a",
        epicId: "epic-1",
        action: "agent.stop",
        resource: "agent",
        resourceId: null,
        environment: { harnessId: null },
      }).success,
    ).toBe(false);
    expect(
      policyEvaluationRequestSchema.safeParse({
        agentId: "agent-a",
        epicId: "epic-1",
        resource: "agent",
        resourceId: null,
        environment: { permissionMode: "full_access", harnessId: null },
      }).success,
    ).toBe(false);
  });

  it("validates the environment schema standalone", () => {
    expect(
      policyEnvironmentSchema.parse({
        permissionMode: "auto_accept_edits",
        harnessId: null,
        isRemote: true,
      }).isRemote,
    ).toBe(true);
  });
});

describe("policyEvaluationResultSchema", () => {
  it("parses an allowed result", () => {
    const result = policyEvaluationResultSchema.parse({
      allowed: true,
      reason: "always",
      ruleId: "default:allow:agent.sendMessage:agent",
      evaluatedAt: 1_753_000_000_000,
      effectivePermissionMode: "full_access",
    });
    expect(result.allowed).toBe(true);
    expect(result.effectivePermissionMode).toBe("full_access");
    expect(result.ruleId).toBe("default:allow:agent.sendMessage:agent");
  });

  it("parses a denied result with a null rule (default-deny no-match)", () => {
    const result = policyEvaluationResultSchema.parse({
      allowed: false,
      reason: "no matching policy rule",
      ruleId: null,
      evaluatedAt: 1_753_000_000_001,
      effectivePermissionMode: "supervised",
    });
    expect(result.allowed).toBe(false);
    expect(result.ruleId).toBeNull();
  });

  it("rejects an out-of-enum effectivePermissionMode", () => {
    expect(
      policyEvaluationResultSchema.safeParse({
        allowed: true,
        reason: null,
        ruleId: null,
        evaluatedAt: 1_753_000_000_000,
        effectivePermissionMode: "everything",
      }).success,
    ).toBe(false);
  });
});

describe("default policy rule sets", () => {
  it("full_access allows every action × resource and nothing else", () => {
    const rules = defaultPolicyRulesForPermissionMode("full_access");
    // 6 actions × 6 resources, all allow, no overrides.
    expect(rules).toHaveLength(6 * 6);
    expect(rules.every((rule) => rule.mode === "allow")).toBe(true);

    for (const action of policyActionSchema.options) {
      for (const resource of policyResourceSchema.options) {
        expect(
          resolvePolicyDecision(
            makeRequest(action, resource, "full_access"),
            rules,
          )?.mode,
        ).toBe("allow");
      }
    }
  });

  it("supervised denies the high-impact actions and tool.execute", () => {
    const rules = defaultPolicyRulesForPermissionMode("supervised");

    // agent.stop / agent.fork / agent.archive are high-impact (archive is
    // covered by the "denies high-impact actions" criterion even though the
    // brief's explicit list names stop/fork); tool.execute is medium but has
    // a wider blast radius and is denied with an exempt-allowlist condition.
    for (const [action, resource] of [
      ["agent.stop", "agent"],
      ["agent.fork", "agent"],
      ["agent.archive", "agent"],
      ["tool.execute", "tool"],
    ] as const) {
      expect(
        resolvePolicyDecision(
          makeRequest(action, resource, "supervised"),
          rules,
        )?.mode,
      ).toBe("deny");
    }

    // Non-destructive actions remain allowed.
    for (const [action, resource] of [
      ["agent.create", "agent"],
      ["agent.sendMessage", "agent"],
    ] as const) {
      expect(
        resolvePolicyDecision(
          makeRequest(action, resource, "supervised"),
          rules,
        )?.mode,
      ).toBe("allow");
    }
  });

  it("auto_accept_edits requires approval for agent.stop on an agent and allows the rest", () => {
    const rules = defaultPolicyRulesForPermissionMode("auto_accept_edits");
    expect(
      resolvePolicyDecision(
        makeRequest("agent.stop", "agent", "auto_accept_edits"),
        rules,
      )?.mode,
    ).toBe("require_approval");
    expect(
      resolvePolicyDecision(
        makeRequest("agent.create", "agent", "auto_accept_edits"),
        rules,
      )?.mode,
    ).toBe("allow");
    expect(
      resolvePolicyDecision(
        makeRequest("tool.execute", "tool", "auto_accept_edits"),
        rules,
      )?.mode,
    ).toBe("allow");
  });

  it("every default rule validates against policyRuleSchema", () => {
    for (const mode of MODES) {
      const rules = defaultPolicyRulesForPermissionMode(mode);
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(policyRuleSchema.safeParse(rule).success).toBe(true);
      }
    }
  });

  it("returns a fresh array per call (callers may mutate their copy)", () => {
    const first = defaultPolicyRulesForPermissionMode("full_access");
    const second = defaultPolicyRulesForPermissionMode("full_access");
    expect(first).not.toBe(second);
  });

  it("matchingPolicyRules returns only action + resource matches, in order", () => {
    const rules = defaultPolicyRulesForPermissionMode("supervised");
    const matches = matchingPolicyRules(
      makeRequest("agent.stop", "agent", "supervised"),
      rules,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(
      matches.every(
        (rule) => rule.action === "agent.stop" && rule.resource === "agent",
      ),
    ).toBe(true);
  });
});
