/**
 * What `bot-tab-surface.test.tsx` and `team-setup-channel.test.tsx` share
 * besides the mocked boundaries in `bot-tab-surface-mocks.tsx`: the fixtures,
 * the new-team setup and the per-case reset.
 */
import { cleanup } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { vi } from "vitest";
import { useAuthStore } from "@/stores/auth/auth-store";
import type {
  SandboxCatalogueFetchResult,
  TraycerModelsFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import { createFakeSandboxBinding } from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import type {
  BotOpenResponse,
  BotRecord,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { BotOnboardingSetup } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";
import { __resetAgentActivityStoreForTests } from "@/stores/agent-activity-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useTeamCloudCreateStore } from "@/stores/bots/team-cloud-create-store";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";
import { EMPTY_DIRECTORY_STATE } from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { mocks, type OpenResult } from "./bot-tab-surface-mocks";

export const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

export const OTHER_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
/** The id a new team's main bot will be created under. */
export const SETUP_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAX";
/** The team's main bot, still to be set up, as the onboarding read names it. */
export const NEEDS_HOST_SETUP: BotOnboardingSetup = {
  botId: SETUP_BOT_ID,
  title: "Tracy",
  state: "needs_host",
  arrival: null,
};
export const TAB_HOST = "host-tab";
export const BOUND_HOST = "host-bound";
/** A model a team sandbox runs. */
const TRAYCER_MODEL: GuiAgentModelOption = {
  harnessId: "traycer",
  slug: "first-model",
  label: "First model",
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  defaultReasoningEffort: null,
  supportedReasoningEfforts: [],
  defaultServiceTier: null,
  supportedServiceTiers: [],
  metadata: {},
};
/** One provider in one region, with room for the team's default shape. */
const CATALOGUE: SandboxCatalogue = {
  providers: [
    {
      provider: "tensorlake",
      os: ["linux"],
      shape: {
        cpuMin: 1,
        cpuMax: 16,
        cpuStep: 1,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        memoryMinMb: 1024,
        memoryMaxMb: 65536,
        memoryStepMb: 512,
        diskMinMb: 10240,
        diskMaxMb: 102400,
        diskDefaultMb: 20480,
      },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      shapes: null,
      dockerInGuest: true,
      creatable: true,
      notCreatableReason: null,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
          pricing: null,
        },
      ],
    },
  ],
};

export const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-team",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  trunkChatId: "trunk-1",
  boundHostId: BOUND_HOST,
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: "conversation-app",
};

export function snapshot(): BotSubscriptionSnapshot {
  return {
    bot: BOT,
    tasks: [],
    openRequestCount: 0,
    conversationsRevision: null,
    notificationSubscriptions: null,
    surfaceActions: null,
    stoppedNotificationWatches: null,
    boundHost: { hostId: BOUND_HOST, epoch: 1, isThisHost: false },
    activity: null,
  };
}

export function trackingTask(taskId: string): BotTaskEntry {
  return {
    taskId,
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
    inputNeeded: null,
    pause: null,
    stop: null,
    runRequest: null,
  };
}

export function answer(outcome: BotOpenResponse["outcome"]): OpenResult {
  return { kind: "answer", response: { bot: BOT, outcome } };
}

/** The surface open on `botId` with a draft kept for it, as an opener leaves it. */
function openSurfaceOn(botId: string): void {
  useTracySurfaceStore.setState({
    open: true,
    hostId: TAB_HOST,
    botId,
    visitedBotIds: [],
  });
  useBotDraftsStore.getState().typeThreadBox(botId, "post-1", "unsent", null);
}

/**
 * A tab on a team's main bot before the bot exists: the team (`env-new`) has
 * no bot of its own, another team's bot is the only one listed, and the tab
 * is open as the sidebar's row would have opened it.
 */
export function setUpNewTeam(): void {
  mocks.state.environments = [
    {
      environmentId: "env-team",
      label: "Acme",
      ownerKind: "organization",
      providerHandle: "acme",
    },
    {
      environmentId: "env-new",
      label: "Newco",
      ownerKind: "organization",
      providerHandle: "newco",
    },
  ];
  mocks.state.listedBotIds = [BOT_ID];
  openSurfaceOn(SETUP_BOT_ID);
}

/** The configuration's defaults for a team's sandbox: the built-in shape. */
const TEAM_DEFAULTS = {
  os: "linux",
  cpus: 4,
  memoryMb: 8192,
  diskMb: 40960,
  idleMinutes: 45,
  restingMinutes: 1_440,
} as const;

