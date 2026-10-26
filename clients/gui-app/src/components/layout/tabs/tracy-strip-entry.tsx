import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { HoverCard } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { TabChrome } from "./header-tab-visual";
import { useSurfaceJoinPane } from "./surface-join-pane";
import { headerTabClassName } from "./tab-chrome-tokens";
import type { TracyStripEntry } from "./tab-strip-controller";
import { StripElapsedTime } from "./side-strip/strip-elapsed-time";
import {
  useTracyEntrySignals,
  type TracyEntrySignals,
} from "./use-tracy-entry-signals";

/**
 * The entry's name in every placement: the fixed place is Tracy's whatever
 * the bot it opens is called, so a rename or a new main bot never moves it.
 */
export const TRACY_ENTRY_LABEL = "Tracy";

/** The entry's glyph, in every strip placement. */
export function TracyEntryIcon(props: {
  readonly className: string | undefined;
}): ReactNode {
  return (
    <Bot
      className={cn("size-4 shrink-0", props.className)}
      aria-hidden="true"
      data-testid="tracy-entry-icon"
    />
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
 * the scrolling tabs: the Tracy glyph and "Tracy", bold while unread, and how
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
          <TracyEntryIcon className="relative z-20" />
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
