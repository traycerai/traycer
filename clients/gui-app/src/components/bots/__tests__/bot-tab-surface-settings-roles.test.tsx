/**
 * A team bot's settings by the reader's role. The tab opens the real settings
 * panel, and the panel is told whether the reader may change the bot's
 * environment by the tab's own rule over the environment list: the Model
 * group and Delete are drawn for an owner of Personal, an Admin or an Editor,
 * not for a Viewer or a team the list does not hold, and are drawn as before
 * until the list answers. The environment list is scripted at the boundary
 * the other tab cases script it at; the rule, the tab and the panel are real.
 */
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botSubscriptionMock,
  botThreadListQueryMock,
  connectableHostIdsMock,
  environmentListMock,
  environmentMembersMock,
  hostDirectoryListMock,
  hostEnvironmentBindingsMock,
  cloudEpicTasksMock,
  epicTaskContextsMock,
  hostClientForHostIdMock,
  hostQueriesMock,
  hostSupportsMethodMock,
  botMutationsMock,
  mocks,
  notificationHostMock,
  tabHostClientMock,
  tabHostProviderMock,
  tabNavigationMock,
} from "./bot-tab-surface-mocks";
import { emptyBotMentionHostListsMock } from "@/components/bots/__tests__/bot-mention-host-test-support";
import { StrictMode, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { BotUpdateRunSettingsRequest } from "@traycer/protocol/host/bot/schemas";
import type { LastFailedAttempt } from "@traycer/protocol/host/agent/gui/subscribe";
import { ManualRungActions } from "@/components/chat/fallback/fallback-manual-rungs";
import {
  FAILED_CLAUDE_TUPLE,
  lastFailedAttempt,
} from "@/components/chat/fallback/__tests__/fallback-fixtures";
import type { ComposerSeedSource } from "@/lib/composer/composer-seed-source";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  BOT,
  BOT_ID,
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  snapshot,
  TAB_HOST,
} from "./bot-tab-surface-harness";

// What the panel's own boundaries answer, and what its Apply was sent.
const panel = vi.hoisted(() => ({
  stores: [] as ComposerToolbarStore[],
  applied: [] as object[],
  /** What a write of the run settings is refused with; `null` is accepted. */
  runSettingsRefusal: null as Error | null,
}));

// The failed turn's card reads the chat's session store; the tab's channel
// view below draws the real card for it.
const failed = vi.hoisted(() => {
  type Slice = {
    lastFailedAttempt: LastFailedAttempt | undefined;
    access: { readonly canAct: boolean };
    connectionStatus: "open";
    chat: null;
    publishConfirmedManualFallbackAction: () => void;
    publishUnattendedFallbackOutcome: () => void;
  };
  let state: Slice = {
    lastFailedAttempt: undefined,
    access: { canAct: true },
    connectionStatus: "open",
    chat: null,
    publishConfirmedManualFallbackAction: () => undefined,
    publishUnattendedFallbackOutcome: () => undefined,
  };
  const listeners = new Set<() => void>();
  return {
    shown: false,
    store: {
      getState: (): Slice => state,
      getInitialState: (): Slice => state,
      setState: (next: Partial<Slice>): Slice => {
        state = { ...state, ...next };
        for (const listener of listeners) listener();
        return state;
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
});

vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
vi.mock(
  "@/hooks/epic/use-epic-get-task-contexts-query",
  () => epicTaskContextsMock,
);
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", async (importOriginal) =>
  cloudEpicTasksMock(
    await importOriginal<
      typeof import("@/hooks/epics/use-cloud-epic-tasks-query")
    >(),
  ),
);
vi.mock("@/hooks/host/use-host-supports-method", () => hostSupportsMethodMock);
vi.mock(
  "@/hooks/notifications/use-notification-host",
  () => notificationHostMock,
);
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => hostClientForHostIdMock,
);
vi.mock("@/hooks/host/use-host-queries", () => hostQueriesMock);
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable" }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
  useHostClient: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-defaults")
  >()),
  useSandboxDefaults: (environmentIds: readonly string[]) =>
    new Map(environmentIds.map((id) => [id, mocks.sandboxDefaults])),
}));
vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  () => hostEnvironmentBindingsMock,
);
vi.mock(
  "@/hooks/bots/use-environment-members-query",
  () => environmentMembersMock,
);
vi.mock(
  "@/components/epic-canvas/tab-host-provider",
  () => tabHostProviderMock,
);
vi.mock("@/hooks/host/use-tab-host-client", () => tabHostClientMock);
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => TAB_HOST,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
  }),
);
vi.mock("@/hooks/bots/use-bot-memory", () => botMemoryMock);
vi.mock("@/hooks/bots/use-bot-subscription", () => botSubscriptionMock);
vi.mock("@/hooks/host/use-connectable-host-ids", () => connectableHostIdsMock);
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  () => hostDirectoryListMock,
);
vi.mock("@/hooks/bots/use-bot-list-query", () => botListQueryMock);
vi.mock(
  "@/hooks/bots/use-bot-list-changed-subscription",
  () => botListChangedMock,
);
vi.mock("@/hooks/bots/use-environment-list-query", () => environmentListMock);
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => botThreadListQueryMock);

