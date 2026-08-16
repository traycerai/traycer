import { z } from "zod";

/**
 * `protocol/src/host/policy/` - the policy evaluation wire contract for
 * Traycer Enhanced Phase 0 (Task 3).
 *
 * This module is CONTRACTS ONLY: zod schemas, the in-process registry
 * interface, and the pure default rule sets. There is deliberately no host
 * resolver, no SQLite, and no action-dispatch hook here - those are later
 * tasks (6 and 8). The policy audit trail will eventually surface as
 * comm-graph `approval` / `lifecycle` @1.1 events (Task 1), but nothing in
 * this module depends on the communication graph.
 *
 * Evaluation model (encoded in `defaults.ts`, applied by the resolver):
 * the registry matches a request's `action` + `resource` against its rules,
 * picks the HIGHEST-`priority` match (ties break by registration order),
 * and the winning rule's `mode` is the decision. `condition` strings are
 * human-readable predicates evaluated by the HOST resolver - the protocol
 * treats them as opaque (only `"always"` is meaningful to the pure helpers
 * in `defaults.ts`).
 */

/**
 * The action an agent is attempting. CLOSED enum: the registry matches
 * requests against rules by this exact value, so an unknown action can never
 * be evaluated - the evaluator treats it as no-match, which defaults to deny.
 * Adding an action is a reviewed schema change with every consumer, never a
 * silent widening.
 */
export const policyActionSchema = z.enum([
  "agent.create",
  "agent.stop",
  "agent.fork",
  "tool.execute",
  "agent.sendMessage",
  "agent.archive",
]);
export type PolicyAction = z.infer<typeof policyActionSchema>;

/** The resource class the action targets. Closed for the same reason. */
export const policyResourceSchema = z.enum([
  "agent",
  "tool",
  "epic",
  "workspace",
  "secret",
  "host",
]);
export type PolicyResource = z.infer<typeof policyResourceSchema>;

/**
 * Impact level - used for gating decisions:
 *
 * - `none`      - no observable effect
 * - `low`       - reversible, narrow scope
 * - `medium`    - reversible but wider blast radius
 * - `high`      - possibly irreversible or expensive
 * - `critical`  - destructive - confirm/reject only
 */
export const policyImpactSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "critical",
]);
export type PolicyImpact = z.infer<typeof policyImpactSchema>;

/** How a matching rule disposes of the request. */
export const policyRuleModeSchema = z.enum([
  "allow",
  "deny",
  "require_approval",
]);
export type PolicyRuleMode = z.infer<typeof policyRuleModeSchema>;

/**
 * One policy rule: a predicate the registry evaluates.
 *
 * `priority` is the disambiguation key: when several rules match a request,
 * the highest `priority` wins and ties break by registration order. The
 * default rule sets in `defaults.ts` use this to layer mode-specific
 * overrides (priority 10) on top of an allow-all baseline (priority 0).
 */
export const policyRuleSchema = z.object({
  ruleId: z.string(),
  action: policyActionSchema,
  resource: policyResourceSchema,
  impact: policyImpactSchema,
  /**
   * Human-readable description of the predicate, evaluated by the host
   * resolver (e.g. "agent belongs to the calling user's epic"). Opaque to
   * the protocol: the pure decision helpers in `defaults.ts` treat `"always"`
   * as unconditional and defer every other condition to the resolver.
   */
  condition: z.string(),
  mode: policyRuleModeSchema,
  priority: z.number().int().default(0),
});
export type PolicyRule = z.infer<typeof policyRuleSchema>;
