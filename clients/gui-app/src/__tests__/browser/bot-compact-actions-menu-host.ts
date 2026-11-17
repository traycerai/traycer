import { useSyncExternalStore } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  BotRecord,
  BotSubscribeServerFrame,
} from "@traycer/protocol/host/bot/schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  IHostStreamClient,
  ReconnectAllOptions,
} from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamParamsProvider } from "@traycer-clients/shared/host-transport/i-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ParamsOf,
  StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { publishAgentActivity } from "@/__tests__/agent-activity-harness";
import { type HostRpcRegistry, type MessengerFactory } from "@/lib/host";
import { acquireHostStreamClient } from "@/lib/host/host-stream-client-cache";
import { setMobileApp, setPhoneLayoutOnly } from "@/lib/mobile-app";
import { playbackTrack } from "@/lib/soundtrack/__tests__/playback-track";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTracyPlaceStore } from "@/stores/bots/tracy-place-store";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * THE COMPACT CHANNEL ACTIONS MENU, IN THE INSTALLED APP'S PHONE FORM.
 *
 * The real `BotTabSurface` under the real `MobileAppHeader` and its bot slot,
 * over a host that answers one bot with fake data. The claim is real focus:
 * what a choice in the Channel actions menu hands focus to once the menu has
 * closed, which jsdom's focus does not decide. Nothing of the header, the
 * menu, Search or the settings panel is reimplemented.
 *
 * The bot's `bot.subscribe` is a stream, which the mock messenger does not
 * serve, so a stream client that delivers one snapshot is placed in the cache
 * the surface acquires from.
 *
 * Two URL-query switches, read once at module load, serve other specs:
 * `?snapshot=held` opens the `bot.subscribe` session but never delivers the
 * snapshot, so the channel pane stays in its connecting state; `?form=desktop`
 * skips the phone-form flags, so a wide window gets the desktop form. With
 * neither, the page is the phone form with the snapshot delivered.
 *
 * `?music=1` turns the playback controls on with a sounding track, as the
 * Music settings do, and `window.__botChannelProbe` changes them live:
 * `setControls` turns the setting on or off, `setPaneWidth` sets the width of
 * the pane the channel is drawn in, in CSS pixels, `holdSnapshots` holds back
 * the snapshots of one bot (`null`: of none, which delivers every one held;
 * `?snapshot=held` holds every bot's), and `selectBot` changes the channel
 * the surface is asked for.
 * `?music=long` sounds a title too long for its window, so it scrolls;
 * `showThreads` and `showSession` (a chat id, `null` to leave) move the
 * surface to Threads and to a session in place of the channel, and
 * `soundTrack` (a track name) sounds another track under the same title.
 * `?bots=2` lists a second bot, `SECOND_BOT_ID`, for `selectBot` to switch to.
 *
 * `?hostMethods=held` leaves the host's handshake unanswered until
 * `advertiseHostMethods` is called, and `hostGates` holds the lists' and
 * `bot.open`'s answers until the promise in it settles (a cold open's gates,
 * `tracy-tab-cold-open`). `window.__fixtureCommitted` is set by the first
 * commit of the content under `FixtureApp`.
 *
 * The drafts bridge the app mounts above every tab
 * (`BotDraftsPersistLifecycleBridge`, `traycer-app.tsx`) is mounted here too:
 * the bot tab shows its tree only once the signed-in account's own drafts are
 * read (T186), here from the page's own storage.
 */
const QUERY = new URLSearchParams(window.location.search);
const SNAPSHOT_HELD = QUERY.get("snapshot") === "held";
const DESKTOP_FORM = QUERY.get("form") === "desktop";
const MUSIC = QUERY.get("music") === "1" || QUERY.get("music") === "long";
const LONG_TRACK_TITLE =
  "A very long track title that cannot fit the window beside the buttons";
const TWO_BOTS = QUERY.get("bots") === "2";
const HOST_METHODS_HELD = QUERY.get("hostMethods") === "held";

