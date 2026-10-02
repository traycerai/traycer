import type { ReactNode } from "react";
import type { EpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { cn } from "@/lib/utils";
import {
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  type NotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";
import type { SideTabLiveAgents } from "./agent-meter";
import type { SideRowSection, SideTabRowStatus } from "./side-tab-row";
import { sideTabStatusOf } from "./side-tab-status";
import { SideTabStatusGlyph } from "./side-tab-status-glyph";
import { StripElapsedTime } from "./strip-elapsed-time";
import { NeedsYouDetail, ToReviewDetail } from "./strip-section-detail";
import {
  needsYouRowOf,
  type NeedsYouRow,
  type StripTaskRow,
  type ToReviewRow,
} from "./strip-sections";
import type { StripTaskGroup } from "./strip-task-group";

/**
 * The Needs you line a task's row draws: its requests, less those its expanded
 * agents below say themselves, or `null` when they say them all.
 */
export function needsYouLineOf(
  row: NeedsYouRow,
  group: StripTaskGroup | null,
): NeedsYouRow | null {
  const undrawn = group?.undrawnNeedsYou ?? null;
  if (undrawn === null) return row;
  return undrawn.length === 0 ? null : needsYouRowOf(undrawn, row.reason);
}

/**
 * How a section styles a row: a Needs you or To review row is a two-line row
 * with a bold title, a Working row one line of normal weight, an Idle row one
 * line of muted text. An expanded Needs you row whose agents below say every
 * request is one line too. A split pair's half keeps the weight and draws no
 * second line: its pair's row carries that.
 */
export function sectionStyleOf(
  row: StripTaskRow,
  half: boolean,
  group: StripTaskGroup | null,
): SideRowSection {
  switch (row.section) {
    case "needs-you": {
      const line = half ? null : needsYouLineOf(row, group);
      return {
        title: "strong",
        detail: line === null ? null : <NeedsYouDetail row={line} />,
      };
    }
    case "to-review":
      return {
        title: "strong",
        detail: half ? null : <ToReviewDetail row={row} />,
      };
    case "working":
      return { title: "normal", detail: null };
    case "idle":
      return { title: "muted", detail: null };
  }
}

/** The row when it is a two-line one (Needs you, To review), else `null`. */
export function twoLineRowOf(
  row: StripTaskRow | null,
): NeedsYouRow | ToReviewRow | null {
  return row?.section === "needs-you" || row?.section === "to-review"
    ? row
    : null;
}

/**
 * The trailing status of a two-line row: the time since the request or the
 * finish, after the pending fork's glyph when the task has one. It stays when
 * the row is hovered, and the close joins after it. `null` when there is
 * nothing to show (a Needs you row with no loaded prompt has no wait).
 */
export function twoLineStatusOf(
  row: NeedsYouRow | ToReviewRow,
  forkGlyph: ReactNode | null,
): SideTabRowStatus | null {
  const since = row.section === "needs-you" ? row.createdAt : row.at;
  if (since === null && forkGlyph === null) return null;
  return {
    yieldsToClose: false,
    node: (
      <span className="flex items-center gap-1.5">
        {forkGlyph}
        {since === null ? null : (
          <StripElapsedTime
            since={since}
            className={cn(
              "text-ui-xs tabular-nums",
              row.section === "needs-you"
                ? "text-warning-foreground/70"
                : "text-muted-foreground",
            )}
            testId="side-tab-section-time"
          />
        )}
      </span>
    ),
  };
}

/**
 * A task row's one trailing status. In the Activity view (`row` set) a Needs
 * you or To review row says what a chip would on its second line, so its
 * trailing edge is the time, and a pending fork keeps its glyph; a Working or
 * Idle row draws the glyph or the meter, and the meter yields to the close
 * as a glyph does. The Layered view (`row` null) draws the chip, meter or
 * glyph of the flush-title row. A split pair's half has room for its compact
 * glyph alone (the spinner, the needs-you dot, the done check, the failed
 * glyph); a chip's words are its card's and its pair's second line's.
 */
export function taskStatusOf(input: {
  readonly row: StripTaskRow | null;
  readonly tabId: string;
  readonly indicator: NotificationIndicatorState;
  readonly agents: SideTabLiveAgents;
  readonly activityStatus: EpicActivityStatus;
  readonly titleGenerating: boolean;
  /** The task's nested agents are showing, so they carry what the meter would. */
  readonly meterHidden: boolean;
  /** The agents nested under the row; their waiting rows hold their own waits. */
  readonly group: StripTaskGroup | null;
  readonly half: boolean;
}): SideTabRowStatus | null {
  const { row, tabId, indicator } = input;
  const glyph = (
    <SideTabStatusGlyph
      tabId={tabId}
      indicatorState={indicator}
      activityStatus={input.activityStatus}
      titleGenerating={input.titleGenerating}
    />
  );
  if (input.half) return { yieldsToClose: true, node: glyph };
  const twoLine = twoLineRowOf(row);
  if (twoLine !== null) {
    return twoLineStatusOf(
      twoLine.section === "needs-you"
        ? // The oldest request no agent row below holds; none when they hold all.
          (needsYouLineOf(twoLine, input.group) ?? {
            ...twoLine,
            createdAt: null,
          })
        : twoLine,
      indicator.pendingFork ? (
        <SideTabStatusGlyph
          tabId={tabId}
          indicatorState={{
            ...EMPTY_NOTIFICATION_INDICATOR_STATE,
            pendingFork: true,
          }}
          activityStatus="idle"
          titleGenerating={false}
        />
      ) : null,
    );
  }
  return sideTabStatusOf({
    indicator,
    agents: input.agents,
    meterHidden: input.meterHidden,
    meterYields: row !== null,
    glyph,
  });
}
