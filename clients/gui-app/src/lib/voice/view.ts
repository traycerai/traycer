import type { CommandItem } from "@/lib/commands/types";
import type { ActionId } from "@/lib/keybindings/actions";

/**
 * What the person sees, as the voice router is shown it (Tracy Bots voice,
 * VT9): the page in front, the agent on it, that agent's approvals and the
 * actions available right now. Composed from what the app already holds at
 * the boundary a route is made; the view is not the focus, which says where
 * posts go.
 */

export type VoicePage =
  | {
      readonly kind: "task";
      readonly title: string;
      /** The active tile of the focused pane; `null` while an overlay holds the keys. */
      readonly tile: string | null;
    }
  | {
      readonly kind: "tracy";
      readonly botId: string | null;
      readonly threadId: string | null;
    }
  | { readonly kind: "home" | "history" | "notifications" }
  | { readonly kind: "settings"; readonly section: string | null };

export interface VoiceViewAgent {
  readonly chatId: string;
  readonly title: string;
  readonly state: "working" | "waiting" | "idle";
  readonly waitingOn: "approval" | null;
}

export interface VoiceViewApproval {
  readonly id: string;
  readonly summary: string;
}

/** One action the page offers; `action` is the id the router copies. */
export interface VoiceViewRow {
  readonly action: string;
  readonly label: string;
  /** The person's words are passed on to it. */
  readonly takesWords: boolean;
  /** Read back before it runs. */
  readonly confirm: boolean;
}

export interface VoiceView {
  readonly page: VoicePage;
  readonly agent: VoiceViewAgent | null;
  readonly approvals: ReadonlyArray<VoiceViewApproval>;
  readonly rows: ReadonlyArray<VoiceViewRow>;
  /** The store's `viewGeneration` this view was read at. */
  readonly generation: number;
}

/** The palette's items by the place each takes in the view's order. */
export interface VoicePaletteItems {
  /** The active task's agents and artifacts, as the opener lists them. */
  readonly tiles: ReadonlyArray<CommandItem>;
  /** Settings sections, offered while Settings is in front. */
  readonly sections: ReadonlyArray<CommandItem>;
  readonly tasks: ReadonlyArray<CommandItem>;
  readonly themes: ReadonlyArray<CommandItem>;
  /** The chord actions and the navigation rows. */
  readonly commands: ReadonlyArray<CommandItem>;
}

export const NO_PALETTE_ITEMS: VoicePaletteItems = {
  tiles: [],
  sections: [],
  tasks: [],
  themes: [],
  commands: [],
};

export interface VoiceViewSources {
  readonly page: VoicePage;
  readonly agent: VoiceViewAgent | null;
  /** The agent's turn is running, so it can be stopped. */
  readonly agentTurnRunning: boolean;
  readonly approvals: ReadonlyArray<VoiceViewApproval>;
  readonly palette: VoicePaletteItems;
  readonly generation: number;
}

/**
 * The probe's views of 19 to 22 rows cost about 250 input tokens over the
 * prompt without them, about 12 a row, so 90 rows cost about 1,100 on a
 * prompt of about 1,650. A task page comes to about 83 at the caps below
 * (6 agent and approval rows, 12 tiles, 12 tasks, 4 theme and navigation rows,
 * 49 chord actions); the cap only cuts a page with many more approvals, from
 * the end of the order.
 */
const MAX_VIEW_ROWS = 90;
/** A task can hold more agents and artifacts than the budget above has room for. */
const MAX_TILE_ROWS = 12;
/** History's recents page is longer than the budget above has room for. */
const MAX_TASK_ROWS = 12;

/** An approval's text reaches the model twice per approval, and agents write long ones. */
const MAX_SUMMARY_CHARS = 120;

/** Registry actions that cannot be undone by another word. */
const CONFIRMED_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>([
  "tab.close",
  "epic.close",
  "tab.close-others",
  "tab.close-right",
  "tab.close-all",
]);

