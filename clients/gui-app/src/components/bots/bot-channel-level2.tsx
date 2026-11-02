import { useMemo, useState, type ReactNode } from "react";
import {
  BotChannelSidebar,
  type BotThreadsViewState,
} from "@/components/bots/bot-channel-sidebar";
import { BotResizablePane } from "@/components/bots/bot-resizable-pane";
import {
  MobileLevel2MenuContent,
  MobileLevel2MenuTrigger,
} from "@/components/layout/shell/mobile-level2";
import { Popover } from "@/components/ui/popover";
import { useStandaloneBotName } from "@/hooks/bots/use-standalone-bot-name";
import { isPhoneLayoutOnly } from "@/lib/mobile-app";

function stayOpen(): void {}

/**
 * The bots list beside a bot tab's channel. The tab's own container decides
 * and the person drags the width; the installed app draws no column, and a
 * channel's title is its picker there.
 */
export function BotChannelColumn(props: {
  /** The channel shown; `null` while the surface shows none. */
  readonly activeBotId: string | null;
  readonly hostId: string;
  /** The surface's Threads view; `null` where no Threads entry is offered. */
  readonly threadsView: BotThreadsViewState | null;
}): ReactNode {
  const { activeBotId, hostId, threadsView } = props;
  if (isPhoneLayoutOnly()) return null;
  return (
    <BotResizablePane
      pane="sidebar"
      edge="right"
      label="Resize channels"
      className="hidden min-h-0 w-(--bot-pane-width) max-w-[40%] shrink-0 flex-col border-r border-canvas-border/70 @3xl:flex"
      handleClassName=""
      testId="bot-channel-sidebar-pane"
    >
      <BotChannelSidebar
        activeBotId={activeBotId}
        hostId={hostId}
        threadsView={threadsView}
        onChannelOpened={stayOpen}
      />
    </BotResizablePane>
  );
}

/**
 * What the surface shows with no channel selected. The installed app draws no
 * column, so a title over it is the picker, as a channel's is, so the column's
 * rows (a team still to be set up, Threads, a new bot) stay within reach.
 */
export function BotUnselectedLevel2Pane(props: {
  readonly title: string;
  readonly hostId: string;
  readonly threadsView: BotThreadsViewState;
  readonly children: ReactNode;
}): ReactNode {
  if (!isPhoneLayoutOnly()) return props.children;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
        <BotChannelTitle
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
 * The bot's name at the head of its channel. The installed app draws no column,
 * so the name is also the picker there: the bots list in a menu under it, closed
 * by a pick or by tapping outside.
 */
export function BotChannelTitle(props: {
  readonly title: string;
  /** The channel shown; `null` while the surface shows none. */
  readonly activeBotId: string | null;
  readonly hostId: string;
  /** The surface's Threads view; `null` where no Threads entry is offered. */
  readonly threadsView: BotThreadsViewState | null;
}): ReactNode {
  const { title } = props;
  return (
    <h1
      className="min-w-0 truncate text-ui-md font-bold text-foreground"
      data-testid="bot-tab-title"
    >
      {isPhoneLayoutOnly() ? (
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
  // The list that shows the environment is closed while this is read.
  const name = useStandaloneBotName(activeBotId, title);
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
      <MobileLevel2MenuTrigger testId="bot-channel-picker-trigger">
        <span className="min-w-0 truncate">{name}</span>
      </MobileLevel2MenuTrigger>
      <MobileLevel2MenuContent label="Channels" testId="bot-channel-picker">
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