// The tab's other views are other suites' subjects; only the panel is real.
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: () => null,
}));
// The real card of the failed turn is drawn where the channel would draw it: for
// the bot's own chat (its id is the epic id, as `bot-failed-recovery.tsx` passes
// it), and for a chat that is not a bot's.
vi.mock("@/components/bots/bot-channel-view", () => ({
  BotChannelView: (props: {
    botId: string;
    hostId: string;
    trunkChatId: string;
  }) =>
    failed.shown ? (
      <>
        <div data-testid="bot-failed-card">
          <ManualRungActions
            turnId={FAILED_TURN_ID}
            epicId={props.botId}
            chatId={props.trunkChatId}
            hostId={props.hostId}
          />
        </div>
        <div data-testid="other-chat-failed-card">
          <ManualRungActions
            turnId={FAILED_TURN_ID}
            epicId="epic-not-a-bot"
            chatId="chat-not-a-bot"
            hostId={props.hostId}
          />
        </div>
      </>
    ) : null,
}));
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: () => null,
}));
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: () => null,
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: () => null,
}));

// The failed-turn card's own boundaries, as its suite
// (`fallback-manual-rungs.test.tsx`) doubles them.
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));
vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/chat/fallback/fallback-identity")
    >()),
    useFallbackModelLabels: () => (_harnessId: string, model: string) => model,
  }),
);
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionHandle: () => ({ store: failed.store }),
}));
vi.mock("@/hooks/use-mutation-state-of", () => ({
  useIsMutatingOf: () => 0,
}));
vi.mock("@/components/chat/fallback/routing-destination-picker", () => ({
  RoutingDestinationPicker: (props: { triggerLabel: string }) => (
    <button type="button">{props.triggerLabel}</button>
  ),
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ label: "Studio" }),
}));
vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

// The panel's own boundaries.
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  ...botMutationsMock,
  useBotUpdateTitleMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
  useBotDeleteMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
  useBotUpdateRunSettingsMutation: () => {
    const [error, setError] = useState<Error | null>(null);
    return {
      isPending: false,
      error,
      mutate: (variables: BotUpdateRunSettingsRequest): void => {
        panel.applied.push(variables);
        setError(panel.runSettingsRefusal);
      },
    };
  },
  useBotUpdateReplyModeMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
  useBotUpdateAppearanceMutation: () => ({
    isPending: false,
    isError: false,
    variables: undefined,
    error: null,
    mutate: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-notification-level", () => ({
  useBotNotificationLevelsQuery: () => ({ data: undefined, error: null }),
  useBotNotificationLevelSetMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
}));
vi.mock("@/hooks/usage-analytics/use-usage-summary-support", () => ({
  useUsageSummarySupported: () => false,
}));
vi.mock("@/components/epic-canvas/panels/epic-usage-dialog", () => ({
  EpicUsageDialog: () => null,
}));
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div data-testid="stub-harness-model-picker" />,
}));
vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createComposerToolbarStore } =
    await import("@/stores/composer/composer-toolbar-store");
  return {
    useComposerToolbarStore: (
      _registerAs: string | null,
      seedSource: ComposerSeedSource,
    ): ComposerToolbarStore => {
      const [store] = useState(() => {
        const settings =
          seedSource.kind === "none" ? null : seedSource.settings;
        return createComposerToolbarStore({
          purpose: "run",
          reasoningFallback: "model-default",
          seedKey: "bot-tab-settings-roles-test",
          values: {
            ultracode: false,
            permission: settings?.permissionMode ?? "supervised",
            selection: {
              harnessId: settings?.harnessId ?? "codex",
              modelSlug: settings?.model ?? "model-a",
              profileId: settings?.profileId ?? null,
            },
            reasoning: settings?.reasoningEffort ?? "",
            serviceTier: "",
          },
          onSettingsChange: null,
          tuiOnly: false,
          chatLineCarriesAutoMode: null,
          ultracodeCarried: false,
          hostId: "host-1",
        });
      });
      panel.stores.push(store);
      return store;
    },
  };
});

