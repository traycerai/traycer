/**
 * Shared sub-agent nesting/suppression policy for the harness converters (Codex, OpenCode, …).
 * A sub-agent runs in a child session/thread; its events must either nest under the sub-agent card (tagged with the card's `parentBlockId`) or be suppressed - they must NEVER surface un-parented in the parent timeline.
 */
import type { RuntimeEvent } from "./agent-runtime";
import { deriveToolInputSummary, toSummaryLine } from "./tool-input-summary";

// A sub-agent's own narration, turn lifecycle, usage, compaction, and errors must not surface in the parent timeline (parity with the Claude harness, which shows only a sub-agent's tool/file activity, not its narration).
// Codex emits `turn.started`, OpenCode emits `compaction.started`); listing an event a given harness never emits is harmless.
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
    // NOTE: `tool_call.progress` is deliberately NOT echoed here.
    default:
      return null;
  }
}

/**
 * Re-homes a single child-session `RuntimeEvent` under its sub-agent card: - narration / turn lifecycle ({@link SUBAGENT_SUPPRESSED_EVENTS}) -> dropped, - everything else -> tagged with `parentBlockId` so the GUI nests it.
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
