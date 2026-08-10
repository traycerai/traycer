/**
 * Display filter for the orchestration prelude. The fork injects role/team
 * context by prefixing the chat's first user message at creation time; the
 * block is model-facing context, not user input, so the chat bubble renders
 * the message without it. The stored/sent content is never mutated here —
 * this is presentation-only.
 *
 * Markers (emitted by the CLI's orchestration store):
 *   <!-- traycer-orchestration-prelude --> ... <!-- /traycer-orchestration-prelude -->
 */
export const ORCHESTRATION_PRELUDE_START =
  "<!-- traycer-orchestration-prelude -->";
export const ORCHESTRATION_PRELUDE_END =
  "<!-- /traycer-orchestration-prelude -->";

/**
 * Returns the message with the prelude span removed. Fail-open everywhere:
 * no markers, an unterminated marker, or a message that would become empty
 * (prelude-only) all return the input unchanged.
 */
export function stripOrchestrationPrelude(content: string): string {
  const start = content.indexOf(ORCHESTRATION_PRELUDE_START);
  if (start === -1) return content;
  const end = content.indexOf(
    ORCHESTRATION_PRELUDE_END,
    start + ORCHESTRATION_PRELUDE_START.length,
  );
  if (end === -1) return content;
  const after = end + ORCHESTRATION_PRELUDE_END.length;
  const before = content.slice(0, start).trimEnd();
  const following = content.slice(after).replace(/^\s+/, "");
  const joined = (before.length > 0 ? `${before}\n\n` : "") + following;
  if (joined.trim().length === 0) return content;
  return joined;
}
