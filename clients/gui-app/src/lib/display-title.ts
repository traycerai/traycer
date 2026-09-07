/**
 * Empty-title display fallback. Render-only: stores keep the raw title. An untitled agent is "Untitled agent", never its harness label.
 */
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import { createEpicName } from "@/lib/epic-name";

/**
 * Kinds that carry a display title.
 * Superset of `EpicNodeKind` with the two top-level task kinds (`epic`, `phase`) that live outside the node tree, plus the interface-agnostic `agent` kind - all share the same empty-title fallback contract.
 */
export type DisplayTitleKind = EpicNodeKind | "epic" | "phase" | "agent";

/**
 * Per-kind "Untitled <kind>" labels.
 * Note `terminal-agent` renders as "Untitled terminal agent" (spaced, not the hyphenated kind), not `Untitled terminal-agent`.
 */
const UNTITLED_LABELS: Readonly<Record<DisplayTitleKind, string>> = {
  epic: "Untitled task",
  phase: "Untitled phase",
  agent: "Untitled agent",
  chat: "Untitled chat",
  "terminal-agent": "Untitled terminal agent",
  terminal: "Untitled terminal",
  spec: "Untitled spec",
  ticket: "Untitled ticket",
  story: "Untitled story",
  review: "Untitled review",
};

/** User-facing literal for an empty epic title. Single-sourced from the map. */
export const UNTITLED_EPIC_TITLE = UNTITLED_LABELS.epic;

/** The "Untitled <kind>" fallback label for a given kind. */
function untitledLabel(kind: DisplayTitleKind): string {
  return UNTITLED_LABELS[kind];
}

/**
 * The title to render for a node: the raw title when non-empty, else the per-kind "Untitled <kind>" fallback.
 * Use at surfaces that only have the raw title + kind; prefer the source-aware helpers below where the record's derivation source is available.
 */
export function displayTitle(title: string, kind: DisplayTitleKind): string {
  return title.length > 0 ? title : untitledLabel(kind);
}

/**
 * Source-aware epic title: the raw title when non-empty, else a slice of the epic's `initialUserPrompt` (via `createEpicName`) when that yields a non-empty result, else "Untitled task".
 */
export function epicDisplayTitle(epic: {
  readonly title: string;
  readonly initialUserPrompt: string;
}): string {
  if (epic.title.length > 0) return epic.title;
  const derived = createEpicName(epic.initialUserPrompt);
  return derived.length > 0 ? derived : untitledLabel("epic");
}

/**
 * Source-aware chat title: the raw title when non-empty, else a slice of the first user message when one is available, else "Untitled chat".
 */
export function chatDisplayTitle(chat: {
  readonly title: string;
  readonly firstUserMessage: string | null;
}): string {
  if (chat.title.length > 0) return chat.title;
  if (chat.firstUserMessage !== null && chat.firstUserMessage.length > 0) {
    return chat.firstUserMessage;
  }
  return untitledLabel("chat");
}