/** An approval's text as the view carries it. */
export function approvalSummary(description: string, toolName: string): string {
  const text = description.trim().length > 0 ? description.trim() : toolName;
  return text.slice(0, MAX_SUMMARY_CHARS);
}

function agentRows(
  agent: VoiceViewAgent,
  turnRunning: boolean,
): ReadonlyArray<VoiceViewRow> {
  const tell: VoiceViewRow = {
    action: `agent.tell:${agent.chatId}`,
    label: `Tell the agent (${agent.title})`,
    takesWords: true,
    confirm: false,
  };
  if (!turnRunning) return [tell];
  return [
    tell,
    {
      action: `agent.stop:${agent.chatId}`,
      label: `Stop the agent's turn (${agent.title})`,
      takesWords: false,
      confirm: true,
    },
  ];
}

function approvalRows(
  approval: VoiceViewApproval,
): ReadonlyArray<VoiceViewRow> {
  return [
    {
      action: `approval.approve:${approval.id}`,
      label: `Approve: ${approval.summary}`,
      takesWords: false,
      confirm: true,
    },
    {
      action: `approval.decline:${approval.id}`,
      label: `Decline: ${approval.summary}`,
      takesWords: false,
      confirm: true,
    },
  ];
}

/** A row the voice can run: a sub-page's entry only opens a picker, and its leaves are rows themselves. */
function runnable(
  items: ReadonlyArray<CommandItem>,
): ReadonlyArray<CommandItem> {
  return items.filter(
    (item) => item.subpage === null && item.disabled !== true,
  );
}

function registryRow(item: CommandItem, label: string): VoiceViewRow {
  return {
    action: item.id,
    label,
    takesWords: false,
    confirm: item.actionId !== null && CONFIRMED_ACTIONS.has(item.actionId),
  };
}

/**
 * The prefix says what a row opens, which the palette says with its sub-page
 * title or its group heading: a bare title sounds like a bot's name, and the
 * word "task" is what tells the two apart when heard.
 */
function prefixedRows(
  items: ReadonlyArray<CommandItem>,
  prefix: string,
): ReadonlyArray<VoiceViewRow> {
  return runnable(items).map((item) =>
    registryRow(item, `${prefix}: ${item.label}`),
  );
}

/** Settings has two sections of one name, told apart by the badge naming their group. */
function sectionRows(
  items: ReadonlyArray<CommandItem>,
): ReadonlyArray<VoiceViewRow> {
  const runnableItems = runnable(items);
  return runnableItems.map((item) => {
    const shared =
      runnableItems.filter((other) => other.label === item.label).length > 1;
    const qualifier =
      shared && item.statusBadge !== undefined ? ` (${item.statusBadge})` : "";
    return registryRow(item, `Settings: ${item.label}${qualifier}`);
  });
}

/**
 * The rows in the router's order: the agent and its approvals first, the
 * task's tiles, the Settings sections while Settings is in front, then the
 * rest, chord actions last.
 */
function composeRows(sources: VoiceViewSources): ReadonlyArray<VoiceViewRow> {
  const { agent, palette } = sources;
  return [
    ...(agent === null ? [] : agentRows(agent, sources.agentTurnRunning)),
    ...sources.approvals.flatMap(approvalRows),
    ...prefixedRows(palette.tiles, "Open tab").slice(0, MAX_TILE_ROWS),
    ...(sources.page.kind === "settings" ? sectionRows(palette.sections) : []),
    ...prefixedRows(palette.tasks, "Open task").slice(0, MAX_TASK_ROWS),
    ...prefixedRows(palette.themes, "Theme"),
    ...runnable(palette.commands).map((item) => registryRow(item, item.label)),
  ].slice(0, MAX_VIEW_ROWS);
}

export function composeVoiceView(sources: VoiceViewSources): VoiceView {
  return {
    page: sources.page,
    agent: sources.agent,
    approvals: sources.approvals,
    rows: composeRows(sources),
    generation: sources.generation,
  };
}
