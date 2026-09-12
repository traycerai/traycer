/**
 * The grammar every Home row is built from, in one place so every row reads the
 * same way.
 *
 * `[kind icon] [item name] [· in <context>] … [status] [actions]`
 *
 * The item name is what the row IS - the prompt's text, the agent's name, the
 * job's name. Everything after it is CONTEXT: where that thing lives. They are
 * separate nodes in separate tones, never one string, because the defect that
 * produced this module was a row reading `General Conversation History 10min
 * heartbeat` - a task and a monitor with a space between them and nothing to
 * say which was which.
 *
 * The status cell is the other half of the same idea: one column, one
 * vocabulary, on every row, so "what is running, what is blocking, what is
 * waiting" is answered by scanning rather than by reading.
 */
import type { ReactNode } from "react";
import {
  ROW_ACTIONS_CELL_CLASS,
  ROW_META_CLASS,
  ROW_STATUS_CELL_CLASS,
} from "@/components/home-focus/home-focus-row-style";
import {
  FOCUS_ROW_STATES,
  type FocusRowState,
} from "@/lib/home-focus/focus-row-status";
import { formatCompactRelativeTime, useSampledNow } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * What the row is. Truncates on its own rather than letting the context trail
 * decide - the name is the part a reader needs whole, so it holds its width
 * first and the context gives way.
 *
 * `@max-[30rem]:flex-1` is the folded row's whole point: once the badges and
 * the status have moved to their own line, the only things left beside the name
 * are the twisty and one icon, and the name should take everything they do not.
 * At wide width it keeps `shrink-[2]`, where the chip row is the item that
 * grows.
 *
 * `min-w-3/5` is not belt-and-braces - without it the variant above inverts the
 * priority it exists to enforce. `flex-1` is `flex: 1 1 0%`, so the name's
 * PREFERRED size is zero and it only ever grows out of leftover space. Its
 * siblings keep an automatic basis - the chat row's `via …`, the prompt and job
 * rows' `RowContext` - so a context longer than the line leaves no free space
 * at all, the grow factor has nothing to act on, and the name renders at 0px
 * with its context fully visible beside it. That is strictly worse than the
 * four-character truncation the fold exists to prevent. The floor is a
 * PERCENTAGE, per the fluid-sizing rule, and it is 60% because that is the
 * share a level-two name keeps elsewhere.
 */
export function RowItemName(props: {
  readonly children: ReactNode;
  readonly testId: string;
}): ReactNode {
  return (
    <span
      className="min-w-0 shrink-[2] truncate text-foreground @max-[30rem]:min-w-3/5 @max-[30rem]:flex-1"
      data-testid={props.testId}
    >
      {props.children}
    </span>
  );
}

/**
 * A row's badges and status cell, which are cells of the row itself on a wide
 * one and a second line under the name on a narrow one.
 *
 * Every row shape wraps its status in this, including the shapes with no badges
 * at all: the fold is a property of the ROW, and a prompt row whose status
 * stayed inline while the task row above it folded would be the staircase the
 * status column exists to prevent, one width down.
 *
 * See {@link ROW_META_CLASS} for why the wide case is `display: contents` - the
 * short version is that the wrapper has to be invisible to layout there, or
 * this is a rewrite of the desktop row rather than an addition to it.
 */
export function RowMetaLine(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className={ROW_META_CLASS} data-testid="home-focus-row-meta">
      {props.children}
    </div>
  );
}

/** One slot of a row's context trail, keyed by the ROLE it fills rather than by
 * the name in it: a chat and its task can be called the same thing, and they
 * are still two different objects that both have to render. */
export interface RowContextPart {
  readonly role: "chat" | "task" | "browser-tab";
  readonly title: string | null;
  /**
   * Whether this part names WHERE the row's subject lives, and so reads
   * `in <name>`.
   *
   * Per part rather than "the first one gets it", which is what this replaces.
   * The two happened to coincide for a job - `in <chat> · <task>` - and came
   * apart the moment a browser prompt needed `· <tab> · in <task>`: the tab is
   * not somewhere the prompt lives, it is the thing the prompt is ABOUT, and
   * the task after it still is a location. A positional rule cannot express
   * that, and quietly produced `in Checkout · Storefront` - which reads as the
   * prompt being inside a page inside nothing.
   */
  readonly preposition: "in" | null;
}

/**
 * What surrounds the row's subject: `· in <chat> · <task>`, muted, each part
 * truncating on its own.
 *
 * `in` is a real word rather than another separator because two adjacent names
 * with a dot between them is exactly what read as one name. Which parts carry
 * it is each caller's answer ({@link RowContextPart.preposition}), not this
 * component's. The leading `·` is `aria-hidden`: it separates for the eye, and
 * a reader hears "Ten minute heartbeat, in Greeting and Introduction".
 */
