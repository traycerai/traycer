import { useMemo, useState, type ReactNode } from "react";
import {
  BotChannelSidebar,
  type BotThreadsViewState,
} from "@/components/bots/bot-channel-sidebar";
import { BotResizablePane } from "@/components/bots/bot-resizable-pane";
import {
  MobileLevel2Column,
  MobileLevel2MenuContent,
  MobileLevel2MenuTrigger,
} from "@/components/layout/shell/mobile-level2";
import { Popover } from "@/components/ui/popover";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";

function stayOpen(): void {}

/**
 * The bots list beside a bot tab's channel. In the installed app it is the
 * column at the resolver's width, or nothing where the form has no column.
 * `level2` is `null` everywhere else, where the tab's own container decides and
 * the person drags the width.
 */
export function BotChannelColumn(props: {
  readonly level2: MobileLevel2Form | null;
  /** The channel shown; `null` while the surface shows none. */
  readonly activeBotId: string | null;
  readonly hostId: string;
  /** The surface's Threads view; `null` where no Threads entry is offered. */
  readonly threadsView: BotThreadsViewState | null;
}): ReactNode {
  const { level2, activeBotId, hostId, threadsView } = props;
  const sidebar = (
    <BotChannelSidebar
      activeBotId={activeBotId}
      hostId={hostId}
      threadsView={threadsView}
      onChannelOpened={stayOpen}
    />
  );
  if (level2 === null) {
    return (
      <BotResizablePane
        pane="sidebar"
        edge="right"
        label="Resize channels"
        className="hidden min-h-0 w-(--bot-pane-width) max-w-[40%] shrink-0 flex-col border-r border-canvas-border/70 @3xl:flex"
        handleClassName=""
        testId="bot-channel-sidebar-pane"
      >
        {sidebar}
      </BotResizablePane>
    );
  }
  if (typeof level2 !== "object") return null;
  return (
    <MobileLevel2Column width={level2.column} testId="bot-channel-sidebar-pane">
      {sidebar}
    </MobileLevel2Column>
  );
}

/** Whether the installed app draws no column, so a title is the picker. */
function titlePicks(level2: MobileLevel2Form | null): boolean {
  return level2 === "menu" || level2 === "bar";
}

/**
 * What the surface shows with no channel selected. Where the installed app
 * draws no column, a title over it is the picker, as a channel's is, so the
 * column's rows (a team still to be set up, Threads, a new bot) stay within
 * reach.
 */
export function BotUnselectedLevel2Pane(props: {
  readonly level2: MobileLevel2Form | null;
  readonly title: string;
  readonly hostId: string;
  readonly threadsView: BotThreadsViewState;
  readonly children: ReactNode;
}): ReactNode {
  const { level2 } = props;
  if (!titlePicks(level2)) return props.children;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
        <BotChannelTitle
          level2={level2}
          title={props.title}
          activeBotId={null}
          hostId={props.hostId}
          threadsView={props.threadsView}
        />
      </header>
      {props.children}
    </div>
  );
}

/**
 * The bot's name at the head of its channel. Where the installed app draws no
 * column the name is also the picker: the bots list in a menu under it, closed
 * by a pick or by tapping outside.
 */
export function BotChannelTitle(props: {
  readonly level2: MobileLevel2Form | null;
  readonly title: string;
  /** The channel shown; `null` while the surface shows none. */
  readonly activeBotId: string | null;
  readonly hostId: string;
  /** The surface's Threads view; `null` where no Threads entry is offered. */
  readonly threadsView: BotThreadsViewState | null;
}): ReactNode {
  const { level2, title } = props;
  const picker = titlePicks(level2);
  return (
    <h1
      className="min-w-0 truncate text-ui-md font-bold text-foreground"
      data-testid="bot-tab-title"
    >
      {picker ? (
        <BotChannelPicker
          title={title}
          activeBotId={props.activeBotId}
          hostId={props.hostId}
          threadsView={props.threadsView}
        />
      ) : (
        title
      )}
    </h1>
  );
}

function BotChannelPicker(props: {
  readonly title: string;
  readonly activeBotId: string | null;
  readonly hostId: string;
  readonly threadsView: BotThreadsViewState | null;
}): ReactNode {
  const { title, activeBotId, hostId, threadsView } = props;
  const [open, setOpen] = useState(false);
  const close = (): void => setOpen(false);
  // Threads is a row of the list like any channel, so choosing it closes too.
  const pickerThreadsView = useMemo(
    (): BotThreadsViewState | null =>
      threadsView === null
        ? null
        : {
            ...threadsView,
            onShow: () => {
              threadsView.onShow();
              setOpen(false);
            },
          },
    [threadsView],
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <MobileLevel2MenuTrigger
        testId="bot-channel-picker-trigger"
        className={undefined}
      >
        <span className="min-w-0 truncate">{title}</span>
      </MobileLevel2MenuTrigger>
      <MobileLevel2MenuContent
        label="Channels"
        testId="bot-channel-picker"
        tall={false}
      >
        <BotChannelSidebar
          activeBotId={activeBotId}
          hostId={hostId}
          threadsView={pickerThreadsView}
          onChannelOpened={close}
        />
      </MobileLevel2MenuContent>
    </Popover>
  );
}
