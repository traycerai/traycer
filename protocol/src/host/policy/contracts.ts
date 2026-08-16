import { z } from "zod";
import { permissionModeSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  policyActionSchema,
  policyResourceSchema,
  type PolicyRule,
} from "./types";

/**
 * Runtime context the evaluator keys on, beyond the action/resource pair.
 *
 * `permissionMode` is the chat/agent's effective baseline
 * (`supervised` / `auto_accept_edits` / `full_access`); the default rule
 * sets in `defaults.ts` are selected FROM it, and the evaluation result
 * echoes it as `effectivePermissionMode` so the caller can see which
 * baseline produced the decision.
 */
export const policyEnvironmentSchema = z.object({
  permissionMode: permissionModeSchema,
  harnessId: z.string().nullable(),
  /** True when the acting agent runs on a remote host (cross-host action). */
  isRemote: z.boolean().default(false),
});
export type PolicyEnvironment = z.infer<typeof policyEnvironmentSchema>;

/** What gets evaluated. */
export const policyEvaluationRequestSchema = z.object({
  /** The agent attempting the action. */
  agentId: z.string(),
  /** Epic the action happens in - scopes every rule's provenance check. */
  epicId: z.string(),
  action: policyActionSchema,
  resource: policyResourceSchema,
  /** Concrete target id (e.g. the tool name, the target agent id). Null when
   * the request is about the class, not one instance. */
  resourceId: z.string().nullable(),
  environment: policyEnvironmentSchema,
});
export type PolicyEvaluationRequest = z.infer<
  typeof policyEvaluationRequestSchema
>;

/** The result of one evaluation. */
export const policyEvaluationResultSchema = z.object({
  allowed: z.boolean(),
  /** Human-readable justification (rule condition, or why nothing matched). */
  reason: z.string().nullable(),
  /** The rule that decided, or null when no rule matched (default deny). */
  ruleId: z.string().nullable(),
  /** Host wall clock at evaluation, epoch millis. */
  evaluatedAt: z.number().int(),
  /** Which permission mode was the effective baseline. */
  effectivePermissionMode: permissionModeSchema,
});
export type PolicyEvaluationResult = z.infer<
  typeof policyEvaluationResultSchema
>;

/**
 * Registry contract - typed but NOT RPC (in-process). The host wires a
 * concrete implementation in a later task; this interface is the seam the
 * action-dispatch hook (Task 8) will evaluate through.
 */
export interface PolicyRegistry {
  register(rule: PolicyRule): void;
  unregister(ruleId: string): void;
  evaluate(request: PolicyEvaluationRequest): PolicyEvaluationResult;
  list(): PolicyRule[];
}
