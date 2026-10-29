/**
 * The collapsed label of a turn's activity - "Thought for 12s, read 4 files,
 * ran 2 commands" - as the GUI's activity group heads its rows, and as a host
 * records a bot's settled turn for the receipt under its reply
 * (`bot.turn.locate`). Kept here, shared by both, so the receipt says what
 * the turn's own group says.
 */

import { activityToolKind } from "@traycer/protocol/host/agent/gui/activity-step-label";

/** One step of a turn's activity, as far as its label counts it. */
export type ActivitySummaryStep =
  | {
      readonly kind: "reasoning";
      /** Still streaming: counts as present and nothing more. */
      readonly streaming: boolean;
      /** `null` for a finished block that could not be measured. */
      readonly durationMs: number | null;
    }
  /** `editKey` names the file an edit tool touched, or the call when unknown. */
  | {
      readonly kind: "tool";
      readonly toolName: string;
      readonly editKey: string;
    }
  | { readonly kind: "command" }
  | { readonly kind: "file_change"; readonly filePath: string }
  | { readonly kind: "subagent" }
  | { readonly kind: "approval"; readonly approved: boolean }
  | { readonly kind: "monitor_update" }
  | { readonly kind: "shell_update" };

type Counts = {
  // Summed duration of every finished, measured reasoning block.
  thinkingDurationMs: number;
  // Reasoning at all: a finished block can carry no duration, and without
  // this the label would fall through to "Ran activity".
  thinkingPresent: boolean;
  // At least one block reported a duration: a same-millisecond block (a real
  // measurement, "Thought for 1s") apart from history with none ("Thought").
  thinkingDurationKnown: boolean;
  // A finished block contributed nothing to the sum: it is a floor ("+").
  thinkingDurationPartial: boolean;
  // A block has finished: "thought" never goes back to "thinking".
  thinkingCompleted: boolean;
  exploredFiles: number;
  readFiles: number;
  searched: number;
  editedFiles: Set<string>;
  ranCommands: number;
  ranHooks: number;
  browsed: number;
  spawnedSubagents: number;
  approved: number;
  denied: number;
  usedTools: number;
  monitorUpdates: number;
  shellUpdates: number;
};

/**
 * A whole-second count as a compact clock duration: "Ns" under a minute,
 * "Nm Xs" under an hour, then "Nh Nm Xs".
 */
export function formatClockDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m ${seconds}s`;
}

/**
 * A thinking duration as the label spells it. `Math.max(1, ...)`: a block
 * that started and finished inside the same millisecond has a real duration
 * of 0 and reads "1s", because "0s" describes nothing.
 */
export function thoughtClockDuration(durationMs: number): string {
  return formatClockDuration(Math.max(1, Math.round(durationMs / 1000)));
}

/** The label of a turn's activity, from its steps in order. */
export function activitySummaryOf(
  steps: ReadonlyArray<ActivitySummaryStep>,
): string {
  const counts: Counts = {
    thinkingDurationMs: 0,
    thinkingPresent: false,
    thinkingDurationKnown: false,
    thinkingDurationPartial: false,
    thinkingCompleted: false,
    exploredFiles: 0,
    readFiles: 0,
    searched: 0,
    editedFiles: new Set(),
    ranCommands: 0,
    ranHooks: 0,
    browsed: 0,
    spawnedSubagents: 0,
    approved: 0,
    denied: 0,
    usedTools: 0,
    monitorUpdates: 0,
    shellUpdates: 0,
  };
  steps.forEach((step) => countStep(counts, step));
  const parts = [
    thinkingPhrase(counts),
    countPhrase(counts.exploredFiles, "explored", "file", "files"),
    countPhrase(counts.readFiles, "read", "file", "files"),
    countPhrase(counts.searched, "searched", "place", "places"),
    countPhrase(counts.editedFiles.size, "edited", "file", "files"),
    countPhrase(counts.ranCommands, "ran", "command", "commands"),
    countPhrase(counts.ranHooks, "ran", "hook", "hooks"),
    countPhrase(counts.browsed, "browsed", "page", "pages"),
    countPhrase(counts.spawnedSubagents, "spawned", "subagent", "subagents"),
    countPhrase(counts.approved, "approved", "request", "requests"),
    countPhrase(counts.denied, "denied", "request", "requests"),
    countPhrase(counts.usedTools, "used", "tool", "tools"),
    counts.monitorUpdates > 0
      ? `${counts.monitorUpdates} monitor ${counts.monitorUpdates === 1 ? "update" : "updates"}`
      : null,
    counts.shellUpdates > 0
      ? `${counts.shellUpdates} shell ${counts.shellUpdates === 1 ? "update" : "updates"}`
      : null,
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return "Ran activity";
  const label = parts.join(", ");
  return `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}`;
}

function countStep(counts: Counts, step: ActivitySummaryStep): void {
  switch (step.kind) {
    case "reasoning":
      countReasoning(counts, step.streaming, step.durationMs);
      return;
    case "command":
      counts.ranCommands += 1;
      return;
    case "file_change":
      counts.editedFiles.add(step.filePath);
      return;
    case "subagent":
      counts.spawnedSubagents += 1;
      return;
    case "approval":
      if (step.approved) counts.approved += 1;
      else counts.denied += 1;
      return;
    case "monitor_update":
      counts.monitorUpdates += 1;
      return;
    case "shell_update":
      counts.shellUpdates += 1;
      return;
    case "tool":
      countTool(counts, step.toolName, step.editKey);
      return;
  }
}

function countTool(counts: Counts, toolName: string, editKey: string): void {
  const kind = activityToolKind(toolName);
  if (kind === "explore") counts.exploredFiles += 1;
  else if (kind === "read") counts.readFiles += 1;
  else if (kind === "search") counts.searched += 1;
  else if (kind === "edit") counts.editedFiles.add(editKey);
  else if (kind === "run") counts.ranCommands += 1;
  else if (kind === "hook") counts.ranHooks += 1;
  else if (kind === "browser") counts.browsed += 1;
  else counts.usedTools += 1;
}

/**
 * Reasoning contributes two facts, its presence and its duration. A block
 * still streaming contributes its presence only: the block itself reads
 * "Thinking" and ignores the number, so counting it would let the label say
 * "Thought for 3s" over a child still thinking.
 */
function countReasoning(
  counts: Counts,
  streaming: boolean,
  durationMs: number | null,
): void {
  counts.thinkingPresent = true;
  if (streaming) return;
  counts.thinkingCompleted = true;
  if (durationMs === null) {
    counts.thinkingDurationPartial = true;
    return;
  }
  counts.thinkingDurationKnown = true;
  counts.thinkingDurationMs += durationMs;
}

function countPhrase(
  count: number,
  verb: string,
  singular: string,
  plural: string,
): string | null {
  if (count === 0) return null;
  return `${verb} ${count} ${count === 1 ? singular : plural}`;
}

/**
 * The leading clause of a label with reasoning. Monotone: `thinking` ->
 * `thought` -> `thought for Xs`, never backwards, since none of the flags it
 * reads can clear. Its three branches are a reasoning block's own header in
 * lower case, which is what lets a group of one block drop that header.
 */
function thinkingPhrase(counts: Counts): string | null {
  if (!counts.thinkingPresent) return null;
  if (counts.thinkingDurationKnown) {
    const clause = `thought for ${thoughtClockDuration(counts.thinkingDurationMs)}`;
    // A floor, not a total: some finished block could not be measured.
    return counts.thinkingDurationPartial ? `${clause}+` : clause;
  }
  if (counts.thinkingCompleted) return "thought";
  return "thinking";
}
