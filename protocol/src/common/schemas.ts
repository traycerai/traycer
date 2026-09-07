import { z } from "zod";

/**
 * Public sub-schemas that are not registered records - building blocks embedded by the actual records owned by `commonRecordRegistry`.
 * Their runtime values are the TypeScript authority - consumers derive types via `RecordValue<typeof commonRecordRegistry, "<record-name>">` so the type and the runtime check can never drift.
 */

/**
 * The exact ISO-8601 form `Date#toISOString()` emits: a calendar date-time qualified by `Z` or an explicit numeric offset, always carrying exactly three fractional-second digits.
 * One schema, both boundaries - the HTTP mint response and the stream provision frame carry the same field and must not drift apart.
 */
export const isoMillisecondTimestampSchema = z.iso.datetime({
  offset: true,
  precision: 3,
});

/** Sub-schema reused by the recursive `json-content` record. */
export const jsonContentMarkSchema = z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

export const agentModeSchema = z.enum(["regular", "epic"]);
export type AgentMode = z.infer<typeof agentModeSchema>;
export const DEFAULT_AGENT_MODE: AgentMode = "regular";

/**
 * Billing/account context a turn runs under: the signed-in user's personal account, or one specific team they belong to.
 */
export const accountContextSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PERSONAL") }),
  z.object({ type: z.literal("TEAM"), teamId: z.string().min(1) }),
]);
export type AccountContext = z.infer<typeof accountContextSchema>;
export const DEFAULT_ACCOUNT_CONTEXT: AccountContext = { type: "PERSONAL" };

/**
 * HTTP header carrying the serialized `AccountContext` from the Traycer Host's per-user OpenCode server to the Traycer cloud backend's `/inference` route.
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
 * Inverse of `serializeAccountContext`.
 * Falls back to PERSONAL for a missing/empty/unrecognized value so an absent header never throws - the server still validates team membership before trusting a TEAM context.
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