declare global {
  interface Window {
    __botChannelProbe?: {
      readonly setControls: (on: boolean) => void;
      readonly setPaneWidth: (px: number) => void;
      readonly holdSnapshots: (botId: string | null) => void;
      readonly selectBot: (botId: string) => void;
      readonly showThreads: (shown: boolean) => void;
      readonly showSession: (chatId: string | null) => void;
      readonly soundTrack: (name: string) => void;
    };
    /** Set once the content under `FixtureApp` has committed. */
    __fixtureCommitted?: boolean;
  }
}

export const HOST_ID = "bot-compact-actions-menu-host";
export const BOT_ID = "bot_01JD5X8Q2M4N6P8R0S2T4V6W8Y";
const SECOND_BOT_ID = "bot_01JD5X8Q2M4N6P8R0S2T4V6W9Z";
const ENVIRONMENT_ID = "env-personal";
const WEBSOCKET_URL = "ws://127.0.0.1:9/rpc";
const AUTHN_BASE_URL = "http://127.0.0.1:9";

useSettingsStore.getState().setTheme("light");
if (!DESKTOP_FORM) {
  setPhoneLayoutOnly(true);
  setMobileApp(true);
}

if (MUSIC) {
  // The availability the controls read: a desktop build that reports a source.
  Object.defineProperty(globalThis, "runnerHost", {
    configurable: true,
    value: {
      soundtrackSourceAvailable: true,
      readSoundtrackSet: () => Promise.resolve({ kind: "unavailable" }),
    },
  });
  useSettingsStore.setState({
    soundtrackEnabled: true,
    soundtrackPlaybackControls: true,
  });
  useSoundtrackStore.setState({
    soundingTrack: {
      ...playbackTrack("slow-tide", 60),
      title: QUERY.get("music") === "long" ? LONG_TRACK_TITLE : "Slow Tide",
    },
  });
}

/** The channel the surface is asked for, which `selectBot` changes. */
let selectedBotId = BOT_ID;
const selectionListeners = new Set<() => void>();

/**
 * The bot whose snapshots are held back, `"all"` for every bot's, `null` for
 * none; a held delivery waits in `heldDeliveries` until its bot is released.
 */
let heldBot: string | null = SNAPSHOT_HELD ? "all" : null;
const heldDeliveries: Array<{ botId: string; deliver: () => void }> = [];

function isHeld(botId: string): boolean {
  return heldBot === "all" || heldBot === botId;
}

window.__botChannelProbe = {
  setControls: (on) => {
    useSettingsStore.setState({ soundtrackPlaybackControls: on });
  },
  setPaneWidth: (px) => {
    document.documentElement.style.setProperty("--pane-width", `${px}px`);
  },
  holdSnapshots: (botId) => {
    heldBot = botId;
    const waiting = heldDeliveries.splice(0);
    for (const entry of waiting) {
      if (isHeld(entry.botId)) heldDeliveries.push(entry);
      else entry.deliver();
    }
  },
  selectBot: (botId) => {
    selectedBotId = botId;
    for (const listener of selectionListeners) listener();
  },
  showThreads: (shown) => {
    const place = useTracyPlaceStore.getState();
    if (shown) place.setSession(selectedBotId, null);
    place.setThreadsShown(shown);
  },
  soundTrack: (name) => {
    useSoundtrackStore.setState({
      soundingTrack: { ...playbackTrack(name, 60), title: LONG_TRACK_TITLE },
    });
  },
  showSession: (chatId) => {
    useTracyPlaceStore
      .getState()
      .setSession(
        selectedBotId,
        chatId === null ? null : { chatId, threadId: null },
      );
  },
};

/** Holds an answer until its gate settles; a `null` gate answers at once. */
function answerAfter<Answer>(
  gate: Promise<void> | null,
  answer: Answer,
): Answer | Promise<Answer> {
  return gate === null ? answer : gate.then(() => answer);
}

/** The answers a cold open holds: the lists', and `bot.open`'s. */
export const hostGates: {
  lists: Promise<void> | null;
  open: Promise<void> | null;
} = { lists: null, open: null };

