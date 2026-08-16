import type { PermissionMode } from "@traycer/protocol/persistence/epic/foundation";
import type { EpicCommunicationGraphEventV11 } from "@traycer/protocol/host/epic/communication-graph";
import {
  policyEvaluationRequestSchema,
  type PolicyEvaluationRequest,
  type PolicyEvaluationResult,
  type PolicyRegistry,
} from "./contracts";
import {
  defaultPolicyRulesForPermissionMode,
  resolvePolicyDecision,
} from "./defaults";
import {
  policyRuleSchema,
  type PolicyRule,
  type PolicyRuleMode,
} from "./types";

/**
 * REFERENCE IMPLEMENTATION of the `PolicyRegistry` interface from
 * `contracts.ts` - the canonical in-memory registry a Traycer host VENDORS
 * or replaces per-host. It is deliberately protocol-side so the policy
 * semantics are provable end-to-end without the closed host, and so Task 9's
 * two-host acceptance can run against the protocol layer alone.
 *
 * What this is NOT: the production host resolver. It has no SQLite, no
 * action-dispatch hook, and no comm-graph transport. A host wires emission
 * by passing an `auditSink` (or by calling `buildPolicyAuditEvent` itself
 * and handing the row to its own log writer).
 *
 * Evaluation model (the semantics a vendoring host must match):
 *
 *   - The request's `environment.permissionMode` is the AUTHORITATIVE
 *     baseline: `evaluate()` selects `defaultPolicyRulesForPermissionMode`
 *     for THAT mode (so one registry follows an agent whose permission mode
 *     changes, without reconstruction) and layers plugin rules on top.
 *     The constructor's `defaultPermissionMode` seeds the rule set shown by
 *     `list()` before any evaluation.
 *   - `resolvePolicyDecision` picks the highest-`priority` matching rule
 *     (ties break by registration order). The winning mode maps to the
 *     result as: `allow` → `allowed: true`; `deny` → `allowed: false`;
 *     `require_approval` → `allowed: false` (the caller escalates, see
 *     Task 8) with a "requires approval: …" reason. No match → default-deny.
 *   - Every `evaluate()` optionally hands an `approval`-kind comm-graph
 *     event to the `auditSink` (status `granted` / `denied` / `pending`).
 */

export type ReferencePolicyRegistryOptions = {
  /** The agent's permission mode at registry creation. Seeds the default
   * rule set; `evaluate()` follows the request's mode at call time. */
  defaultPermissionMode: PermissionMode;
  /**
   * Optional sink receiving one comm-graph audit event per evaluation
   * (kind `approval`, status `granted` / `denied` / `pending`). The
   * reference registry MINTs the event with a provisional `id` equal to
   * `evaluatedAt`; a vendoring host must replace it with its own log
   * sequence before persisting. Omit for a registry that only decides.
   */
  auditSink?: (event: EpicCommunicationGraphEventV11) => void;
};

export class ReferencePolicyRegistry implements PolicyRegistry {
  private readonly defaultPermissionMode: PermissionMode;
  private readonly auditSink:
    ((event: EpicCommunicationGraphEventV11) => void) | undefined;
  /** Rules registered by plugins/harnesses - mode-independent overrides
   * layered on top of the per-mode defaults. */
  private readonly pluginRules: PolicyRule[] = [];

  constructor(options: ReferencePolicyRegistryOptions) {
    this.defaultPermissionMode = options.defaultPermissionMode;
    this.auditSink = options.auditSink;
  }

  /**
   * Registers a plugin/harness rule. Validated against
   * `policyRuleSchema`; a ruleId already present is REPLACED (upsert), so
   * re-registration on hot reload is safe.
   */
  register(rule: PolicyRule): void {
    const parsed = policyRuleSchema.parse(rule);
    const existing = this.pluginRules.findIndex(
      (candidate) => candidate.ruleId === parsed.ruleId,
    );
    if (existing >= 0) {
      this.pluginRules[existing] = parsed;
    } else {
      this.pluginRules.push(parsed);
    }
  }

  /**
   * Removes a PLUGIN rule by id. Default rules are re-seeded from
   * `defaults.ts` on every evaluation and cannot be unregistered; an unknown
   * id is a no-op.
   */
  unregister(ruleId: string): void {
    const existing = this.pluginRules.findIndex(
      (candidate) => candidate.ruleId === ruleId,
    );
    if (existing >= 0) {
      this.pluginRules.splice(existing, 1);
    }
  }

