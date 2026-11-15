import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  skipToken,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotRecord,
  BotUpdateReplyModeRequest,
  BotUpdateRunSettingsRequest,
} from "@traycer/protocol/host/bot/schemas";
import type {
  BotDeleteResult,
  BotSetupRow,
  BotSetupWriteResult,
} from "@traycer-clients/shared/host-client/bot-setup";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentTransportRequest } from "@traycer-clients/shared/environment/environment-cloud";
import type { ComposerSeedSource } from "@/lib/composer/composer-seed-source";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";
import { createAppQueryClient } from "@/lib/query-client";
import { botThreadListParams } from "@/hooks/bots/use-bot-thread-list-query";
import { botQueryKeys } from "@/lib/query-keys/bot-query-keys";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const USER_BEARER = "verified-person-bearer";
const TAB_HOST_ID = "host-asleep";
const BOT_SNAPSHOT_KEY = botQueryKeys.subscription({
  hostId: TAB_HOST_ID,
  botId: BOT_ID,
});

const harness = vi.hoisted(() => ({
  binding: {
    current: null as {
      readonly auth: {
        readonly updateBotRunSettings: (
          request: BotUpdateRunSettingsRequest,
        ) => Promise<BotSetupWriteResult>;
        readonly updateBotReplyMode: (
          request: BotUpdateReplyModeRequest,
        ) => Promise<BotSetupWriteResult>;
        readonly deleteBot: (request: {
          readonly botId: string;
        }) => Promise<BotDeleteResult>;
      };
    } | null,
  },
  tabClient: null as HostClient<HostRpcRegistry> | null,
  environmentList: undefined as EnvironmentListResponseV11 | undefined,
  stores: [] as ComposerToolbarStore[],
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostBinding: () => harness.binding.current,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => harness.tabClient,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => TAB_HOST_ID,
}));

vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: harness.environmentList }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => false,
}));

vi.mock("@/hooks/usage-analytics/use-usage-summary-support", () => ({
  useUsageSummarySupported: () => false,
}));

vi.mock("@/hooks/bots/use-bot-memory", () => ({
  useBotMemory: () => ({ kind: "unsupported" }),
}));

vi.mock("@/components/epic-canvas/panels/epic-usage-dialog", () => ({
  EpicUsageDialog: () => null,
}));

vi.mock("@/components/bots/bot-appearance-settings", () => ({
  BotAppearanceSettings: () => null,
}));

vi.mock("@/components/bots/bot-slack-settings", () => ({
  BotSlackSettings: () => null,
}));

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: (props: {
    readonly disabled: boolean;
    readonly store: ComposerToolbarStore;
  }) => (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() =>
        props.store.getState().setSelection({
          harnessId: "claude",
          modelSlug: "model-c",
          profileId: "profile-1",
        })
      }
    >
      Choose another model
    </button>
  ),
}));

vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createComposerToolbarStore } =
    await import("@/stores/composer/composer-toolbar-store");
  return {
    useComposerToolbarStore: (
      _registerAs: string | null,
      seedSource: ComposerSeedSource,
      _onSettingsChange: ((settings: object) => void) | null,
      scope: {
        readonly hostId: string | null;
        readonly tuiOnly: boolean;
        readonly chatLineCarriesAutoMode: boolean | null;
        readonly ultracodeCarried: boolean;
      },
    ): ComposerToolbarStore => {
      const settings = seedSource.kind === "none" ? null : seedSource.settings;
      const harnessId = settings?.harnessId ?? "claude";
      const modelSlug = settings?.model ?? "model-a";
      const profileId = settings?.profileId ?? null;
      const reasoning = settings?.reasoningEffort ?? "";
      const values = useMemo(
        () => ({
          ultracode: false,
          permission: "supervised" as const,
          selection: { harnessId, modelSlug, profileId },
          reasoning,
          serviceTier: "",
        }),
        [harnessId, modelSlug, profileId, reasoning],
      );
      const seedKey = JSON.stringify(values.selection);
      const [store] = useState(() =>
        createComposerToolbarStore({
          purpose: "run",
          reasoningFallback: "model-default",
          seedKey,
          values,
          onSettingsChange: null,
          tuiOnly: scope.tuiOnly,
          hostId: scope.hostId,
          chatLineCarriesAutoMode: scope.chatLineCarriesAutoMode,
          ultracodeCarried: scope.ultracodeCarried,
        }),
      );
      useLayoutEffect(() => {
        store.getState().applySeed(seedKey, values);
      }, [seedKey, store, values]);
      harness.stores.push(store);
      return store;
    },
  };
});

