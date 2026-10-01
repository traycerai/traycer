import type { AgentFailureReason } from "@traycer/protocol/persistence/epic/content-blocks";
import { fallbackReasonLabel } from "@traycer/protocol/host/notifications/presentation";

/**
 * How a failed turn's row should PRESENT itself.
 *
 * Two kinds, and the split is about what the reader is being asked to believe,
 * not about severity in the abstract:
 *
 *   - `interrupted` - a provider refused or lost the turn. Nothing is broken:
 *     an account is out of quota, a session is signed out, a bill needs paying,
 *     a provider is having a bad afternoon. The user has somewhere to go, and
 *     the row's job is to say where.
 *   - `error` - the turn itself failed. The request was rejected, the provider
 *     stopped responding mid-flight, background work died. There may be nothing
 *     to do but report it.
 *
 * Both used to render identically: a red `border-destructive` card with an
 * uppercase ERROR overline and the raw reason code in a red monospace chip. A
 * rate limit - the single commonest thing that happens to a working setup -
 * therefore looked exactly like a crash. That is the complaint this module
 * exists to answer, and the fix is one classification consulted by the row.
 *
 * Note this is about the ROW, not about whether Traycer will route around it.
 * The two questions have different answers and must not be collapsed:
 * `context_exhausted` is `interrupted` here (nothing broke; start a new chat)
 * while being permanently ineligible for routing, and `request_rejected` is an
 * `error` here while also being ineligible. Routing eligibility lives in
 * `EXCLUDED_FALLBACK_REASONS`; borrowing it to pick a colour would make a red
 * card the punishment for an unroutable failure.
 */
export type AgentFailurePresentation = "interrupted" | "error";

/**
 * Total over the reason union with no `default`, so a reason added to
 * `AGENT_FAILURE_REASONS` is a compile error here rather than silently
 * inheriting whichever arm happens to be last. The same discipline the reason
 * label maps already apply, and for the same reason: this is a decision per
 * member, not a fallthrough.
 */
const PRESENTATION_BY_REASON: Readonly<
  Record<AgentFailureReason, AgentFailurePresentation>
> = {
  // A provider said no. All six are ordinary operating conditions of a working
  // setup, and every one of them has a next step the user can take.
  auth: "interrupted",
  rate_limit: "interrupted",
  billing: "interrupted",
  model_unavailable: "interrupted",
  provider_unavailable: "interrupted",
  provider_connection_failed: "interrupted",
  // The chat outgrew its window. Nothing broke, and the remedy is the user's.
  context_exhausted: "interrupted",
  // A provider-side cap on the whole session, same shape as a rate limit.
  session_budget: "interrupted",
  // The turn itself died. A red row is the honest signal: these are not states
  // a user can be told to wait out, and most of them want a bug report.
  request_rejected: "error",
  turn_start_timeout: "error",
  missing_terminal_event: "error",
  background_work_failed: "error",
};

/**
 * How to present this failed turn - `error` when the host sent no typed reason.
 *
 * The untyped case is deliberately the RED one. A row from before the failure
 * payload existed, or one no turn produced, is a row nothing can vouch for; the
 * calm treatment is a claim ("this is routine, here is your next step") and
 * this is exactly the row that cannot support it.
 */
export function agentFailurePresentation(
  reason: AgentFailureReason | null,
): AgentFailurePresentation {
  if (reason === null) return "error";
  return PRESENTATION_BY_REASON[reason];
}

/**
 * The row's headline - the reason in the SAME words every other routing surface
 * uses for it.
 *
 * Deliberately `fallbackReasonLabel` rather than a second table. "Rate limit
 * reached" is what the countdown card's chip says, what the per-error settings
 * row is called, and what the transcript notice says afterwards; a fourth
 * wording invented here would make one situation read as several. `null` where
 * there is no typed reason, and the row then keeps its generic heading.
 */
export function agentFailureHeadline(
  reason: AgentFailureReason | null,
): string | null {
  if (reason === null) return null;
  return fallbackReasonLabel(reason);
}

/**
 * Host error codes that arrive with NO typed `failure` and are still
 * interruptions, each with its headline.
 *
 * The untyped rule above ("nothing can vouch for it, so it is red") is right
 * for a row the client knows nothing about, and wrong for a code the client
 * DOES know: `CLAUDE_RUNTIME_DISPOSED` is the host tearing a Claude Code
 * session down under a running turn - a host restart, an idle eviction - which
 * the host marks recoverable and which a Retry answers. Rendering it red with
 * the raw code as the loudest thing on the card is the "looks like a crash"
 * complaint this module exists to answer. A list of codes, not a pattern: each
 * entry is a claim about one code's meaning, made where it can be reviewed.
 */
const INTERRUPTED_UNTYPED_CODES: ReadonlyMap<string, string> = new Map([
  ["CLAUDE_RUNTIME_DISPOSED", "Session ended"],
]);

export interface UntypedCodePresentation {
  readonly presentation: "interrupted";
  readonly headline: string;
}

/**
 * The presentation for a row with no typed reason, by its code - or `null`
 * when the code is not one this client can vouch for, which keeps the red row.
 */
export function presentationForUntypedCode(
  code: string | null,
): UntypedCodePresentation | null {
  if (code === null) return null;
  const headline = INTERRUPTED_UNTYPED_CODES.get(code);
  if (headline === undefined) return null;
  return { presentation: "interrupted", headline };
}
