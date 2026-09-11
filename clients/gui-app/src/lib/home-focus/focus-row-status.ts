import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";

/**
 * The one vocabulary every Home row answers "what is this doing" in.
 *
 * Home's whole job is letting someone see what is running, what is blocking and
 * what is merely waiting without reading the page. That only works if the
 * answer lives in the same column, in the same words, on every row - so the
 * state is a closed union resolved here rather than a sentence each row shape
 * composes for itself.
 *
 * `turn` and `running` are deliberately two states rather than one word: an
 * agent taking a turn is work the USER is waiting on, a durable shell is work
 * that will still be there tomorrow, and the page is read by someone deciding
 * which of those needs them.
 */
export type FocusRowState =
  | "needs-you"
  | "turn"
  | "running"
  | "held"
  | "background"
  | "waiting";

export interface FocusRowStateStyle {
  readonly word: string;
  /** The dot's fill. Solid for work in flight, a ring for work that is merely
   * present, so the column reads at a glance before any word is. */
  readonly dotClassName: string;
  /** The word's own colour. Muted for everything except the one state that is
   * asking for something - a column of coloured words is a column nobody
   * scans. */
  readonly wordClassName: string;
}

export const FOCUS_ROW_STATES: Readonly<
  Record<FocusRowState, FocusRowStateStyle>
> = {
  "needs-you": {
    word: "needs you",
    dotClassName: "bg-warning-foreground",
    wordClassName: "text-warning-foreground",
  },
  turn: {
    word: "turn",
    dotClassName: "bg-primary",
    wordClassName: "text-muted-foreground",
  },
  running: {
    word: "running",
    dotClassName: "bg-primary",
    wordClassName: "text-muted-foreground",
  },
  /**
   * RESERVED, and deliberately unreachable today.
   *
   * A shell whose output the user has not taken delivery of is a real state the
   * chat's Background panel already knows about, and the design named it - but
   * no field on `FocusBackgroundRow` carries it, and inventing a source for it
   * is new data this change does not add. The slot exists so the registry IS
   * the vocabulary rather than a subset of it: whoever plumbs the held flag
   * adds a field and a call, not a colour decision.
   */
  held: {
    word: "held",
    dotClassName: "bg-destructive",
    wordClassName: "text-muted-foreground",
  },
  background: {
    word: "background",
    dotClassName: "border border-muted-foreground bg-transparent",
    wordClassName: "text-muted-foreground",
  },
  waiting: {
    word: "waiting",
    dotClassName: "border border-muted-foreground bg-transparent",
    wordClassName: "text-muted-foreground",
  },
};

/** An agent's tier IS its state - the two unions line up one to one, which is
 * why no row maps it by hand. */
export function focusAgentState(agent: FocusAgentRow): FocusRowState {
  return agent.tier === "turn" ? "turn" : "background";
}

/**
 * A job's state. Every row the background builder emits is running by
 * construction: managed commands are filtered to `running` before they reach
 * it, and background items are filtered to running non-wakeup roots. The
 * registry's `held` slot is therefore unreachable from here until a row carries
 * the flag - see its entry in {@link FOCUS_ROW_STATES}.
 */
export function focusJobState(_row: FocusBackgroundRow): FocusRowState {
  return "running";
}

/**
 * A task's own state, rolled up from the agents that are actually its own.
 *
 * Attention wins over everything: a task with a pending prompt is the reason
 * someone opened this page. Below that, a task is a `turn` while any agent is
 * mid-turn, `background` while its work is only durable, and `waiting` when it
 * has no agent of its own at all - the epic that is here for its background
 * jobs and nothing else.
 */
export function focusTaskState(
  task: FocusTaskRow | null,
  promptCount: number,
): FocusRowState {
  if (promptCount > 0 || task?.needsYou === true) return "needs-you";
  if (task === null) return "waiting";
  if (task.agents.some((agent) => agent.tier === "turn")) return "turn";
  return task.agents.length === 0 ? "waiting" : "background";
}
