import { z } from "zod";

/**
 * Public sub-schemas that are not registered records - building blocks
 * embedded by the actual records owned by `commonRecordRegistry`.
 *
 * Record schemas (`json-content`, `attachment-mention-attrs`,
 * `attachment-mention-node`, `permission-role`, `ticket-status`,
 * `epic-artifact-kind`) live under `_internal/schemas.ts` and are
 * reachable only through
 * `getRecordSchema(commonRecordRegistry, "<record-name>")`. Their
 * runtime values are the TypeScript authority - consumers derive types
 * via `RecordValue<typeof commonRecordRegistry, "<record-name>">` so
 * the type and the runtime check can never drift.
 */

/**
 * Sub-schema reused by the recursive `json-content` record. Not a
 * record itself - it has no independent lifecycle and is embedded only
 * inside `jsonContentSchema`.
 */
export const jsonContentMarkSchema = z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

export const agentModeSchema = z.enum(["regular", "epic"]);
export type AgentMode = z.infer<typeof agentModeSchema>;
export const DEFAULT_AGENT_MODE: AgentMode = "epic";

/**
 * Billing/account context a turn runs under: the signed-in user's personal
 * account, or one specific team they belong to. This is the client's native
 * model (Personal + Teams; no Org) and mirrors the `account-context-store`
 * selection in the gui-app. It rides on `chatRunSettings` so a queued turn
 * bills the context it was sent with, and is carried to the Traycer cloud
 * backend's inference boundary (see `ACCOUNT_CONTEXT_HEADER`) where it maps to
 * the credit-handler `{ accountContextType, organizationId }` shape (TEAM -> ORG).
 */
export const accountContextSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PERSONAL") }),
  z.object({ type: z.literal("TEAM"), teamId: z.string().min(1) }),
]);
export type AccountContext = z.infer<typeof accountContextSchema>;
export const DEFAULT_ACCOUNT_CONTEXT: AccountContext = { type: "PERSONAL" };

/**
 * HTTP header carrying the serialized `AccountContext` from the Traycer Host's
 * per-user OpenCode server to the Traycer cloud backend's `/inference` route. OpenCode
 * owns the provider HTTP calls, so the only injectable per-call signal is a
 * static provider-config header baked into the per-user server spawn.
 */
export const ACCOUNT_CONTEXT_HEADER = "x-traycer-account-context";

const ACCOUNT_CONTEXT_TEAM_PREFIX = "TEAM:";

/** Wire form: `"PERSONAL"` or `"TEAM:<teamId>"`. */
export function serializeAccountContext(ctx: AccountContext): string {
  return ctx.type === "TEAM"
    ? `${ACCOUNT_CONTEXT_TEAM_PREFIX}${ctx.teamId}`
    : "PERSONAL";
}

/**
 * Inverse of `serializeAccountContext`. Falls back to PERSONAL for a
 * missing/empty/unrecognized value so an absent header never throws - the
 * server still validates team membership before trusting a TEAM context.
 */
export function parseAccountContext(value: string | undefined): AccountContext {
  if (value === undefined || value === "PERSONAL") {
    return DEFAULT_ACCOUNT_CONTEXT;
  }
  if (value.startsWith(ACCOUNT_CONTEXT_TEAM_PREFIX)) {
    const teamId = value.slice(ACCOUNT_CONTEXT_TEAM_PREFIX.length);
    if (teamId.length > 0) {
      return { type: "TEAM", teamId };
    }
  }
  return DEFAULT_ACCOUNT_CONTEXT;
}
