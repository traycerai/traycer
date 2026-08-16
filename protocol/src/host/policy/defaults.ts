import type { PermissionMode } from "@traycer/protocol/persistence/epic/foundation";
import {
  policyActionSchema,
  policyResourceSchema,
  type PolicyAction,
  type PolicyImpact,
  type PolicyResource,
  type PolicyRule,
  type PolicyRuleMode,
} from "./types";
import type { PolicyEvaluationRequest } from "./contracts";

/**
 * Default rule sets that map the existing `permissionMode` strings to
 * concrete `PolicyRule` lists - the "default implementations" the host
 * registry seeds from. Pure data plus two pure decision helpers; there is no
 * resolver here (that is a later task), but `resolvePolicyDecision` is the
 * exact matching semantics the resolver will apply, so the defaults are
 * testable end-to-end without host wiring.
 *
 * Layering: every mode starts from an allow-all baseline at `priority: 0`,
 * then a mode-specific override at `OVERRIDE_PRIORITY` narrows it:
 *
 * - `full_access`       - baseline only: everything allowed.
 * - `supervised`        - baseline + DENY overrides for the high-impact
 *   actions (`agent.stop`, `agent.fork`, `agent.archive`) and
 *   `tool.execute` (medium impact, wider blast radius; the condition defers
 *   an exempt-tool allowlist to the resolver).
 * - `auto_accept_edits` - baseline + a REQUIRE_APPROVAL override for
 *   `agent.stop` on an agent when the target is not the acting agent (the
 *   self-stop exemption is a resolver-side condition refinement).
 *
 * `condition` strings are opaque to the protocol (see `types.ts`): the pure
 * helpers match on `action` + `resource` only, so an override whose condition
 * is not `"always"` still governs the pure decision - the HOST resolver
 * applies the condition before acting on it.
 */

const ALL_ACTIONS: readonly PolicyAction[] = policyActionSchema.options;
const ALL_RESOURCES: readonly PolicyResource[] = policyResourceSchema.options;

/** Baseline blast-radius of each action, used to weight gating decisions. */
const ACTION_IMPACT: Record<PolicyAction, PolicyImpact> = {
  "agent.create": "medium",
  "agent.stop": "high",
  "agent.fork": "medium",
  "tool.execute": "medium",
  "agent.sendMessage": "low",
  "agent.archive": "high",
};

const OVERRIDE_PRIORITY = 10;

/** Every action × every resource, all `allow` at priority 0. */
function allowAllRules(): PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const action of ALL_ACTIONS) {
    for (const resource of ALL_RESOURCES) {
      rules.push({
        ruleId: `default:allow:${action}:${resource}`,
        action,
        resource,
        impact: ACTION_IMPACT[action],
        condition: "always",
        mode: "allow",
        priority: 0,
      });
    }
  }
  return rules;
}

/**
 * `supervised` overrides: deny the actions a supervised session must not take
 * unilaterally. `agent.archive` is included with `agent.stop`/`agent.fork`
 * because it is equally high-impact - the brief's explicit deny list names
 * the first three, and the "denies high-impact actions" acceptance criterion
 * covers `agent.archive` too. `tool.execute` is denied at medium impact with
 * an exempt-allowlist condition (the resolver owns the exemption).
 */
const SUPERVISED_DENY_RULES: readonly PolicyRule[] = [
  {
    ruleId: "default:supervised:deny:agent.stop",
    action: "agent.stop",
    resource: "agent",
    impact: "high",
    condition: "always",
    mode: "deny",
    priority: OVERRIDE_PRIORITY,
  },
  {
    ruleId: "default:supervised:deny:agent.fork",
    action: "agent.fork",
    resource: "agent",
    impact: "medium",
    condition: "always",
    mode: "deny",
    priority: OVERRIDE_PRIORITY,
  },
  {
    ruleId: "default:supervised:deny:agent.archive",
    action: "agent.archive",
    resource: "agent",
    impact: "high",
    condition: "always",
    mode: "deny",
    priority: OVERRIDE_PRIORITY,
  },
  {
    ruleId: "default:supervised:deny:tool.execute",
    action: "tool.execute",
    resource: "tool",
    impact: "medium",
    condition: "tool is not on the exempt allowlist",
    mode: "deny",
    priority: OVERRIDE_PRIORITY,
  },
];

/**
 * `auto_accept_edits` override: stopping ANOTHER agent is a high-impact,
 * possibly irreversible action, so it requires approval even though most
 * actions are auto-accepted. The condition defers the self-stop exemption
 * (target IS the acting agent) to the resolver.
 */
const AUTO_ACCEPT_EDITS_STOP_RULE: PolicyRule = {
  ruleId: "default:auto_accept_edits:require_approval:agent.stop",
  action: "agent.stop",
  resource: "agent",
  impact: "high",
  condition: "target agent differs from the acting agent",
  mode: "require_approval",
  priority: OVERRIDE_PRIORITY,
};

/** Canonical default rule set per permission mode. */
export const DEFAULT_POLICY_RULES_BY_MODE: Record<
  PermissionMode,
  readonly PolicyRule[]
> = {
  full_access: allowAllRules(),
  supervised: [...allowAllRules(), ...SUPERVISED_DENY_RULES],
  auto_accept_edits: [...allowAllRules(), AUTO_ACCEPT_EDITS_STOP_RULE],
};

/** The default rule set for one permission mode (a fresh array each call). */
export function defaultPolicyRulesForPermissionMode(
  mode: PermissionMode,
): PolicyRule[] {
  return [...DEFAULT_POLICY_RULES_BY_MODE[mode]];
}

/**
 * All rules that match a request's `action` + `resource`, in registration
 * order. Conditions are NOT evaluated here - they are opaque to the protocol
 * and the host resolver applies them (see `types.ts`).
 */
export function matchingPolicyRules(
  request: PolicyEvaluationRequest,
  rules: readonly PolicyRule[],
): PolicyRule[] {
  return rules.filter(
    (rule) =>
      rule.action === request.action && rule.resource === request.resource,
  );
}

/**
 * The governing decision for a request against a rule set: the matching rule
 * with the highest `priority` (ties break by registration order), or null
 * when nothing matches. The caller treats null as default-DENY.
 *
 * This is the pure matching semantics the host resolver will apply; it does
 * not itself implement condition evaluation, approval escalation, or the
 * audit-trail write.
 */
export function resolvePolicyDecision(
  request: PolicyEvaluationRequest,
  rules: readonly PolicyRule[],
): { mode: PolicyRuleMode; rule: PolicyRule } | null {
  let best: { mode: PolicyRuleMode; rule: PolicyRule } | null = null;
  for (const rule of rules) {
    if (rule.action !== request.action || rule.resource !== request.resource) {
      continue;
    }
    if (best === null || rule.priority > best.rule.priority) {
      best = { mode: rule.mode, rule };
    }
  }
  return best;
}