// The page offers only what the host advertised in its handshake; this
// fixture's mock messenger makes none, so the methods are recorded here.
export function advertiseHostMethods(): void {
  recordNegotiatedHostManifest(HOST_ID, {
    "bot.list": { major: 1, minor: 1 },
    "bot.open": { major: 1, minor: 0 },
    "bot.conversation.list": { major: 1, minor: 0 },
    "bot.conversation.search": { major: 1, minor: 0 },
    "bot.thread.list": { major: 1, minor: 2 },
    "bot.threadFollow.read": { major: 1, minor: 0 },
    "bot.readCursor.read": { major: 1, minor: 0 },
    "bot.notificationLevel.read": { major: 1, minor: 0 },
    "bot.turn.locate": { major: 1, minor: 0 },
    "environment.list": { major: 1, minor: 1 },
    "environment.members": { major: 1, minor: 2 },
  });
}
if (!HOST_METHODS_HELD) advertiseHostMethods();

export const requestContext = createRendererContextFixture({
  bearerToken: "fixture",
});
export const USER_ID = requestContext.identity.userId;

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: ENVIRONMENT_ID,
  createdByUserId: USER_ID,
  title: "Tracy",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: `channel-${BOT_ID}`,
  trunkChatId: `trunk-${BOT_ID}`,
  boundHostId: HOST_ID,
  hostEpoch: 0,
  createdAt: 1_000,
  archivedAt: null,
};

const SECOND_BOT: BotRecord = {
  ...BOT,
  botId: SECOND_BOT_ID,
  title: "Scribe",
  appConversationChatId: `channel-${SECOND_BOT_ID}`,
  trunkChatId: `trunk-${SECOND_BOT_ID}`,
};

const BOTS: readonly BotRecord[] = TWO_BOTS ? [BOT, SECOND_BOT] : [BOT];

function botOf(botId: string): BotRecord {
  return BOTS.find((bot) => bot.botId === botId) ?? BOT;
}

const SNAPSHOT: BotSubscribeServerFrame = {
  kind: "snapshot",
  bot: BOT,
  tasks: [
    {
      taskId: "fixture-task",
      cadence: { kind: "every", seconds: 86400 },
      lastCheckinAt: null,
      lastCheckin: null,
      nextAt: null,
      state: "tracking",
      endedReason: null,
      createdByUserId: null,
      spun: true,
      label: null,
      originRequestId: null,
      createdByChatId: null,
      inputNeeded: null,
      pause: null,
      stop: null,
      runRequest: null,
    },
  ],
  openRequestCount: 0,
  conversationsRevision: null,
  boundHost: { hostId: HOST_ID, epoch: 0, isThisHost: true },
  activity: null,
  notificationSubscriptions: null,
  surfaceActions: null,
  stoppedNotificationWatches: null,
  hasBinaryPayload: false,
};

/** One `bot.subscribe` session that opens and delivers its bot's snapshot. */
class SnapshotSession implements IStreamSession {
  readonly close = (): void => undefined;

  constructor(private readonly botId: string) {}

  sendClientFrame(): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    const deliver = (): void =>
      handler({ ...SNAPSHOT, bot: botOf(this.botId) }, null);
    if (isHeld(this.botId)) {
      heldDeliveries.push({ botId: this.botId, deliver });
      return;
    }
    queueMicrotask(deliver);
  }

  onStatusChange(handler: StatusChangeHandler): void {
    queueMicrotask(() => handler("open", null, null, null));
  }

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {}

  hasSentOpenRequest(): boolean {
    return true;
  }
}

/** A stream client whose every subscribe is a `SnapshotSession`. */
class SnapshotStreamClient implements IHostStreamClient<HostStreamRpcRegistry> {
  readonly instanceId = "bot-compact-actions-menu-stream";

  isReady(): boolean {
    return true;
  }

  subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return new SnapshotSession(
      typeof params === "object" &&
        params !== null &&
        "botId" in params &&
        typeof params.botId === "string"
        ? params.botId
        : BOT_ID,
    );
  }

  subscribeWithParamsProvider<
    Method extends keyof HostStreamRpcRegistry & string,
  >(
    _method: Method,
    _paramsProvider: StreamParamsProvider<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return new SnapshotSession(BOT_ID);
  }

  getMethodSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(): void {}

  isClosed(): boolean {
    return false;
  }

  getClosedReason(): string | null {
    return null;
  }

  onClosed(): () => void {
    return () => {};
  }

  notifyBearerRotated(): void {}
  notifyCloudVerdictChanged(): void {}

  reconnectAll(_reason: string, _options: ReconnectAllOptions): void {}

  getMethodSupport(): StreamMethodSupport {
    return "unknown";
  }

  subscribeMethodSupport(): () => void {
    return () => {};
  }

  subscribeAvailabilityRecovered(): () => void {
    return () => {};
  }
}