import { BotTabSurface } from "@/components/bots/bot-tab-surface";

const FAILED_TURN_ID = "turn-failed";
const RESETS_AT = new Date(2026, 5, 15, 15, 0, 0).getTime();

let queryClient = new QueryClient();

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  resetBotTabSurfaceMocks();
  panel.stores.length = 0;
  panel.applied.length = 0;
  panel.runSettingsRefusal = null;
  failed.shown = false;
  failed.store.setState({ lastFailedAttempt: undefined });
});

afterEach(() => {
  endBotTabSurfaceCase(queryClient);
});

/** The bot's environment as the environment list answers it for this reader. */
function listAnswers(
  ownerKind: "organization" | "user",
  effectiveRole: "owner" | "admin" | "editor" | "viewer",
  environmentId: string,
): void {
  const rows = [
    {
      environmentId,
      label: ownerKind === "user" ? "Personal" : "Acme",
      ownerKind,
      providerHandle: ownerKind === "user" ? null : "acme",
      effectiveRole,
    },
  ];
  mocks.state.environments = rows;
}

function ownBot(environmentId: string): void {
  mocks.state.snapshot = {
    ...snapshot(),
    bot: { ...BOT, environmentId },
  };
}

async function openSettings(): Promise<HTMLElement> {
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
      </QueryClientProvider>
    </StrictMode>,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Channel settings" }),
  );
  return screen.findByTestId("bot-channel-settings");
}

