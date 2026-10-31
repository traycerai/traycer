import {
  announcementsOf,
  type Announcement,
  type AnnouncementRow,
} from "@/lib/voice/queue-sources";

/**
 * Announcements, from the channel stores of the bots the voice knows (Tracy
 * Bots voice, VT4; V3: spoken only in a briefing). Read lazily: only the
 * channel stores this window already holds are read, and none is opened for
 * the voice. The first reading of a store is history; the bot's rows that
 * land after it and answer nothing are announcements. The focused channel is
 * left out: the focused feed speaks its rows.
 */

/** A channel store as the watch reads it. */
export interface WatchedChannelHandle {
  readonly epicId: string;
  readonly chatId: string;
  readonly store: {
    readonly getState: () => {
      readonly snapshotLoaded: boolean;
      readonly messages: ReadonlyArray<AnnouncementRow>;
    };
    readonly subscribe: (listener: () => void) => () => void;
  };
}

/** The slice of the chat-session registry the watch reads. */
export interface ChannelHandleSource<H extends WatchedChannelHandle> {
  readonly listHandles: () => ReadonlyArray<H>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly hostIdForHandle: (handle: H) => string | null;
}

export function watchAnnouncements<H extends WatchedChannelHandle>(input: {
  readonly source: ChannelHandleSource<H>;
  /** The bot whose channel `chatId` is, or `null` for any other chat. */
  readonly channelBot: (chatId: string) => string | null;
  readonly isFocused: (botId: string, chatId: string) => boolean;
  readonly onAnnouncement: (found: {
    readonly botId: string;
    readonly hostId: string;
    readonly chatId: string;
    readonly announcement: Announcement;
  }) => void;
}): () => void {
  interface Watch {
    unsubscribe: () => void;
    since: number | null;
  }
  const watches = new Map<H, Watch>();

  const read = (handle: H, watch: Watch, botId: string): void => {
    const state = handle.store.getState();
    if (!state.snapshotLoaded) return;
    if (watch.since === null) {
      watch.since = newestOf(state.messages);
      return;
    }
    const hostId = input.source.hostIdForHandle(handle);
    if (hostId === null || input.isFocused(botId, handle.chatId)) {
      watch.since = Math.max(watch.since, newestOf(state.messages));
      return;
    }
    for (const announcement of announcementsOf(state.messages, watch.since)) {
      input.onAnnouncement({
        botId,
        hostId,
        chatId: handle.chatId,
        announcement,
      });
      watch.since = Math.max(watch.since, announcement.at);
    }
  };

  const rebind = (): void => {
    const live = new Set(input.source.listHandles());
    for (const [handle, watch] of watches) {
      if (live.has(handle)) continue;
      watch.unsubscribe();
      watches.delete(handle);
    }
    for (const handle of live) {
      if (watches.has(handle)) continue;
      const botId = input.channelBot(handle.chatId);
      if (botId === null || botId !== handle.epicId) continue;
      const watch: Watch = { since: null, unsubscribe: () => undefined };
      watch.unsubscribe = handle.store.subscribe(() =>
        read(handle, watch, botId),
      );
      watches.set(handle, watch);
      read(handle, watch, botId);
    }
  };

  const stopRegistry = input.source.subscribe(rebind);
  rebind();
  return () => {
    stopRegistry();
    for (const watch of watches.values()) watch.unsubscribe();
    watches.clear();
  };
}

function newestOf(rows: ReadonlyArray<AnnouncementRow>): number {
  let newest = 0;
  for (const row of rows) newest = Math.max(newest, row.timestamp);
  return newest;
}
