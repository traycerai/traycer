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
 *    raw title when non-empty, else the per-kind literal.
 *    Use it at surfaces that only carry the raw title + kind.
 *
 * 2. **Source-aware fallback** - `epicDisplayTitle` / `chatDisplayTitle` derive
 *    a richer value from a record-specific source (the epic's
 *    `initialUserPrompt`, the chat's first user message) before falling back to
 *    the kind-label. Use them at surfaces that carry that source so an empty
 *    stored title still renders a meaningful label.
 *
 * A Terminal-interface Agent uses the plain `displayTitle(title, "agent")`
 * fallback like any other durable Agent: an untitled one is a "New agent",
 * NOT its harness/provider label. Harness identity is secondary
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
 * What an Agent reads as while it has no title, on every surface and whichever
 * interface it is reached through. A first Send takes seconds to bring a title
 * back, and "Untitled" reads like a fault for all of them.
 *
 * A stored empty title cannot say whether one is on its way: nothing durable
 * records that, and a mark held in one window is absent from a reload, another
 * window or another device. So an Agent whose title never comes (never sent a
 * message, or its title run failed) keeps this label for good.
 */
const NEW_AGENT_TITLE = "New agent";

/**
 * Per-kind "Untitled <kind>" labels, with the three Agent kinds on
 * {@link NEW_AGENT_TITLE}.
 *
 * `agent` is the fallback for surfaces that address the durable **Agent**
 * rather than one of its interfaces. The narrower `chat` / `terminal-agent`
 * keys reach the same label, so a surface holding only a record's kind cannot
 * name a fresh Agent any other way.
 */
const UNTITLED_LABELS: Readonly<Record<DisplayTitleKind, string>> = {
  epic: "Untitled task",
  phase: "Untitled phase",
  agent: NEW_AGENT_TITLE,
  chat: NEW_AGENT_TITLE,
  "terminal-agent": NEW_AGENT_TITLE,
  terminal: "Untitled terminal",
  spec: "Untitled spec",
  ticket: "Untitled ticket",
  story: "Untitled story",
  review: "Untitled review",
  html: "Untitled page",
  canvas: "Untitled canvas",
  file: "Untitled file",
};

/** The fallback the host still writes into notification rows. */
const BAKED_AGENT_FALLBACK = "Untitled agent";

/**
 * Every fallback a saved Agent tile may carry. A tile's `name` is a snapshot, so
 * one saved by an older build still holds that build's spelling.
 */
const AGENT_FALLBACK_NAMES: ReadonlySet<string> = new Set([
  NEW_AGENT_TITLE,
  BAKED_AGENT_FALLBACK,
  "Untitled chat",
  "Untitled terminal agent",
]);

/**
 * Whether a snapshot's name is an Agent's fallback rather than its title, under
 * any spelling a tile may still carry. A record whose stored title literally
 * reads one of these is indistinguishable from it.
 */
export function isAgentFallbackName(name: string): boolean {
  return AGENT_FALLBACK_NAMES.has(name);
}

/**
 * A saved Agent tile's name as it loads: a fallback under any spelling becomes
 * today's. A real title on the record still wins at render.
 */
export function agentTileName(name: string): string {
  return isAgentFallbackName(name) ? untitledLabel("agent") : name;
}

/** User-facing literal for an empty epic title. Single-sourced from the map. */
export const UNTITLED_EPIC_TITLE = UNTITLED_LABELS.epic;

/**
 * The host's own empty-title placeholder. The host synthesizes it into the
 * workspace-context light for an epic that has no title yet, and a since
 * reverted poll wrote it into tab records on some builds.
 */
const HOST_UNTITLED_EPIC_PLACEHOLDER = "Untitled";

/**
 * Whether an epic title is a REAL name - one a user or the title generator
 * chose - rather than the absence of one.
 *
 * Three spellings of absence reach a tab record or a session's title today,
 * and each reads as a name to a plain non-empty check:
 *
 *  - empty after trim;
 *  - `UNTITLED_EPIC_TITLE`, the GUI fallback the create paths bake into a tab
 *    record when the caller had no title;
 *  - the host placeholder above.
 *
 * ONE predicate, because it answers one question in two places that must
 * agree: whether a hidden tab still has metadata worth holding a session for,
 * and whether the title that session just observed ends that hold. Two
 * predicates would let a host-synthesized "Untitled" end a hold the tab's own
 * record says is still needed.
 */
export function isRealEpicTitle(title: string | null | undefined): boolean {
  if (title === null || title === undefined) return false;
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === UNTITLED_EPIC_TITLE) return false;
  return trimmed !== HOST_UNTITLED_EPIC_PLACEHOLDER;
}

/** The "Untitled <kind>" fallback label for a given kind. */
function untitledLabel(kind: DisplayTitleKind): string {
  return UNTITLED_LABELS[kind];
}

/**
 * The title to render for a node: the raw title when non-empty, else the
 * per-kind fallback. Use at surfaces that only have the raw title + kind; prefer
 * the source-aware helpers below where the record's derivation source is
 * available. Under the `agent` kind {@link BAKED_AGENT_FALLBACK} counts as no
 * title, which is how a host-written notification row reaches the current label.
 */
export function displayTitle(title: string, kind: DisplayTitleKind): string {
  if (title.length === 0) return untitledLabel(kind);
  return kind === "agent" && title === BAKED_AGENT_FALLBACK
    ? untitledLabel(kind)
    : title;
}

/**
 * Source-aware epic title: the raw title when non-empty, else a slice of the
 * epic's `initialUserPrompt` (via `createEpicName`) when that yields a
 * non-empty result, else "Untitled task".
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
 * first user message when one is available, else "New agent".
 *
 * `firstUserMessage` is `null` at the light render surfaces (sidebar tree, tab
 * strip) that do not carry chat messages. Those surfaces fall back to
 * "New agent"; surfaces that have messages pass the derived slice.
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