import { BotChannelSettingsPanel } from "@/components/bots/bot-settings-panel";

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-personal",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "model-b",
  effort: "high",
  profile: "profile-1",
  trunkChatId: "trunk-1",
  boundHostId: TAB_HOST_ID,
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: null,
};

const INITIAL_SETUP_ROW: BotSetupRow = {
  botId: BOT_ID,
  harness: BOT.harness,
  model: BOT.model,
  effort: BOT.effort,
  profile: BOT.profile,
  replyMode: BOT.replyMode,
};

function botSnapshot(bot: BotRecord): BotSubscriptionSnapshot {
  return {
    bot,
    tasks: [],
    openRequestCount: 0,
    conversationsRevision: 0,
    boundHost: { hostId: TAB_HOST_ID, epoch: 1, isThisHost: true },
    activity: null,
    notificationSubscriptions: null,
    surfaceActions: null,
    stoppedNotificationWatches: null,
  };
}

function personalEnvironmentList(): EnvironmentListResponseV11 {
  return {
    environments: [
      {
        environmentId: BOT.environmentId,
        ownerKind: "user",
        ownerId: "user-1",
        roomId: "room-personal",
        label: "Personal",
        effectiveRole: "owner",
        kind: "personal",
        hostCount: 1,
        providerHandle: null,
      },
    ],
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signedInProfileResponse(): Response {
  return response(200, {
    user: {
      id: "user-1",
      name: "Test User",
      providerId: "gh-1",
      providerHandle: "test-user",
      providerType: "GITHUB",
      email: "test@example.com",
      avatarUrl: null,
      activatedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      lastSeenAt: null,
      privacyMode: false,
      isLearningEnabled: true,
    },
    userSubscription: {
      id: "sub-1",
      userID: "user-1",
      orgID: null,
      teamID: null,
      customerId: "cus-1",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus: "FREE",
      hasPaymentMethod: false,
      isInTrial: false,
      rechargeRateSeconds: 0,
    },
    teamSubscriptions: [],
    payAsYouGoUsage: { allowPayAsYouGo: false },
  });
}

function listKey(hostId: string) {
  return hostQueryKeys.method<HostRpcRegistry, "bot.list">(
    hostId,
    "bot.list",
    {},
  );
}

function PanelFromSnapshot(props: {
  readonly initialSnapshot: BotSubscriptionSnapshot;
  readonly onDeleted: () => void;
}): ReactNode {
  const query = useQuery(
    queryOptions<BotSubscriptionSnapshot>({
      queryKey: BOT_SNAPSHOT_KEY,
      queryFn: skipToken,
      initialData: props.initialSnapshot,
    }),
  );
  return (
    <BotChannelSettingsPanel
      bot={query.data.bot}
      mayChange
      personal
      channelId={null}
      environmentBots={null}
      onClose={() => undefined}
      onDeleted={props.onDeleted}
    />
  );
}

function hostAsleepClient(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
} {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "sleeping-host-request",
    handlers: {},
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "sleeping-host-bearer",
    }),
  );
  return { client: spine.createRequester(mockLocalHostEntry), messenger };
}

let queryClient: QueryClient;
let service: AuthService | null = null;
let restoreFetch: () => void = () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.getState().setSignedOut();
  queryClient = createAppQueryClient();
  harness.environmentList = personalEnvironmentList();
  harness.stores.length = 0;
  harness.tabClient = null;
  harness.binding.current = null;
});

afterEach(() => {
  cleanup();
  service?.dispose();
  service = null;
  harness.binding.current = null;
  harness.tabClient = null;
  queryClient.clear();
  useAuthStore.getState().setSignedOut();
  restoreFetch();
  restoreFetch = () => undefined;
  vi.unstubAllGlobals();
});

