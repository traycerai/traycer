/**
 * Shared sub-agent nesting/suppression policy for the harness converters
 * (Codex, OpenCode, …). A sub-agent runs in a child session/thread; its events
 * must either nest under the sub-agent card (tagged with the card's
 * `parentBlockId`) or be suppressed - they must NEVER surface un-parented in the
 * parent timeline. Keeping the policy here (one source of truth) stops the
 * per-converter copies from drifting and makes the classification total:
 * anything not explicitly suppressed nests (default-nest), so a newly added
 * `RuntimeEvent` type can't silently leak to the parent timeline.
 */
import type { RuntimeEvent } from "./agent-runtime";
import { deriveToolInputSummary, toSummaryLine } from "./tool-input-summary";

// A sub-agent's own narration, turn lifecycle, usage, compaction, and errors
// must not surface in the parent timeline (parity with the Claude harness, which
// shows only a sub-agent's tool/file activity, not its narration). `error` is
// suppressed because the adapters treat a top-level `error` as terminal for the
// chat turn - a sub-agent's own failure must close only that sub-agent, never
// the parent turn. The set is the UNION across harnesses (e.g. Codex emits
// `turn.started`, OpenCode emits `compaction.started`); listing an event a given
// harness never emits is harmless.
const SUBAGENT_SUPPRESSED_EVENTS: ReadonlySet<RuntimeEvent["type"]> = new Set([
  "text.delta",
  "text.completed",
  "reasoning.delta",
  "reasoning.completed",
  "turn.started",
  "turn.completed",
  "usage.updated",
  "error",
  "todo.updated",
  "compaction.started",
  "compaction.completed",
]);

// A concise progress line for a child's tool/command activity so the card's
// timeline streams (parity with Claude/Codex) instead of sitting on "Starting".
function subagentProgressForChildEvent(event: RuntimeEvent): string | null {
  switch (event.type) {
    case "command.started":
      // Normalize like the tool-arg path (collapse whitespace, cap length) so a
      // multiline or very long command stays a concise one-line progress entry.
      return toSummaryLine(event.command);
    case "tool_call.started": {
      // Mirror the activity row's "tool · arg" detail so the progress timeline
      // shows the key argument (path/pattern/command), not just the tool name.
      const summary = deriveToolInputSummary(event.toolName, event.input);
      return summary === null
        ? event.toolName
        : `${event.toolName} · ${summary}`;
    }
    // NOTE: `tool_call.progress` is deliberately NOT echoed here. It nests onto
    // the child's `tool_call` block as replace-latest (one `progress` field,
    // O(1)); echoing it as a `subagent.progress` line would APPEND one entry to
    // the card's `progressUpdates` per MCP tick (e.g. "Fetched 1/200".."200/200")
    // - an unbounded log, the exact growth replace-latest was designed to avoid.
    default:
      return null;
  }
}

/**
 * Re-homes a single child-session `RuntimeEvent` under its sub-agent card:
 *  - narration / turn lifecycle ({@link SUBAGENT_SUPPRESSED_EVENTS}) -> dropped,
 *  - everything else -> tagged with `parentBlockId` so the GUI nests it. This is
 *    default-nest, NOT default-leak: an unclassified or newly added event type
 *    (interview prompt, a nested sub-agent's card, …) nests rather than silently
 *    surfacing in the parent timeline.
 *  - tool/command activity additionally emits a `subagent.progress` line
 *    (stamped with `timestamp`) so the card streams its recent activity.
 */
export function nestChildRuntimeEvent(
  event: RuntimeEvent,
  parentBlockId: string,
  timestamp: number,
): RuntimeEvent[] {
  if (SUBAGENT_SUPPRESSED_EVENTS.has(event.type)) return [];
  const nested: RuntimeEvent = { ...event, parentBlockId };
  const update = subagentProgressForChildEvent(event);
  if (update === null) return [nested];
  return [
    nested,
    {
      type: "subagent.progress",
      blockId: parentBlockId,
      timestamp,
      update,
    },
  ];
}
