import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { Badge } from "@/components/ui/badge";
import { HoverCard } from "@/components/ui/hover-card";
import {
  formatUnreadCount,
  labelWithUnreadCount,
} from "@/lib/notifications/unread-count";
import { cn } from "@/lib/utils";
import { TabChrome } from "./header-tab-visual";
import { useSurfaceJoinPane } from "./surface-join-pane";
import { headerTabClassName } from "./tab-chrome-tokens";
import type { TracyStripEntry } from "./tab-strip-controller";
import { StripElapsedTime } from "./side-strip/strip-elapsed-time";
import { SIDE_STRIP_NAV_TILE_COUNT_CLASS } from "./side-strip/side-strip-tokens";
import {
  useTracyEntrySignals,
  type TracyEntrySignals,
} from "./use-tracy-entry-signals";

/**
 * The entry's name in every placement: the fixed place is Tracy's whatever
 * the bot it opens is called, so a rename or a new main bot never moves it.
 */
export const TRACY_ENTRY_LABEL = "Tracy";

/**
 * The entry's glyph, in every strip placement, wearing the bot's unread count
 * on its top-right corner; the bare glyph at zero, and where the host does
 * not count.
 */
export function TracyEntryIcon(props: {
  readonly className: string | undefined;
  readonly unreadCount: number | null;
}): ReactNode {
  const { className, unreadCount } = props;
  if (unreadCount === null || unreadCount <= 0) {
    return (
      <Bot
        className={cn("size-4 shrink-0", className)}
        aria-hidden="true"
        data-testid="tracy-entry-icon"
      />
    );
  }
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <Bot
        className="size-4 shrink-0"
        aria-hidden="true"
        data-testid="tracy-entry-icon"
      />
      <Badge
        variant="destructive"
        size="xs"
        aria-hidden
        data-testid="tracy-entry-unread-count"
        className={cn(
          SIDE_STRIP_NAV_TILE_COUNT_CLASS,
          "translate-x-1/2 -translate-y-1/2 tabular-nums",
        )}
      >
        {formatUnreadCount(unreadCount)}
      </Badge>
    </span>
  );
}

/**
 * The hover card's body: the bot by its name, and what it is doing while it
 * works, or "Idle" when it is known to be; nothing when its state is not
 * known.
 */
export function TracyEntryHoverBody(props: {
  readonly title: string;
  readonly signals: TracyEntrySignals;
}): ReactNode {
  const { title, signals } = props;
  return (
    <div data-testid="tracy-entry-hover-body" className="flex flex-col gap-1">
      <div className="text-ui-sm font-medium text-foreground">{title}</div>
      {signals.working || signals.idle ? (
        <div className="text-muted-foreground">
          {signals.working ? (signals.step ?? "Replying…") : "Idle"}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The fixed Tracy entry at the strip's leading edge, after Home and outside
 * the scrolling tabs: the Tracy glyph with the bot's unread count and
 * "Tracy", bold while unread, and how
 * long the bot has been working while it runs a turn; the hover names the
 * bot. Like Home it has no drag,
 * no close, no menu and no Alt-digit; unlike Home it is a real tab, so it
 * joins the sheet when selected.
 */
export function TracyStripSlot(props: {
  readonly entry: TracyStripEntry;
}): ReactNode {
  const { tab, isActive, onActivate } = props.entry;
  const signals = useTracyEntrySignals(tab.id);
  const dragging = useEpicDndStore((state) => state.activeHeaderTab !== null);
  const joined = useSurfaceJoinPane(
    isActive && !dragging ? { kind: tab.kind, id: tab.id } : null,
    "top",
  );
  return (
    <HoverCard
      trigger={
        <button
          type="button"
          role="tab"
          aria-selected={isActive}
          aria-label={labelWithUnreadCount(
            TRACY_ENTRY_LABEL,
            signals.unreadCount,
          )}
          data-testid="tab-tracy"
          data-tab-kind="tracy"
          data-unread={signals.unread ? "" : undefined}
          onClick={onActivate}
          className={cn(
            headerTabClassName("own", isActive),
            "w-auto max-w-[min(40vw,12rem)] shrink-0 cursor-pointer gap-1.5 [-webkit-app-region:no-drag]",
          )}
        >
          <TabChrome
            isActive={isActive}
            joined={joined}
            concealed={false}
            color={null}
            session={false}
          />
          <TracyEntryIcon
            className="relative z-20"
            unreadCount={signals.unreadCount}
          />
          <span
            className={cn(
              "relative z-20 min-w-0 truncate",
              signals.unread && "font-semibold text-foreground",
            )}
          >
            {TRACY_ENTRY_LABEL}
          </span>
          {signals.workingSince === null ? null : (
            <StripElapsedTime
              since={signals.workingSince}
              testId="tab-tracy-working"
              className="relative z-20 shrink-0 text-ui-xs text-muted-foreground tabular-nums"
            />
          )}
        </button>
      }
      content={<TracyEntryHoverBody title={tab.name} signals={signals} />}
      appearance="preview"
      semantics={{ role: "tooltip" }}
      side="bottom"
      align="center"
      sideOffset={4}
      enabled
      open={null}
      onOpenChange={null}
      testId="tracy-entry-hover-card"
      className="w-[min(90vw,18rem)] p-3 text-ui-xs"
    />
  );
}