/**
 * The control plane a new team's setup card reads and creates through: one
 * provider with room for the team's default shape, a model a team sandbox
 * runs, no sandboxes listed, and a signed-in viewer. A mint answers a
 * network error until a case scripts it.
 */
export function scriptTeamControlPlane(): void {
  const base = createFakeSandboxBinding();
  mocks.binding = {
    ...base,
    auth: {
      ...base.auth,
      getTraycerModels: vi.fn(() =>
        Promise.resolve<TraycerModelsFetchResult>({
          kind: "ok",
          models: [TRAYCER_MODEL],
        }),
      ),
      getSandboxCatalogue: vi.fn(() =>
        Promise.resolve<SandboxCatalogueFetchResult>({
          kind: "ok",
          catalogue: CATALOGUE,
        }),
      ),
    },
  };
  mocks.sandboxDefaults = {
    kind: "ready",
    value: { defaults: TEAM_DEFAULTS, revision: 3 },
  };
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-viewer", username: "olive" },
  });
}

/** Every mocked boundary and store back at its start, with the surface open on `BOT_ID`. */
export function resetBotTabSurfaceMocks(): void {
  vi.clearAllMocks();
  mocks.changeListeners.clear();
  mocks.binding = null;
  mocks.sandboxDefaults = { kind: "pending" };
  mocks.supportQueries.length = 0;
  mocks.taskContexts = new Map();
  mocks.homeTasks = [];
  mocks.taskReads.contextsPending = false;
  mocks.taskReads.homePending = false;
  mocks.taskReads.homeRefused = false;
  mocks.membersQueries.length = 0;
  mocks.state.membersSupport = true;
  mocks.state.snapshot = snapshot();
  mocks.state.deleted = false;
  mocks.state.error = null;
  mocks.state.paneVisible = true;
  mocks.state.connectable = { hostIds: [TAB_HOST, BOUND_HOST], resolved: true };
  // The bot is listed, in a team that has bots: nothing is to be set up.
  mocks.state.listedBotIds = [BOT_ID];
  mocks.state.listTitles = new Map([[BOT_ID, "Release Bot"]]);
  mocks.state.listAppearance = new Map();
  mocks.state.mainBotIds = null;
  mocks.state.support = true;
  mocks.state.onboardingSupport = true;
  mocks.state.onboardingVersion = { major: 1, minor: 1 };
  mocks.state.readAt = 1_000;
  mocks.state.readsCached = false;
  mocks.state.listFailed = false;
  mocks.state.environmentsStatus = "success";
  mocks.state.environmentsKept = false;
  mocks.state.list = {
    dataUpdatedAt: 1_000,
    errorUpdatedAt: 0,
    isFetchedAfterMount: true,
    isFetching: false,
  };
  mocks.readRefetch.mockReset();
  mocks.listRefetch.mockReset();
  mocks.environmentsRefetch.mockReset();
  mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
  mocks.state.environments = [
    { environmentId: "env-team", label: "Acme", ownerKind: "organization" },
  ];
  mocks.state.threads = [];
  mocks.state.threadsHeld = true;
  mocks.state.threadsFetching = false;
  mocks.state.threadsError = false;
  mocks.subscribed.length = 0;
  for (const key of Object.keys(mocks.reads)) delete mocks.reads[key];
  useSelectionAuthorityStore.setState({ effectiveHostId: TAB_HOST });
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {}, unsentBoxes: {} });
  useBotOpenThreadStore.setState({ byBotId: {} });
  useTeamCloudCreateStore.setState({ byEnvironmentId: {} });
  __resetAgentActivityStoreForTests();
  mocks.unreadTaskIds.clear();
  mocks.indicatorAnswers.clear();
  openSurfaceOn(BOT_ID);
}

const AUTH_AT_START = useAuthStore.getState();

/** Unmounts, drops the query cache, and leaves no one signed in for the next case. */
export function endBotTabSurfaceCase(queryClient: QueryClient): void {
  cleanup();
  queryClient.clear();
  useStandaloneBotsStore.setState(EMPTY_DIRECTORY_STATE);
  // A case that signs a viewer in leaves no one signed in for the next.
  useAuthStore.setState({
    profile: null,
    status: AUTH_AT_START.status,
    contextMetadata: AUTH_AT_START.contextMetadata,
  });
}
