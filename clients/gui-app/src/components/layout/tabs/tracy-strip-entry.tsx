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

/** The hover card's body: the bot, and what it is doing while it works. */
export function TracyEntryHoverBody(props: {
  readonly title: string;
  readonly signals: TracyEntrySignals;
}): ReactNode {
  const { title, signals } = props;
  const working = signals.workingSince !== null;
  return (
    <div data-testid="tracy-entry-hover-body" className="flex flex-col gap-1">
      <div className="text-ui-sm font-medium text-foreground">{title}</div>
      <div className="text-muted-foreground">
        {working ? (signals.step ?? "Replying…") : "Idle"}
      </div>
    </div>
  );
}

/**
 * The fixed Tracy entry at the strip's leading edge, after Home and outside
 * the scrolling tabs: the bot's picture and name, bold while unread, and how
 * long it has been working while it runs a turn. Like Home it has no drag,
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
          <Bot className="relative z-20 size-4 shrink-0" aria-hidden />
          <span
            className={cn(
              "relative z-20 min-w-0 truncate",
              signals.unread && "font-semibold text-foreground",
            )}
          >
            {tab.name}
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