describe("bot settings controls with an unavailable tab host", () => {
  it("saves model and reply settings through the verified app session, then deletes without a host request", async () => {
    const requests: EnvironmentTransportRequest[] = [];
    let currentRow = INITIAL_SETUP_ROW;
    const answer = (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Response => {
      const url = requestUrl(input);
      if (!url.startsWith("https://server.test.invalid/")) {
        return signedInProfileResponse();
      }
      const headers = new Headers(init?.headers);
      const request: EnvironmentTransportRequest = {
        url,
        method: "POST",
        headers: Object.fromEntries(headers.entries()),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        signal: init?.signal ?? new AbortController().signal,
      };
      requests.push(request);
      if (url.endsWith("/api/bots/update-run-settings")) {
        currentRow = {
          ...currentRow,
          harness: "claude",
          model: "model-c",
          effort: "high",
          profile: "profile-1",
        };
        return response(200, { bot: currentRow });
      }
      if (url.endsWith("/api/bots/update-reply-mode")) {
        currentRow = { ...currentRow, replyMode: "direct" };
        return response(200, { bot: currentRow });
      }
      if (url.endsWith("/api/bots/delete")) {
        return response(200, {
          deleted: true,
          environmentId: BOT.environmentId,
          ownerDeletedNotices: [{ botId: BOT_ID, text: "bot deleted notice" }],
        });
      }
      return response(404, { error: "Unexpected test route" });
    };
    const fetchMock = vi.fn<typeof fetch>((input, init) =>
      Promise.resolve(answer(input, init)),
    );
    vi.stubGlobal("fetch", fetchMock);
    restoreFetch = () => vi.unstubAllGlobals();

    const runnerHost = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "https://authn.traycer.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    await runnerHost.tokenStore.signIn(
      { token: USER_BEARER, refreshToken: "refresh-token" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    service = new AuthService({ runnerHost });
    await service.start();
    expect(useAuthStore.getState().status).toBe("signed-in");
    harness.binding.current = { auth: service };

    const onDeleted = vi.fn();
    const snapshot = botSnapshot(BOT);
    const localList = listKey(TAB_HOST_ID);
    const secondList = listKey("host-other");
    queryClient.setQueryData(localList, { bots: [BOT], mainBotIds: {} });
    queryClient.setQueryData(secondList, { bots: [BOT], mainBotIds: {} });
    queryClient.setQueryData(BOT_SNAPSHOT_KEY, snapshot);
    // The Usage group's thread list (#3900) is read from the tab's host, which
    // is asleep here: the fixture answers it from the cache, so no request
    // reaches the host and the sweep below reads an answered entry.
    queryClient.setQueryData(
      hostQueryKeys.method<HostRpcRegistry, "bot.thread.list">(
        mockLocalHostEntry.hostId,
        "bot.thread.list",
        botThreadListParams(BOT_ID),
      ),
      {
        threads: [],
        trunkCostUsd: null,
        threadAnchors: null,
        nextCursor: null,
        total: 0,
      },
    );
    const tabHost = hostAsleepClient();
    harness.tabClient = tabHost.client;
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <PanelFromSnapshot initialSnapshot={snapshot} onDeleted={onDeleted} />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled"),
    ).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Choose another model" }),
    );
    expect(
      screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled"),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled"),
      ).toBe(true);
    });
    expect(
      queryClient.getQueryData<BotSubscriptionSnapshot>(BOT_SNAPSHOT_KEY)?.bot
        .model,
    ).toBe("model-c");

    await user.click(screen.getByRole("radio", { name: "In the channel" }));
    await waitFor(() => {
      expect(
        screen
          .getByRole("radio", { name: "In the channel" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    await user.click(screen.getByRole("button", { name: "Delete bot" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Delete bot" }),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));

    expect(requests.map((request) => request.url)).toEqual([
      "https://server.test.invalid/api/bots/update-run-settings",
      "https://server.test.invalid/api/bots/update-reply-mode",
      "https://server.test.invalid/api/bots/delete",
    ]);
    expect(
      requests.map((request) =>
        new Headers(request.headers).get("Authorization"),
      ),
    ).toEqual([
      `Bearer ${USER_BEARER}`,
      `Bearer ${USER_BEARER}`,
      `Bearer ${USER_BEARER}`,
    ]);
    expect(requests.map((request) => request.body)).toEqual([
      {
        botId: BOT_ID,
        harness: "claude",
        model: "model-c",
        effort: "high",
        profile: "profile-1",
      },
      { botId: BOT_ID, replyMode: "direct" },
      { botId: BOT_ID },
    ]);
    expect(queryClient.getQueryState(localList)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(secondList)?.isInvalidated).toBe(true);
    expect(tabHost.messenger.calls).toEqual([]);
    for (const cached of queryClient.getQueryCache().getAll()) {
      expect(JSON.stringify(cached.state.data)).not.toContain(
        "bot deleted notice",
      );
    }
  });
});
