/**
 * The Home status board: one row per item agents are tracking, written to the
 * per-user notifications room and read here through `useHomeStatusBoard`.
 *
 * The table is a real `<table>` at the section's own width and folds into the
 * phone layout below `@max-[36rem]` - a CONTAINER query, like the Home rows',
 * so a slim Home tile folds exactly as a phone does. Folded, each `<tr>`
 * becomes a two-column grid: the status dot, then item, note and
 * `agent · time` stacked, with dismiss pinned to the first line.
 *
 * Column widths: Note is the one column that takes the slack (`w-full`).
 * Status and Last update never wrap, and the agent chip truncates, so neither
 * can squeeze it. An Item is sized to its own text up to 14rem (`w-max
 * max-w-56`), which is also its min-content, so a short name stays on one line
 * and only a genuinely long one wraps.
 *
 * Ordering is the board's (needs you, in progress, done; newest first) - this
 * file renders, it does not sort.
 */
import type { ReactNode } from "react";
import { X } from "lucide-react";
import type {
  HomeStatus,
  HomeStatusRow,
} from "@traycer/protocol/notifications/home-status-room";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { normalizeProviderId } from "@/components/home/data/landing-options";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRegisteredEpicAgentActivityTiers } from "@/lib/epic-selectors";
import {
  isHomeStatusRowStaleFor,
  type HomeStatusThresholds,
} from "@/lib/home-focus/home-status-thresholds";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { TraycerMarkdown } from "@/markdown/traycer-markdown";

interface StatusDisplay {
  readonly label: string;
  /** The summary line's phrasing of a count, which agrees with it. */
  readonly summary: (count: number) => string;
  readonly badge: "warning" | "info" | "success";
  readonly dotClass: string;
  readonly textClass: string;
}

// Status roles, not the wireframe's hues: a row waiting on the user is the
// `warning` role (a pending approval is its own example), work under way is
// `info`, and finished work is `success`. Nothing on the board has failed, so
// `destructive` has no row to describe.
const STATUS_DISPLAY: Record<HomeStatus, StatusDisplay> = {
  "needs-you": {
    label: "Needs you",
    summary: (count) => (count === 1 ? "needs you" : "need you"),
    badge: "warning",
    dotClass: "bg-warning",
    textClass: "text-warning-foreground",
  },
  "in-progress": {
    label: "In progress",
    summary: () => "in progress",
    badge: "info",
    dotClass: "bg-info",
    textClass: "text-info-foreground",
  },
  done: {
    label: "Done",
    summary: () => "done",
    badge: "success",
    dotClass: "bg-success",
    textClass: "text-success-foreground",
  },
};

const STATUS_ORDER: ReadonlyArray<HomeStatus> = [
  "needs-you",
  "in-progress",
  "done",
];

// Folded below this container width. Wider than the Home rows' 30rem because
// four columns need more room than one row's single line does.
const FOLDED_ROW =
  "@max-[36rem]:grid @max-[36rem]:grid-cols-[auto_minmax(0,1fr)_auto] @max-[36rem]:gap-x-3 @max-[36rem]:px-1 @max-[36rem]:py-2.5";
const FOLDED_BODY_CELL = "@max-[36rem]:col-start-2 @max-[36rem]:p-0";

export interface HomeStatusTableProps {
  readonly rows: ReadonlyArray<HomeStatusRow>;
  readonly now: number;
  /** When a row reads as stale, per status - this device's setting. */
  readonly thresholds: HomeStatusThresholds;
  readonly onDismiss: (key: string) => void;
  readonly onOpenAgent: (
    epicId: string,
    agentId: string,
    hostId: string | null,
  ) => void;
}

