import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  watchAnnouncements,
  type ChannelHandleSource,
  type WatchedChannelHandle,
} from "../announcement-watch";
import type { Announcement, AnnouncementRow } from "../queue-sources";

interface ChannelState {
  readonly snapshotLoaded: boolean;
  readonly messages: ReadonlyArray<AnnouncementRow>;
}

interface FakeHandle extends WatchedChannelHandle {
  readonly store: StoreApi<ChannelState>;
}

interface Found {
  readonly botId: string;
  readonly hostId: string;
  readonly chatId: string;
  readonly announcement: Announcement;
}

function textBlock(text: string): OpenTextBlock {
  return {
    blockId: `block-${text}`,
    status: "completed",
    timestamp: 1,
    parentBlockId: null,
    type: "text",
    text,
    providerNotice: null,
  };
}

function post(messageId: string, timestamp: number): AnnouncementRow {
  return {
    role: "assistant",
    messageId,
    timestamp,
    blocks: [textBlock(`Post ${messageId}.`)],
  };
}

function handle(
  epicId: string,
  chatId: string,
  state: ChannelState,
): FakeHandle {
  return { epicId, chatId, store: createStore<ChannelState>()(() => state) };
}

const LOADED_EMPTY: ChannelState = { snapshotLoaded: true, messages: [] };

let handles: FakeHandle[];
let registryListeners: Set<() => void>;
let source: ChannelHandleSource<FakeHandle>;
let found: Found[];
let focusedChannels: Set<string>;
let stop: () => void;

/** The registry gains or loses a channel store. */
function setHandles(next: FakeHandle[]): void {
  handles = next;
  for (const listener of registryListeners) listener();
}

function watch(): void {
  stop = watchAnnouncements({
    source,
    channelBot: (chatId) => (chatId.startsWith("chan-") ? "bot-2" : null),
    isFocused: (_botId, chatId) => focusedChannels.has(chatId),
    onAnnouncement: (announcement) => found.push(announcement),
  });
}

beforeEach(() => {
  handles = [];
  registryListeners = new Set<() => void>();
  found = [];
  focusedChannels = new Set<string>();
  source = {
    listHandles: () => handles,
    subscribe: (listener) => {
      registryListeners.add(listener);
      return () => registryListeners.delete(listener);
    },
    hostIdForHandle: vi.fn(() => "host-a"),
  };
});

describe("watchAnnouncements", () => {
  it("takes the first loaded snapshot as history, then announces a new row that answers nothing", () => {
    const channel = handle("bot-2", "chan-2", {
      snapshotLoaded: false,
      messages: [],
    });
    setHandles([channel]);
    watch();

    channel.store.setState({
      snapshotLoaded: true,
      messages: [post("old", 1_000)],
    });
    expect(found).toEqual([]);

    channel.store.setState({
      snapshotLoaded: true,
      messages: [
        post("old", 1_000),
        {
          role: "user",
          messageId: "u-1",
          timestamp: 1_500,
          conversationRequest: {
            requestId: "req-1",
            resolvedAt: 2_100,
            resolvedByMessageId: "answer",
          },
        },
        post("answer", 2_000),
        post("news", 3_000),
      ],
    });

    expect(found).toEqual([
      {
        botId: "bot-2",
        hostId: "host-a",
        chatId: "chan-2",
        announcement: { messageId: "news", content: "Post news.", at: 3_000 },
      },
    ]);
  });

  it("ignores a chat that is not a bot's channel, one under another bot's epic, and a focused channel", () => {
    const notChannel = handle("bot-2", "thread-x", LOADED_EMPTY);
    const otherBot = handle("bot-9", "chan-9", LOADED_EMPTY);
    const focused = handle("bot-2", "chan-focus", LOADED_EMPTY);
    const watched = handle("bot-2", "chan-2", LOADED_EMPTY);
    focusedChannels.add("chan-focus");
    setHandles([notChannel, otherBot, focused, watched]);
    watch();

    for (const channel of [notChannel, otherBot, focused, watched]) {
      channel.store.setState({
        snapshotLoaded: true,
        messages: [post(`post-${channel.chatId}`, 2_000)],
      });
    }
    expect(found.map((entry) => entry.chatId)).toEqual(["chan-2"]);

    // What landed while the channel was focused was said there, not news later.
    focusedChannels.delete("chan-focus");
    focused.store.setState({
      snapshotLoaded: true,
      messages: [post("post-chan-focus", 2_000), post("later", 3_000)],
    });
    expect(found.map((entry) => entry.announcement.messageId)).toEqual([
      "post-chan-2",
      "later",
    ]);
  });

  it("watches a channel store the registry gains later, from its first loaded snapshot", () => {
    watch();
    const channel = handle("bot-2", "chan-2", {
      snapshotLoaded: true,
      messages: [post("old", 1_000)],
    });
    setHandles([channel]);
    expect(found).toEqual([]);

    channel.store.setState({
      snapshotLoaded: true,
      messages: [post("old", 1_000), post("news", 2_000)],
    });

    expect(found.map((entry) => entry.announcement.messageId)).toEqual([
      "news",
    ]);
  });

  it("stops reading once stopped: later rows and new channel stores produce nothing", () => {
    const channel = handle("bot-2", "chan-2", LOADED_EMPTY);
    setHandles([channel]);
    watch();

    stop();
    channel.store.setState({
      snapshotLoaded: true,
      messages: [post("news", 2_000)],
    });
    const late = handle("bot-2", "chan-3", LOADED_EMPTY);
    setHandles([channel, late]);
    late.store.setState({
      snapshotLoaded: true,
      messages: [post("news-3", 3_000)],
    });

    expect(found).toEqual([]);
  });
});