const streamClient = new SnapshotStreamClient();
acquireHostStreamClient(
  {
    kind: "local",
    hostId: HOST_ID,
    userId: USER_ID,
    websocketUrl: WEBSOCKET_URL,
    publicKey: "",
    authnBaseUrl: AUTHN_BASE_URL,
    authRecovery: "revalidate",
    openAuth: null,
  },
  () => streamClient,
);

publishAgentActivity([
  {
    hostId: HOST_ID,
    byEpic: { "fixture-task": { working: ["agent"], turn: ["agent"] } },
  },
]);

const tracyRef = { kind: "tracy", id: "tracy" } as const;
useTabsStore.setState({
  items: [{ kind: "tab", id: tabItemId(tracyRef), ref: tracyRef }],
  activeItemId: tabItemId(tracyRef),
  stripOrder: [tracyRef],
});

const localHost = {
  hostId: HOST_ID,
  websocketUrl: WEBSOCKET_URL,
  version: "1.2.3",
  pid: 4547,
  systemHostName: "bot-compact-actions-menu-fixture",
  displayName: "bot-compact-actions-menu-fixture",
  availability: "available",
} as const;

export const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let requestCounter = 0;
export const messengerFactory: MessengerFactory<HostRpcRegistry> = ({
  registry,
}) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `bot-compact-actions-menu-${String(++requestCounter)}`,
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 2 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
        processMemory: null,
        crossHostMessaging: null,
        sessions: null,
        updatesExternallyManaged: null,
        previousExit: null,
      }),
      "host.notifications.indicatorState": () => ({
        epics: {},
        chats: {},
        complete: true,
      }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
      "bot.list": () =>
        answerAfter(hostGates.lists, { bots: [...BOTS], mainBotIds: null }),
      "bot.open": (request) =>
        answerAfter(hostGates.open, {
          bot: botOf(request.botId),
          outcome: { kind: "serve-here", claimed: null },
        }),
      "bot.conversation.list": (request) =>
        answerAfter(hostGates.lists, {
          conversations: [
            {
              conversationId: `channel-${request.botId}`,
              botId: request.botId,
              title: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      "environment.list": () =>
        answerAfter(hostGates.lists, {
          environments: [
            {
              environmentId: ENVIRONMENT_ID,
              ownerKind: "user",
              ownerId: USER_ID,
              roomId: "room-personal",
              label: "Personal",
              effectiveRole: "owner",
              kind: "personal",
              hostCount: 1,
              providerHandle: null,
            },
          ],
        }),
      "environment.members": () => ({
        members: [],
        nextCursor: null,
        legacyRoleNoticeSeenAt: null,
        legacyMembers: [],
      }),
      "bot.thread.list": () => ({
        threads: [],
        trunkCostUsd: null,
        threadAnchors: null,
        nextCursor: null,
        total: 0,
      }),
      "bot.conversation.search": () => ({
        hits: [],
        nextCursor: null,
        indexState: "complete",
        total: 0,
        unreachable: [],
      }),
      "bot.threadFollow.read": () => ({ follows: {} }),
      "bot.readCursor.read": () => ({ cursors: {}, latest: {} }),
      "bot.notificationLevel.read": () => ({ levels: {} }),
      "bot.turn.locate": () => ({ turns: [] }),
    },
  });

/** The channel the surface is asked for, which `selectBot` changes. */
export function useSelectedBotId(): string {
  return useSyncExternalStore(
    (listener) => {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    () => selectedBotId,
  );
}

export const runnerHost = new MockRunnerHost({
  signInUrl: `${AUTHN_BASE_URL}/sign-in`,
  authnBaseUrl: AUTHN_BASE_URL,
  localHost,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: new MockTraycerCli(),
});
