/**
 * Single source of the empty-title display fallback for every titled node the
 * GUI renders (epics, phases, chats, terminal agents, and artifact kinds).
 *
 * A node created from the landing composer (or any not-yet-titled record) is
 * stored with an empty title (`""`) - the structural "no title yet" state -
 * and the title is later generated from the first prompt. Until then (and
 * forever, for a never-prompted node) every surface that renders a title must
 * fall back to something meaningful so no tab / list row / breadcrumb / mention
 * ever shows a blank label.
 *
 * Two fallback tiers:
 *
 * 1. **Plain kind-label fallback** - `displayTitle(title, kind)` returns the
 *    raw title when non-empty, else the per-kind `"Untitled <kind>"` literal.
 *    Use it at surfaces that only carry the raw title + kind.
 *
 * 2. **Source-aware fallback** - `epicDisplayTitle` / `chatDisplayTitle` derive
 *    a richer value from a record-specific source (the epic's
 *    `initialUserPrompt`, the chat's first user message) before falling back to
 *    the kind-label. Use them at surfaces that carry that source so an empty
 *    stored title still renders a meaningful label.
 *
 * A Terminal-interface Agent uses the plain `displayTitle(title, "agent")`
 * fallback like any other durable Agent: an untitled one is an "Untitled
 * agent", NOT its harness/provider label. Harness identity is secondary
 * interface metadata (rendered as a badge where a surface exposes it via
 * `TUI_AGENT_HARNESS_LABELS`), never the Agent's title fallback.
 *
 * RENDER-ONLY: apply these helpers where the string is rendered. Data, action,
 * and store fields must carry the RAW title. The exception is the small set of
 * surfaces that bake the fallback into data (e.g. phase list items, the epic
 * tab name) - those still source the literal from `UNTITLED_LABELS` here so the
 * strings stay single-sourced.
 */
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import { createEpicName } from "@/lib/epic-name";

/**
 * Kinds that carry a display title. Superset of `EpicNodeKind` with the two
 * top-level task kinds (`epic`, `phase`) that live outside the node tree, plus
 * the interface-agnostic `agent` kind - all share the same empty-title fallback
 * contract.
 */
export type DisplayTitleKind = EpicNodeKind | "epic" | "phase" | "agent";

/**
 * Per-kind "Untitled <kind>" labels. Note `terminal-agent` renders as
 * "Untitled terminal agent" (spaced, not the hyphenated kind), not
 * `Untitled terminal-agent`.
 *
 * `agent` is the fallback for surfaces that address the durable **Agent**
 * rather than one of its interfaces - an untitled Agent is an "Untitled agent"
 * whether it is interacted with through Chat or Terminal. The narrower
 * `chat` / `terminal-agent` literals remain for interface-specific surfaces and
 * for historical titles: a record whose stored title literally reads
 * "Untitled chat" keeps that text, because the system cannot tell a synthetic
 * fallback baked into data apart from a title a user chose.
 */
const UNTITLED_LABELS: Readonly<Record<DisplayTitleKind, string>> = {
  epic: "Untitled epic",
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

/** Host-aligned literal for an empty epic title. Single-sourced from the map. */
export const UNTITLED_EPIC_TITLE = UNTITLED_LABELS.epic;

/** The "Untitled <kind>" fallback label for a given kind. */
function untitledLabel(kind: DisplayTitleKind): string {
  return UNTITLED_LABELS[kind];
}

/**
 * The title to render for a node: the raw title when non-empty, else the
 * per-kind "Untitled <kind>" fallback. Use at surfaces that only have the raw
 * title + kind; prefer the source-aware helpers below where the record's
 * derivation source is available.
 */
export function displayTitle(title: string, kind: DisplayTitleKind): string {
  return title.length > 0 ? title : untitledLabel(kind);
}

/**
 * Source-aware epic title: the raw title when non-empty, else a slice of the
 * epic's `initialUserPrompt` (via `createEpicName`) when that yields a
 * non-empty result, else "Untitled epic".
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
 * Source-aware chat title: the raw title when non-empty, else a slice of the
 * first user message when one is available, else "Untitled chat".
 *
 * `firstUserMessage` is `null` at the light render surfaces (sidebar tree, tab
 * strip) that do not carry chat messages. Those surfaces fall back to
 * "Untitled chat"; surfaces that have messages pass the derived slice.
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
