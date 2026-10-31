/**
 * A bot's post that points at a parked page (Tracy Bots voice, VT5), through
 * the real `VoiceCards` and its opener. Only the two hooks the opener hands
 * its surface to are replaced: the bot's stream (`useBotSubscriptionForHost`,
 * which supplies the task's open surfaces) and the existing opener
 * (`useBotSurfaceOpen`, which records the `(surface, open, title)` it was
 * given and returns a spy). What is asserted is which park the voice hands
 * that opener, when it opens, and what it says.
 */
import { act, cleanup, render } from "@testing-library/react";
import type {
  BotInputNeeded,
  BotRecord,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  BotSubscriptionResult,
  BotSubscriptionSnapshot,
} from "@/hooks/bots/use-bot-subscription";
import type {
  VoiceQueueOwner,
  VoiceSurfaceOpen,
} from "@/hooks/voice/use-voice-queue-owner";
import { createSpeechScheduler, type SpeechItem } from "@/lib/voice/scheduler";
import {
  useVoiceSessionStore,
  type QueueItem,
} from "@/stores/voice/voice-session-store";
import { PARK_READ_TIMEOUT_MS, VoiceCards } from "../voice-card-watch";

const fake = vi.hoisted(() => ({
  subscription: {
    snapshot: null,
    deleted: false,
    error: null,
    isPending: true,
    resubscribe: () => undefined,
  } as BotSubscriptionResult,
  openPage: vi.fn(),
  surfaceOpen:
    vi.fn<
      (
        surface: BotSurfaceReference,
        open: BotInputNeeded | null,
        title: string,
      ) => () => void
    >(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: () => fake.subscription,
}));
vi.mock("@/hooks/bots/use-bot-surface-open", () => ({
  useBotSurfaceOpen: (
    surface: BotSurfaceReference,
    open: BotInputNeeded | null,
    title: string,
  ) => fake.surfaceOpen(surface, open, title),
}));

const initial = useVoiceSessionStore.getState();

const TASK_ID = "task-1";
const HOST = "host-a";
const AGENT_CHAT = "agent-chat-1";

const PARKED_PAGE: Extract<BotSurfaceReference, { kind: "browser" }> = {
  kind: "browser",
  epicId: TASK_ID,
  hostId: HOST,
  chatId: AGENT_CHAT,
  sessionId: "session-1",
  parkId: "park-1",
  tabId: null,
  resolution: null,
};

const LIVE_PARK: BotInputNeeded = {
  hostId: HOST,
  hostName: "Studio Mac",
  agentChatId: AGENT_CHAT,
  surfaceId: "park-1",
  surface: {
    kind: "browser",
    sessionId: "session-1",
    tabId: "tab-1",
    url: "https://accounts.example.com/login",
    title: "Sign in to Example",
    reason: "Needs your login",
    parkedAt: 1,
    parkId: "park-1",
  },
  reportedAt: 1_000,
  acceptsActions: true,
};

function task(inputNeeded: ReadonlyArray<BotInputNeeded>): BotTaskEntry {
  return {
    taskId: TASK_ID,
    cadence: { kind: "on-completion" },
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
    checkins: null,
    inputNeeded: [...inputNeeded],
    pause: null,
    stop: null,
    runRequest: null,
  };
}

const BOT: BotRecord = {
  botId: "bot-1",
  environmentId: "env-1",
  createdByUserId: "user-me",
  title: "Release bot",
  harness: "claude",
  model: "model-1",
  effort: null,
  profile: null,
  trunkChatId: "trunk-bot-1",
  boundHostId: null,
  hostEpoch: 0,
  createdAt: 1,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: null,
};

function snapshotOf(
  tasks: ReadonlyArray<BotTaskEntry>,
): BotSubscriptionSnapshot {
  return {
    bot: BOT,
    tasks,
    openRequestCount: null,
    conversationsRevision: null,
    boundHost: { hostId: null, epoch: 0, isThisHost: false },
    activity: null,
    notificationSubscriptions: null,
    surfaceActions: null,
    stoppedNotificationWatches: null,
  };
}

/** The bot's stream as the opener reads it: nothing yet, or this snapshot. */
function serve(snapshot: BotSubscriptionSnapshot | null): void {
  fake.subscription = {
    snapshot,
    deleted: false,
    error: null,
    isPending: snapshot === null,
    resubscribe: () => undefined,
  };
}

const ITEM: QueueItem = {
  id: "s-1",
  kind: "surface",
  botId: "bot-1",
  hostId: HOST,
  threadId: null,
  chatId: "chat-1",
  messageId: "s-1",
  surfaceId: "park-1",
  title: "Sign in to Example",
  author: null,
  line: "A line",
  at: 1_000,
  state: "queued",
};

interface Mounted {
  readonly spoken: SpeechItem[];
  readonly onSurfaceOpened: Mock<(seq: number) => void>;
  readonly serveAndRender: (snapshot: BotSubscriptionSnapshot | null) => void;
}

function mountOpener(): Mounted {
  const scheduler = createSpeechScheduler({
    append: () => undefined,
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  const spoken: SpeechItem[] = [];
  const enqueue = scheduler.enqueue.bind(scheduler);
  scheduler.enqueue = (item) => {
    spoken.push(item);
    enqueue(item);
  };
  const onSurfaceOpened = vi.fn<(seq: number) => void>();
  const now = useVoiceSessionStore.getState();
  const request: VoiceSurfaceOpen = {
    seq: 7,
    item: ITEM,
    surface: PARKED_PAGE,
    botTitle: "Release bot",
    delegationId: "d-1",
    sessionToken: now.sessionToken,
    engineGeneration: now.engineGeneration,
  };
  const owner: VoiceQueueOwner = {
    queue: null,
    attention: { answers: [], prompts: { approvals: [], questions: [] } },
    hostOf: () => HOST,
    bots: [BOT],
    registerMark: () => undefined,
    voiceSwitch: { current: null },
    statusRequests: [],
    onStatusComposed: () => undefined,
    cardDesk: null,
    surfaceOpens: [request],
    onSurfaceOpened,
    beginQueue: () => "",
    resetQueue: () => undefined,
    noteChannel: () => undefined,
    noteFocused: () => undefined,
    keepsFromFocus: () => false,
    noteAnnouncement: () => undefined,
    noteStopped: () => undefined,
    forgetStopped: () => undefined,
    dropStopped: () => undefined,
  };
  // A new element each time, so a rerender reaches the opener.
  const tree = () => (
    <VoiceCards
      owner={owner}
      speech={scheduler}
      botTitle={() => "Release bot"}
      placeOf={() => "in its channel"}
    />
  );
  const view = render(tree());
  return {
    spoken,
    onSurfaceOpened,
    serveAndRender: (snapshot) => {
      serve(snapshot);
      act(() => view.rerender(tree()));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useVoiceSessionStore.setState(initial, true);
  useVoiceSessionStore.setState({ phase: "live" });
  fake.openPage.mockReset();
  fake.surfaceOpen.mockReset();
  fake.surfaceOpen.mockImplementation(() => fake.openPage);
  serve(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const OPEN_IN_TASK =
  'Release bot\'s page "Sign in to Example" is waiting for you to sign in. It is open now, in its task.';
const TASK_OPEN =
  'Release bot\'s page "Sign in to Example" is waiting for you to sign in. Its task is open now.';

describe("a parked page the voice opens from a post that names no tab", () => {
  it("hands the opener the live park from the bot's stream, opens once, and says the page is open", () => {
    serve(snapshotOf([task([LIVE_PARK])]));

    const mounted = mountOpener();

    expect(fake.surfaceOpen).toHaveBeenLastCalledWith(
      PARKED_PAGE,
      LIVE_PARK,
      "Sign in to Example",
    );
    expect(fake.openPage).toHaveBeenCalledTimes(1);
    expect(mounted.spoken.map((item) => item.text)).toEqual([OPEN_IN_TASK]);
    expect(mounted.onSurfaceOpened).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("opens the task and says so when the stream holds no matching park", () => {
    serve(snapshotOf([task([])]));

    const mounted = mountOpener();

    expect(fake.surfaceOpen).toHaveBeenLastCalledWith(
      PARKED_PAGE,
      null,
      "Sign in to Example",
    );
    expect(fake.openPage).toHaveBeenCalledTimes(1);
    expect(mounted.spoken.map((item) => item.text)).toEqual([TASK_OPEN]);
  });

  it("waits for the stream's snapshot, then opens once on the park it holds", () => {
    const mounted = mountOpener();
    expect(fake.openPage).not.toHaveBeenCalled();
    expect(mounted.spoken).toEqual([]);

    mounted.serveAndRender(snapshotOf([task([LIVE_PARK])]));

    expect(fake.openPage).toHaveBeenCalledTimes(1);
    expect(fake.surfaceOpen).toHaveBeenLastCalledWith(
      PARKED_PAGE,
      LIVE_PARK,
      "Sign in to Example",
    );
    expect(mounted.spoken.map((item) => item.text)).toEqual([OPEN_IN_TASK]);
  });

  it("opens the task without a park when the stream never answers within the wait", () => {
    const mounted = mountOpener();

    act(() => {
      vi.advanceTimersByTime(PARK_READ_TIMEOUT_MS - 1);
    });
    expect(fake.openPage).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(fake.openPage).toHaveBeenCalledTimes(1);
    expect(fake.surfaceOpen).toHaveBeenLastCalledWith(
      PARKED_PAGE,
      null,
      "Sign in to Example",
    );
    expect(mounted.spoken.map((item) => item.text)).toEqual([TASK_OPEN]);
  });
});
