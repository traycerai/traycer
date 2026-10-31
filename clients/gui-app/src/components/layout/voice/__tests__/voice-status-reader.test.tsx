import { cleanup, render } from "@testing-library/react";
import type {
  BotActivity,
  BotRecord,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { BotSubscriptionResult } from "@/hooks/bots/use-bot-subscription";
import type {
  VoiceQueueOwner,
  VoiceStatusRequest,
} from "@/hooks/voice/use-voice-queue-owner";
import { VoiceQueueSources } from "../voice-queue-feed";

const BOT_ID = "bot-1";

const fake = vi.hoisted(() => ({
  subscription: { value: null as BotSubscriptionResult | null },
}));

vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: (): BotSubscriptionResult => {
    if (fake.subscription.value === null) {
      throw new Error("the test gave no subscription");
    }
    return fake.subscription.value;
  },
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/usage-analytics/use-usage-summary-support", () => ({
  useUsageSummarySupported: () => false,
}));
vi.mock(
  "@/hooks/usage-analytics/use-usage-summary-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/usage-analytics/use-usage-summary-query")
    >()),
    useUsageSummaryForClient: () => ({ data: undefined, isError: false }),
  }),
);
vi.mock("@/hooks/bots/use-bot-activity-summary", () => ({
  useBotActivitySummary: () => ({ stopped: [], running: [] }),
}));

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-1",
  createdByUserId: "user-1",
  title: "CI bot",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  trunkChatId: "trunk-1",
  boundHostId: "host-a",
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: "chan-1",
};

const TRACKING_TASK: BotTaskEntry = {
  taskId: "task-1",
  cadence: { kind: "every", seconds: 3_600 },
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
  inputNeeded: null,
  pause: null,
  stop: null,
  runRequest: null,
};

const REPLYING: BotActivity = {
  trunk: {
    state: "replying",
    startedAt: 1_000,
    step: "Running the build",
    requestId: null,
    reason: null,
  },
  threads: {},
};

function subscription(
  state: Pick<BotSubscriptionResult, "error" | "deleted">,
): BotSubscriptionResult {
  return {
    snapshot: {
      bot: BOT,
      tasks: [TRACKING_TASK],
      openRequestCount: 0,
      conversationsRevision: null,
      notificationSubscriptions: null,
      surfaceActions: null,
      stoppedNotificationWatches: null,
      boundHost: { hostId: "host-a", epoch: 1, isThisHost: false },
      activity: REPLYING,
    },
    deleted: state.deleted,
    error: state.error,
    isPending: false,
    resubscribe: () => undefined,
  };
}

const REQUEST: VoiceStatusRequest = {
  seq: 1,
  botId: BOT_ID,
  hostId: "host-a",
  botTitle: "CI bot",
  delegationId: "d-1",
  sessionToken: 1,
  engineGeneration: 1,
};

let onStatusComposed: Mock<VoiceQueueOwner["onStatusComposed"]>;

/** An owner with no queue, so only the status reader mounts. */
function ownerAsking(): VoiceQueueOwner {
  return {
    queue: null,
    attention: { answers: [], prompts: { approvals: [], questions: [] } },
    hostOf: () => "host-a",
    bots: [],
    registerMark: () => undefined,
    voiceSwitch: { current: null },
    statusRequest: REQUEST,
    onStatusComposed,
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
}

beforeEach(() => {
  onStatusComposed = vi.fn<VoiceQueueOwner["onStatusComposed"]>();
});

afterEach(() => {
  cleanup();
  fake.subscription.value = null;
});

describe("the status reader of a bot", () => {
  it.each([
    ["whose stream closed for good", { error: "closed", deleted: false }],
    ["that was deleted", { error: null, deleted: true }],
  ])(
    "%s says nothing of the last snapshot's work, and does not wait out the timeout",
    (_name, state) => {
      fake.subscription.value = subscription(state);

      render(<VoiceQueueSources owner={ownerAsking()} />);

      expect(onStatusComposed).toHaveBeenCalledTimes(1);
      const text = onStatusComposed.mock.calls[0]?.[1] ?? "";
      expect(text).not.toContain("answering now");
      expect(text).not.toContain("It runs 1 task");
    },
  );

  it("whose stream is live says what the snapshot holds", () => {
    fake.subscription.value = subscription({ error: null, deleted: false });

    render(<VoiceQueueSources owner={ownerAsking()} />);

    expect(onStatusComposed).toHaveBeenCalledTimes(1);
    const text = onStatusComposed.mock.calls[0]?.[1] ?? "";
    expect(text).toContain("CI bot is answering now: Running the build.");
    expect(text).toContain("It runs 1 task");
  });
});