export function RowContext(props: {
  /** Nearest first - the conversation before the task, because the nearer one
   * is what a reader needs to find the thing again. `null` titles are the parts
   * this window cannot name and are dropped rather than guessed. */
  readonly parts: ReadonlyArray<RowContextPart>;
  readonly testId: string;
}): ReactNode {
  const parts = props.parts.filter((part) => part.title !== null);
  if (parts.length === 0) return null;
  return (
    <span
      className="flex min-w-0 shrink items-center gap-1 text-muted-foreground"
      data-testid={props.testId}
    >
      {parts.map((part) => (
        <span key={part.role} className="flex min-w-0 items-center gap-1">
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <span className="min-w-0 truncate" data-role={part.role}>
            {part.preposition === null
              ? part.title
              : `${part.preposition} ${part.title}`}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * The row's state, in a FIXED track so it is the same column on every row of a
 * section regardless of what the rows either side of it carry.
 *
 * `tabular-nums` keeps a ticking duration from jittering its own width as the
 * digits change; it is not what holds the word still - the track and the left
 * alignment below are. The detail is a separate node so the tick repaints it
 * alone, without the word beside it.
 */
export function RowStatus(props: {
  readonly state: FocusRowState;
  /**
   * Rendered after the word as `· <detail>`, and `null` wherever the model has
   * nothing to add - agents have no start timestamp on the activity plane, and
   * inventing one is the kind of confident guess this page exists to stop
   * making.
   *
   * A slot rather than a duration: how long a thing has been running is the
   * commonest answer ({@link RowStatusDuration}), but a browser tab's is who is
   * driving it ({@link RowStatusNote}), and both belong in the same place after
   * the same word for the column to stay one column.
   */
  readonly detail: ReactNode;
}): ReactNode {
  const style = FOCUS_ROW_STATES[props.state];
  return (
    <span
      className={cn(
        // `justify-start` inside a fixed track, which is what actually freezes
        // the dot and the word. Right-aligning the cell's CONTENT only pins its
        // right edge, so a row with `· 41m` pushes its word left of a row with
        // none and the column reads as ragged as it did before the track
        // existed - `tabular-nums` cannot help, since the widths differing are
        // the duration's PRESENCE and its unit letters, not its digits. Left
        // alignment puts dot and word at one x for every row and lets the
        // duration trail into the slack, which is the part that may vary.
        "flex items-center justify-start gap-1.5 text-ui-xs tabular-nums",
        ROW_STATUS_CELL_CLASS,
      )}
      data-testid="home-focus-row-status"
      data-state={props.state}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", style.dotClassName)}
        data-testid="home-focus-row-status-dot"
      />
      <span className={cn("truncate", style.wordClassName)}>{style.word}</span>
      {props.detail}
    </span>
  );
}

/**
 * The `· driven by Reviewer` half of a status cell: a fixed fact rather than a
 * ticking one.
 *
 * Truncates rather than hiding on a narrow row, exactly as
 * {@link RowStatusDuration} does - but holds no clock, because nothing about it
 * changes between frames.
 */
export function RowStatusNote(props: { readonly text: string }): ReactNode {
  return (
    <span
      className="min-w-0 truncate text-muted-foreground"
      data-testid="home-focus-row-status-note"
    >
      · {props.text}
    </span>
  );
}

/**
 * The row's trailing control track, reserved even when the row has no control.
 *
 * Unlike the status cell beside it, this one is positioned: a control has to be
 * clickable in its own right, while the status is text the row is happy to have
 * the body button's overlay swallow.
 *
 * An empty cell rather than no cell, because the point of the track is that
 * every row spends the same width on actions: a prompt row with nothing to stop
 * has to hold the space a `Stop all` takes two rows below it, or the status
 * column above it moves. Below `@max-[30rem]` there is no column to hold still
 * - the status has folded onto its own line - so the track collapses to its
 * content and an empty cell costs nothing.
 *
 * `relative` lifts it above the body button's stretched hit area so its own
 * clicks land on it - an invariant with two directions. The overlay is an
 * absolutely positioned box belonging to the body button, so it stretches
 * across the WHOLE row and paints in step 8 of the painting order along with
 * every other `z-index: auto` positioned box, in tree order:
 *
 * - AFTER the body button (here, and `AgentChip`): the control is later in tree
 *   order, so bare `relative` puts it above the overlay.
 * - BEFORE the body button (the Tasks view's disclosure twisty): the overlay
 *   belongs to a LATER sibling and paints last, so `relative` ties and loses.
 *   Such a control needs a real `z-10`, the same way `epics-list-panel`'s row
 *   content sits over its own stretched link.
 *
 * A control with no position at all paints in step 7 and is under the overlay
 * from either side. Every control in a row belongs here, or in a positioned
 * wrapper of its own, or - if it leads the row - carries `z-10`.
 */
export function RowActionsCell(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className={cn(
        "relative flex items-center justify-end gap-1.5",
        ROW_ACTIONS_CELL_CLASS,
      )}
      data-testid="home-focus-row-actions"
    >
      {props.children}
    </div>
  );
}

/**
 * The `· 5h` half of a status cell, on the app's shared 60s clock.
 *
 * Its own leaf for the same reason `NotificationTimestamp` is one: the tick
 * repaints this label and not the row around it.
 *
 * It is never dropped at any width: the row spends the same status track on
 * every row of every shape, so the duration has room the section has already
 * reserved for it.
 */
export function RowStatusDuration(props: {
  readonly startedAtMs: number;
}): ReactNode {
  const now = useSampledNow();
  const elapsed = formatCompactRelativeTime(props.startedAtMs, now);
  return (
    <span
      className="shrink-0 text-muted-foreground"
      data-testid="home-focus-row-status-duration"
    >
      · {elapsed === "now" ? "just now" : elapsed}
    </span>
  );
}