  evaluate(request: PolicyEvaluationRequest): PolicyEvaluationResult {
    const parsed = policyEvaluationRequestSchema.parse(request);
    const effectivePermissionMode = parsed.environment.permissionMode;
    const rules = [
      ...defaultPolicyRulesForPermissionMode(effectivePermissionMode),
      ...this.pluginRules,
    ];
    const decision = resolvePolicyDecision(parsed, rules);
    const evaluatedAt = Date.now();

    let result: PolicyEvaluationResult;
    if (decision === null) {
      result = {
        allowed: false,
        reason: "no matching policy rule",
        ruleId: null,
        evaluatedAt,
        effectivePermissionMode,
      };
    } else if (decision.mode === "allow") {
      result = {
        allowed: true,
        reason: decision.rule.condition,
        ruleId: decision.rule.ruleId,
        evaluatedAt,
        effectivePermissionMode,
      };
    } else if (decision.mode === "require_approval") {
      result = {
        allowed: false,
        reason: `requires approval: ${decision.rule.condition}`,
        ruleId: decision.rule.ruleId,
        evaluatedAt,
        effectivePermissionMode,
      };
    } else {
      // deny
      result = {
        allowed: false,
        reason: decision.rule.condition,
        ruleId: decision.rule.ruleId,
        evaluatedAt,
        effectivePermissionMode,
      };
    }

    if (this.auditSink !== undefined) {
      this.auditSink(
        buildPolicyAuditEvent({
          id: result.evaluatedAt,
          request: parsed,
          result,
          decision,
        }),
      );
    }

    return result;
  }

  /**
   * The current rule set: defaults for the registry's seed mode plus all
   * registered plugin rules, in registration order. A fresh array each call;
   * callers may inspect but should not mutate it.
   */
  list(): PolicyRule[] {
    return [
      ...defaultPolicyRulesForPermissionMode(this.defaultPermissionMode),
      ...this.pluginRules,
    ];
  }
}

export type PolicyAuditEventInput = {
  /** The host's log row id for this event (autoincrement, positive). The
   * reference registry passes `evaluatedAt` as a provisional value; a
   * vendoring host passes its own sequence. */
  id: number;
  request: PolicyEvaluationRequest;
  result: PolicyEvaluationResult;
  /** The governing decision from `resolvePolicyDecision`, or null for the
   * default-deny no-match case. */
  decision: { mode: PolicyRuleMode; rule: PolicyRule } | null;
};

/**
 * Constructs the comm-graph `approval` @1.1 audit event for one policy
 * evaluation - the event shape only; it does NOT emit (a host hands the
 * result to its log writer / `auditSink`).
 *
 * Kind is `approval` (not `lifecycle`): a policy evaluation is an approval
 * decision, and the `approval` kind carries exactly the right fields -
 * `senderAgentId` is the REQUESTER (`request.agentId`), `status` maps
 * `granted` / `denied` / `pending`, and `targetAction` is the gated action.
 * The event validates against `epicCommunicationGraphEventSchemaV11`.
 */
export function buildPolicyAuditEvent(
  input: PolicyAuditEventInput,
): EpicCommunicationGraphEventV11 {
  const { id, request, result, decision } = input;
  const status: "pending" | "granted" | "denied" =
    decision === null
      ? "denied"
      : decision.mode === "allow"
        ? "granted"
        : decision.mode === "require_approval"
          ? "pending"
          : "denied";

  return {
    id,
    kind: "approval",
    timestamp: result.evaluatedAt,
    senderAgentId: request.agentId,
    receiverAgentId: null,
    responseId: null,
    inReplyTo: null,
    expectReply: null,
    messageText: null,
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    toolName: null,
    toolInput: null,
    durationMs: null,
    success: null,
    tokenCost: null,
    approvalId: `policy:${request.agentId}:${result.evaluatedAt}`,
    status,
    targetAction: request.action,
    agentId: null,
    previousState: null,
    newState: null,
    trigger: null,
    hostId: null,
    resourceType: null,
    metricValue: null,
    threshold: null,
    breach: null,
  };
}
