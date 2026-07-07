import { z } from "zod";
import {
  approvalAllowRuleSchema,
  approvalAllowScopeSchema,
} from "@traycer/protocol/host/agent/gui/agent-runtime";

/**
 * Wire schemas for the per-device action allowlist management RPCs
 * (`commandAllowlist.list` / `commandAllowlist.remove` / `commandAllowlist.clear`).
 * The rules themselves are saved from approval prompts ("Always allow"); these
 * methods back the settings panel that lists, deletes, and clears them. Rule
 * shape is reused from {@link approvalAllowRuleSchema} so the stored, matched,
 * and managed shapes never drift.
 */

export const commandAllowlistListRequestSchema = z.object({});
export type CommandAllowlistListRequest = z.infer<
  typeof commandAllowlistListRequestSchema
>;

export const commandAllowlistListResponseSchema = z.object({
  rules: z.array(approvalAllowRuleSchema),
});
export type CommandAllowlistListResponse = z.infer<
  typeof commandAllowlistListResponseSchema
>;

export const commandAllowlistRemoveRequestSchema = z.object({
  rule: approvalAllowRuleSchema,
});
export type CommandAllowlistRemoveRequest = z.infer<
  typeof commandAllowlistRemoveRequestSchema
>;

export const commandAllowlistRemoveResponseSchema = z.object({
  rules: z.array(approvalAllowRuleSchema),
});
export type CommandAllowlistRemoveResponse = z.infer<
  typeof commandAllowlistRemoveResponseSchema
>;

// `scope` omitted clears every rule (the settings "Clear all"); a `scope`
// clears only that one scope (a Global or single-workspace "Clear"). Shipped in
// the same release that introduces the method, so there is no scope-less host in
// the field to downgrade against — `scope` rides `clear@1.0` directly, no minor.
export const commandAllowlistClearRequestSchema = z.object({
  scope: approvalAllowScopeSchema.optional(),
});
export type CommandAllowlistClearRequest = z.infer<
  typeof commandAllowlistClearRequestSchema
>;

export const commandAllowlistClearResponseSchema = z.object({
  rules: z.array(approvalAllowRuleSchema),
});
export type CommandAllowlistClearResponse = z.infer<
  typeof commandAllowlistClearResponseSchema
>;