export function HomeStatusTable(props: HomeStatusTableProps): ReactNode {
  const { rows, now, thresholds, onDismiss, onOpenAgent } = props;
  if (rows.length === 0) return null;
  return (
    <section
      aria-labelledby="home-status-heading"
      data-testid="home-status-table"
      className="@container flex flex-col gap-1"
    >
      <div className="flex min-w-0 flex-col gap-0.5 px-3 pt-2 pb-1">
        <h2
          id="home-status-heading"
          className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase"
        >
          Status
        </h2>
        <HomeStatusSummary rows={rows} />
      </div>
      <table className="w-full border-collapse text-left text-ui-sm">
        <thead className="@max-[36rem]:sr-only">
          <tr className="border-b border-border text-ui-xs text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Item
            </th>
            <th scope="col" className="w-full px-3 py-2 font-medium">
              Note
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Last update
            </th>
            <th scope="col" className="w-0 p-0">
              <span className="sr-only">Dismiss</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <HomeStatusTableRow
              key={row.key}
              row={row}
              stale={isHomeStatusRowStaleFor(row, now, thresholds)}
              onDismiss={onDismiss}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** `2 need you · 3 in progress · 2 done`, zero segments omitted. */
function HomeStatusSummary(props: {
  readonly rows: ReadonlyArray<HomeStatusRow>;
}): ReactNode {
  const counts = new Map<HomeStatus, number>();
  for (const row of props.rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const segments = STATUS_ORDER.flatMap((status) => {
    const count = counts.get(status) ?? 0;
    return count === 0 ? [] : [{ status, count }];
  });
  return (
    <p
      data-testid="home-status-summary"
      className="flex flex-wrap items-center gap-x-1 text-ui-xs text-muted-foreground"
    >
      {segments.map((segment, index) => (
        <span key={segment.status} className="flex items-center gap-1">
          {index === 0 ? null : (
            <span aria-hidden className="text-muted-foreground/60">
              ·
            </span>
          )}
          <span
            className={cn(
              "font-medium",
              STATUS_DISPLAY[segment.status].textClass,
            )}
          >
            {segment.count}{" "}
            {STATUS_DISPLAY[segment.status].summary(segment.count)}
          </span>
        </span>
      ))}
    </p>
  );
}

function HomeStatusTableRow(props: {
  readonly row: HomeStatusRow;
  readonly stale: boolean;
  readonly onDismiss: (key: string) => void;
  readonly onOpenAgent: HomeStatusTableProps["onOpenAgent"];
}): ReactNode {
  const { row, stale, onDismiss, onOpenAgent } = props;
  const display = STATUS_DISPLAY[row.status];
  return (
    <tr
      data-testid="home-status-row"
      data-row-key={row.key}
      data-status={row.status}
      data-stale={stale ? "true" : undefined}
      className={cn(
        "border-b border-border align-top transition-colors hover:bg-foreground/3",
        FOLDED_ROW,
        stale && "opacity-60",
      )}
    >
      <td className="px-3 py-2.5 whitespace-nowrap @max-[36rem]:row-span-3 @max-[36rem]:p-0 @max-[36rem]:pt-1.5">
        <Badge
          variant={display.badge}
          className="rounded-full @max-[36rem]:hidden"
          data-testid="home-status-chip"
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", display.dotClass)}
          />
          {display.label}
        </Badge>
        <span
          role="img"
          aria-label={display.label}
          className={cn(
            "hidden size-2 rounded-full @max-[36rem]:block",
            display.dotClass,
          )}
        />
      </td>
      <td
        className={cn(
          "px-3 py-2.5 font-medium break-words text-foreground",
          FOLDED_BODY_CELL,
        )}
        data-testid="home-status-item"
      >
        <span className="block w-max max-w-56 @max-[36rem]:w-auto @max-[36rem]:max-w-none">
          {row.item}
        </span>
      </td>
      <td
        className={cn(
          "w-full min-w-0 px-3 py-2.5 break-words text-muted-foreground",
          FOLDED_BODY_CELL,
          "@max-[36rem]:mt-0.5",
        )}
        data-testid="home-status-note"
      >
        {row.note.length === 0 ? null : (
          <TraycerMarkdown
            className="[&_p]:my-0"
            proseSize="compact"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            quotable={false}
            isStreaming={false}
          >
            {row.note}
          </TraycerMarkdown>
        )}
      </td>
      <td
        className={cn(
          "px-3 py-2.5 whitespace-nowrap",
          FOLDED_BODY_CELL,
          "@max-[36rem]:mt-1",
        )}
      >
        <HomeStatusLastUpdate
          row={row}
          stale={stale}
          onOpenAgent={onOpenAgent}
        />
      </td>
      <td className="py-1.5 pr-1 @max-[36rem]:col-start-3 @max-[36rem]:row-start-1 @max-[36rem]:p-0">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Dismiss ${row.item}`}
          data-testid="home-status-dismiss"
          onClick={() => onDismiss(row.key)}
        >
          <X aria-hidden />
        </Button>
      </td>
    </tr>
  );
}

/**
 * The agent that last wrote the row, as a chip that opens its chat, with a
 * live dot while that agent is mid-turn - then the row's age. Folded, the chip
 * drops its outline and reads as the `agent · time` line.
 */
function HomeStatusLastUpdate(props: {
  readonly row: HomeStatusRow;
  readonly stale: boolean;
  readonly onOpenAgent: HomeStatusTableProps["onOpenAgent"];
}): ReactNode {
  const { row, stale, onOpenAgent } = props;
  const tiers = useRegisteredEpicAgentActivityTiers(row.epicId);
  const live = tiers.get(row.agentId) === "turn";
  const name = row.agentName.trim().length > 0 ? row.agentName : "Agent";
  // The row is user-writable and older hosts write no harness, so an id this
  // build does not know draws no icon rather than a placeholder.
  const harnessId =
    row.harnessId === null ? null : normalizeProviderId(row.harnessId);
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui-xs text-muted-foreground @max-[36rem]:gap-1">
      {/* Capped and truncated: agent titles run long ("Update Home Status
          Board"), and an uncapped chip took the width the note needs. The
          tooltip keeps the whole name reachable. */}
      <TooltipWrapper
        label={name}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          onClick={() => onOpenAgent(row.epicId, row.agentId, row.hostId)}
          data-testid="home-status-agent"
          data-live={live ? "true" : undefined}
          className="inline-flex max-w-48 min-w-0 items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-foreground outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50 @max-[36rem]:border-transparent @max-[36rem]:px-0 @max-[36rem]:text-muted-foreground"
        >
          {harnessId === null ? null : (
            <span
              className="inline-flex shrink-0"
              data-testid="home-status-agent-harness"
              data-harness-id={harnessId}
            >
              <HarnessIcon harnessId={harnessId} className="size-3.5" />
            </span>
          )}
          <span className="truncate" data-testid="home-status-agent-name">
            {name}
          </span>
          {live ? (
            <span
              role="img"
              aria-label="Working now"
              data-testid="home-status-agent-live"
              className="size-1.5 shrink-0 rounded-full bg-success"
            />
          ) : null}
        </button>
      </TooltipWrapper>
      <span aria-hidden className="text-muted-foreground/60">
        ·
      </span>
      <HomeStatusAge updatedAt={row.updatedAt} />
      {stale ? (
        <>
          <span aria-hidden className="text-muted-foreground/60">
            ·
          </span>
          <span data-testid="home-status-stale">stale</span>
        </>
      ) : null}
    </div>
  );
}

/** Its own leaf, so the shared minute tick repaints the label alone. */
function HomeStatusAge(props: { readonly updatedAt: number }): ReactNode {
  const label = useCompactRelativeTime(props.updatedAt);
  return <span data-testid="home-status-age">{label}</span>;
}