describe("a bot's settings panel by the reader's role", () => {
  it("draws a team's Viewer no Model group and no Delete", async () => {
    listAnswers("organization", "viewer", "env-team");

    const settings = await openSettings();

    expect(within(settings).queryByTestId("bot-settings-model")).toBeNull();
    expect(within(settings).queryByTestId("bot-settings-delete")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("draws a team's Editor the Model group with Apply, and Delete", async () => {
    listAnswers("organization", "editor", "env-team");

    const settings = await openSettings();

    expect(within(settings).getByTestId("bot-settings-model")).toBeTruthy();
    expect(
      within(settings).getByRole("button", { name: "Apply" }),
    ).toBeTruthy();
    expect(within(settings).getByTestId("bot-settings-delete")).toBeTruthy();
  });

  it("draws a personal bot's owner the Model group, Delete and the reply mode", async () => {
    listAnswers("user", "owner", "env-personal");
    ownBot("env-personal");

    const settings = await openSettings();

    expect(within(settings).getByTestId("bot-settings-model")).toBeTruthy();
    expect(within(settings).getByTestId("bot-settings-delete")).toBeTruthy();
    expect(
      within(settings).getByTestId("bot-settings-reply-mode"),
    ).toBeTruthy();
  });

  // A list still being read shows the tab's connecting view and no panel; a
  // list that failed with the bot listed leaves the tab open on it, with no
  // answer for the panel to go by.
  it("draws the Model group and Delete, and no reply mode, while the list has not answered", async () => {
    mocks.state.environmentsStatus = "error";
    mocks.state.environmentsKept = false;

    const settings = await openSettings();

    expect(within(settings).getByTestId("bot-settings-model")).toBeTruthy();
    expect(within(settings).getByTestId("bot-settings-delete")).toBeTruthy();
    expect(
      within(settings).queryByTestId("bot-settings-reply-mode"),
    ).toBeNull();
  });

  it("draws neither when the list answered without the bot's environment", async () => {
    listAnswers("organization", "admin", "env-other");

    const settings = await openSettings();

    expect(within(settings).queryByTestId("bot-settings-model")).toBeNull();
    expect(within(settings).queryByTestId("bot-settings-delete")).toBeNull();
  });

  it("leaves a Viewer the Name form and the Notifications section", async () => {
    listAnswers("organization", "viewer", "env-team");

    const settings = await openSettings();

    const name = within(settings).getByRole("textbox", { name: "Name" });
    expect(name).toBeTruthy();
    expect(name).toHaveProperty("disabled", false);
    expect(within(settings).getByTestId("bot-settings-title")).toBeTruthy();
    expect(
      within(settings).getByTestId("bot-settings-notifications"),
    ).toBeTruthy();
  });

  it("shows an Editor the refusal under the control when the host refuses the write", async () => {
    listAnswers("organization", "editor", "env-team");
    panel.runSettingsRefusal = new HostRpcError({
      code: "E_ROLE_FORBIDDEN",
      message: "Your role no longer lets you change this bot.",
      requestId: "req-bot-run-settings",
      method: "bot.updateRunSettings",
      fatalDetails: null,
    });
    const settings = await openSettings();
    const store = panel.stores.at(-1);
    if (store === undefined) throw new Error("no toolbar store was created");
    act(() => {
      store.getState().setSelection({
        harnessId: "claude",
        modelSlug: "another-model",
        profileId: null,
      });
    });

    await userEvent.click(
      within(settings).getByRole("button", { name: "Apply" }),
    );

    expect(panel.applied).toHaveLength(1);
    expect(
      within(within(settings).getByTestId("bot-settings-model")).getByText(
        "Your role no longer lets you change this bot.",
      ),
    ).toBeTruthy();
  });
});

describe("a bot's failed turn by the reader's role", () => {
  function failTurn(): void {
    failed.shown = true;
    failed.store.setState({
      lastFailedAttempt: lastFailedAttempt({
        userMessageId: "user-message-failed",
        turnId: FAILED_TURN_ID,
        failure: {
          reason: "rate_limit",
          resetsAt: RESETS_AT,
          resetsAtSource: "provider",
        },
        eligibleRungs: ["retry", "switch", "wait_once"],
        waitDisposition: "eligible",
        switchDisposition: "eligible",
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
  }

  async function mountTab(): Promise<void> {
    failTurn();
    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
        </QueryClientProvider>
      </StrictMode>,
    );
    await screen.findByTestId("bot-failed-card");
  }

  function buttonLabels(testId: string): string[] {
    return within(screen.getByTestId(testId))
      .getAllByRole("button")
      .map((button) => button.textContent);
  }

  it("offers a team's Viewer Retry and Wait until, and no Switch to…", async () => {
    listAnswers("organization", "viewer", "env-team");

    await mountTab();

    expect(buttonLabels("bot-failed-card")).toEqual([
      expect.stringMatching(/^Wait until /),
      "Retry",
    ]);
  });

  it("offers a team's Editor Switch to…", async () => {
    listAnswers("organization", "editor", "env-team");

    await mountTab();

    expect(buttonLabels("bot-failed-card")).toContain("Switch to…");
  });

  it("offers Switch to… while the environment list has not answered", async () => {
    mocks.state.environmentsStatus = "error";
    mocks.state.environmentsKept = false;

    await mountTab();

    expect(buttonLabels("bot-failed-card")).toContain("Switch to…");
  });

  it("leaves a chat that is not the bot's own its Switch to… for the same Viewer", async () => {
    listAnswers("organization", "viewer", "env-team");

    await mountTab();

    expect(buttonLabels("bot-failed-card")).not.toContain("Switch to…");
    expect(buttonLabels("other-chat-failed-card")).toContain("Switch to…");
  });
});
