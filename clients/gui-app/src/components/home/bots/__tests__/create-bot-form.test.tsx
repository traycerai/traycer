/**
 * The create-bot form (Tracy Bots): the person names the bot and picks its
 * model, never the machine. The app chooses the host (`chooseBotCreateHost`),
 * the form names none of them, and the create goes to the chosen host's own
 * client. When no host qualifies the form says what the bot needs and where to
 * set it up. The toolbar-store hook is replaced by one that builds a REAL
 * toolbar store, so the model the form submits is the production store's.
 */
import { StrictMode, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  botCreateRequestSchema,
  type BotCreateResponse,
} from "@traycer/protocol/host/bot/schemas";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentDescriptor,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import {
  DEFAULT_SELECTION,
  type ModelOption,
} from "@/components/home/data/landing-options";
import {
  maxModeListedFor,
  type MaxModeContext,
} from "@/components/home/data/model-max-mode";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  navigateToTabIntent: vi.fn(),
  createAsync: vi.fn<(variables: object) => Promise<BotCreateResponse>>(),
  /** The client each `useBotCreateMutation` call was given. */
  createClients: [] as Array<object | null>,
  /** The host id each `useHostClientForHostId` call asked for. */
  clientRequests: [] as Array<string | null>,
  advertisingQueries: [] as Array<{
    hostIds: ReadonlyArray<string>;
    method: string;
  }>,
  pickerDisabled: [] as boolean[],
  pickerContexts: [] as MaxModeContext[],
  stores: [] as ComposerToolbarStore[],
  initialModelSlug: "model-a" as string,
  initialHarnessId: "claude" as "claude" | "cursor",
  initialReasoning: "" as string,
  /**
   * Seed the toolbar store from the settings store's default selection, as the
   * real hook does when it is given no seed. Off keeps the fixed selection
   * above, which the other tests rely on.
   */
  seedFromSettings: false,
  /** The error `useBotCreateMutation` reports. */
  createError: null as Error | null,
  state: {
    localHostId: null as string | null,
    effectiveHostId: null as string | null,
    creatingHostIds: new Set<string>(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: mocks.navigateToTabIntent,
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => mocks.state.localHostId,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mocks.state.effectiveHostId,
}));
vi.mock("@/hooks/host/use-hosts-advertising-method", () => ({
  useHostsAdvertisingMethod: (
    hostIds: ReadonlyArray<string>,
    method: string,
  ) => {
    mocks.advertisingQueries.push({ hostIds, method });
    return mocks.state.creatingHostIds;
  },
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    mocks.clientRequests.push(hostId);
    return { stub: `client-for-${hostId}` };
  },
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotCreateMutation: (client: object | null) => {
    mocks.createClients.push(client);
    return {
      isPending: false,
      error: mocks.createError,
      mutateAsync: mocks.createAsync,
    };
  },
}));
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: (props: {
    disabled: boolean;
    maxModeContext: MaxModeContext;
  }) => {
    mocks.pickerDisabled.push(props.disabled);
    mocks.pickerContexts.push(props.maxModeContext);
    return <div data-testid="stub-harness-model-picker" />;
  },
}));
vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createComposerToolbarStore } =
    await import("@/stores/composer/composer-toolbar-store");
  return {
    useComposerToolbarStore: (): ComposerToolbarStore => {
      const [store] = useState(() =>
        createComposerToolbarStore({
          purpose: "run",
          reasoningFallback: "model-default",
          seedKey: "create-bot-form-test",
          values: {
            permission: "supervised",
            selection: mocks.seedFromSettings
              ? useSettingsStore.getState().defaultSelection
              : {
                  harnessId: mocks.initialHarnessId,
                  modelSlug: mocks.initialModelSlug,
                  profileId: null,
                },
            reasoning: mocks.initialReasoning,
            serviceTier: "",
          },
          onSettingsChange: null,
          tuiOnly: false,
          chatLineCarriesAutoMode: null,
          hostId: "host-1",
        }),
      );
      mocks.stores.push(store);
      return store;
    },
  };
});

import { CreateBotForm } from "@/components/home/bots/create-bot-form";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const TEAM_ENV = "env-team";
const PERSONAL_ENV = "env-personal";
const LOCAL = "host-local";
const EFFECTIVE = "host-effective";
const OTHER = "host-other";
const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function descriptor(environmentId: string): EnvironmentDescriptor {
  return {
    environmentId,
    ownerKind: environmentId === TEAM_ENV ? "organization" : "user",
    ownerId: "owner-1",
    roomId: `room-${environmentId}`,
    label: environmentId,
  };
}

function bindingFor(
  hostId: string,
  environmentId: string,
): EnvironmentHostBinding {
  return {
    hostId,
    environment: descriptor(environmentId),
    explicit: true,
    enrolledByUserId: "user-1",
    canUnbind: true,
  };
}

interface Mount {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly connectableHostIds: ReadonlyArray<string>;
  /** hostId -> environment id; absent = still being asked. */
  readonly bound: Readonly<Record<string, string>>;
  readonly failedHostIds: ReadonlyArray<string>;
}

function botCreateResponse(): BotCreateResponse {
  return {
    bot: {
      botId: BOT_ID,
      environmentId: TEAM_ENV,
      createdByUserId: "user-1",
      title: "Release Bot",
      harness: "claude",
      model: "model-a",
      effort: null,
      profile: null,
      trunkChatId: "trunk-1",
      boundHostId: LOCAL,
      hostEpoch: 1,
      createdAt: 1_000,
      archivedAt: null,
    },
    appConversationChatId: "conversation-1",
  };
}

const retryFailed = vi.fn<() => void>();
const onDone = vi.fn<() => void>();

function mountForm(input: Mount): void {
  const byHostId = new Map<string, EnvironmentHostBinding>();
  for (const [hostId, environmentId] of Object.entries(input.bound)) {
    byHostId.set(hostId, bindingFor(hostId, environmentId));
  }
  const environmentBindings: HostEnvironmentBindings = {
    byHostId,
    failedHostIds: input.failedHostIds,
    retryFailed,
  };
  render(
    <StrictMode>
      <CreateBotForm
        environmentId={input.environmentId}
        environmentLabel={input.environmentLabel}
        connectableHostIds={input.connectableHostIds}
        environmentBindings={environmentBindings}
        onDone={onDone}
      />
    </StrictMode>,
  );
}

const TEAM_WITH_LOCAL: Mount = {
  environmentId: TEAM_ENV,
  environmentLabel: "Acme",
  connectableHostIds: [LOCAL, EFFECTIVE, OTHER],
  bound: { [LOCAL]: TEAM_ENV, [EFFECTIVE]: TEAM_ENV, [OTHER]: TEAM_ENV },
  failedHostIds: [],
};

function submitButton(): HTMLButtonElement {
  const button = screen.getByTestId("create-bot-submit");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("the submit control is not a button");
  }
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClients.length = 0;
  mocks.clientRequests.length = 0;
  mocks.advertisingQueries.length = 0;
  mocks.pickerDisabled.length = 0;
  mocks.pickerContexts.length = 0;
  mocks.stores.length = 0;
  mocks.initialHarnessId = "claude";
  mocks.initialModelSlug = "model-a";
  mocks.initialReasoning = "";
  mocks.seedFromSettings = false;
  mocks.createError = null;
  mocks.state.localHostId = LOCAL;
  mocks.state.effectiveHostId = EFFECTIVE;
  mocks.state.creatingHostIds = new Set([LOCAL, EFFECTIVE, OTHER]);
  mocks.createAsync.mockImplementation(() =>
    Promise.resolve(botCreateResponse()),
  );
  useBotTabsStore.setState({ tabs: {} });
});

afterEach(() => {
  cleanup();
});

describe("<CreateBotForm /> names no machine", () => {
  it("has no Runs on field, no host select and no host label when a host is chosen", () => {
    mountForm(TEAM_WITH_LOCAL);

    const form = screen.getByTestId("create-bot-form");
    expect(form.textContent).not.toMatch(/Runs on|host-|Studio Mac|Laptop/i);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByTestId("create-bot-host")).toBeNull();
    expect(screen.queryByTestId("create-bot-no-host")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
    expect(screen.getByTestId("stub-harness-model-picker")).toBeTruthy();
  });

  it("asks the connectable hosts which of them advertise bot.create", () => {
    mountForm(TEAM_WITH_LOCAL);

    expect(mocks.advertisingQueries.at(-1)).toEqual({
      hostIds: [LOCAL, EFFECTIVE, OTHER],
      method: "bot.create",
    });
  });
});

describe("<CreateBotForm /> when no host qualifies", () => {
  it("says the bot needs a machine for the environment, where to set one up, and names no machine", () => {
    mocks.state.creatingHostIds = new Set();
    mountForm(TEAM_WITH_LOCAL);

    const notice = screen.getByTestId("create-bot-no-host");
    expect(notice.textContent).toBe(
      "This bot needs a machine that runs bots for Acme. Set one up in Settings.",
    );
    expect(screen.getByTestId("create-bot-form").textContent).not.toMatch(
      /Runs on|host-/i,
    );
    expect(screen.queryByTestId("create-bot-unchecked")).toBeNull();
  });

  it("says the same for a personal environment, with that environment's name", () => {
    mocks.state.creatingHostIds = new Set();
    mountForm({
      ...TEAM_WITH_LOCAL,
      environmentId: PERSONAL_ENV,
      environmentLabel: "Personal",
    });

    expect(screen.getByTestId("create-bot-no-host").textContent).toBe(
      "This bot needs a machine that runs bots for Personal. Set one up in Settings.",
    );
  });

  it("says nothing is runnable when every connectable host is bound to another environment", () => {
    mountForm({
      ...TEAM_WITH_LOCAL,
      bound: {
        [LOCAL]: PERSONAL_ENV,
        [EFFECTIVE]: PERSONAL_ENV,
        [OTHER]: PERSONAL_ENV,
      },
    });

    expect(screen.getByTestId("create-bot-no-host")).toBeTruthy();
  });

  it("cannot be submitted, and the model picker is held off, with no host chosen", async () => {
    const user = userEvent.setup();
    mocks.state.creatingHostIds = new Set();
    mountForm(TEAM_WITH_LOCAL);

    await user.type(screen.getByTestId("create-bot-title"), "Release Bot");

    expect(submitButton().disabled).toBe(true);
    expect(mocks.pickerDisabled.at(-1)).toBe(true);
    expect(mocks.createAsync).not.toHaveBeenCalled();
    // No host chosen: no client is named for the create.
    expect(mocks.createClients.at(-1)).toBeNull();
  });

  it("offers a way to ask again when some machines could not be checked, and names none of them", async () => {
    const user = userEvent.setup();
    mocks.state.creatingHostIds = new Set();
    mountForm({
      ...TEAM_WITH_LOCAL,
      bound: { [EFFECTIVE]: TEAM_ENV, [OTHER]: PERSONAL_ENV },
      failedHostIds: [LOCAL],
    });

    const unchecked = screen.getByTestId("create-bot-unchecked");
    expect(unchecked.textContent).toContain(
      "Some of your machines couldn't be checked.",
    );
    expect(unchecked.textContent).not.toMatch(/host-/);
    expect(retryFailed).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryFailed).toHaveBeenCalledTimes(1);
  });

  it("says it is still looking, not that none was found, while an earlier host is being asked", () => {
    mountForm({
      ...TEAM_WITH_LOCAL,
      bound: { [EFFECTIVE]: TEAM_ENV, [OTHER]: TEAM_ENV },
    });

    expect(screen.queryByTestId("create-bot-no-host")).toBeNull();
    expect(
      screen.getByText("Finding a machine that runs Acme's bots…"),
    ).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });
});

describe("<CreateBotForm /> create goes to the chosen host", () => {
  async function createBot(user: UserEvent): Promise<void> {
    await user.type(screen.getByTestId("create-bot-title"), "  Release Bot  ");
    await user.click(submitButton());
  }

  it("creates through this machine's client when it qualifies, then opens the tab bound to it", async () => {
    const user = userEvent.setup();
    mountForm(TEAM_WITH_LOCAL);

    expect(mocks.clientRequests.at(-1)).toBe(LOCAL);
    expect(mocks.createClients.at(-1)).toEqual({ stub: `client-for-${LOCAL}` });
    await createBot(user);

    expect(mocks.createAsync).toHaveBeenCalledTimes(1);
    expect(mocks.createAsync).toHaveBeenCalledWith({
      environmentId: TEAM_ENV,
      title: "Release Bot",
      harness: "claude",
      model: "model-a",
      effort: null,
      profile: null,
    });
    const record = lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID);
    expect(record?.hostId).toBe(LOCAL);
    expect(record?.title).toBe("Release Bot");
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("creates through the active host's client when this machine does not run the environment", async () => {
    const user = userEvent.setup();
    mountForm({
      ...TEAM_WITH_LOCAL,
      bound: { ...TEAM_WITH_LOCAL.bound, [LOCAL]: PERSONAL_ENV },
    });

    expect(mocks.createClients.at(-1)).toEqual({
      stub: `client-for-${EFFECTIVE}`,
    });
    await createBot(user);

    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)?.hostId).toBe(
      EFFECTIVE,
    );
  });

  it("creates through another bound host in host id order when neither this machine nor the active host qualifies", async () => {
    const user = userEvent.setup();
    mocks.state.creatingHostIds = new Set([OTHER]);
    mountForm(TEAM_WITH_LOCAL);

    expect(mocks.createClients.at(-1)).toEqual({
      stub: `client-for-${OTHER}`,
    });
    await createBot(user);

    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)?.hostId).toBe(
      OTHER,
    );
  });

  it("creates with a null profile when the toolbar is seeded from a default selection saved before profiles existed", async () => {
    const user = userEvent.setup();
    // The request the host parses: a missing `profile` fails here exactly as
    // it did in production, before the host ran anything.
    mocks.createAsync.mockImplementation((variables) =>
      Promise.resolve().then(() => {
        botCreateRequestSchema.parse(variables);
        return botCreateResponse();
      }),
    );
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: {
          defaultSelection: { harnessId: "claude", modelSlug: "model-a" },
        },
        version: 1,
      }),
    );
    try {
      await useSettingsStore.persist.rehydrate();
      mocks.seedFromSettings = true;
      mountForm(TEAM_WITH_LOCAL);
      await createBot(user);
    } finally {
      cleanup();
      window.localStorage.clear();
      useSettingsStore.setState({ defaultSelection: DEFAULT_SELECTION });
    }

    expect(mocks.createAsync).toHaveBeenCalledWith({
      environmentId: TEAM_ENV,
      title: "Release Bot",
      harness: "claude",
      model: "model-a",
      effort: null,
      profile: null,
    });
    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)?.hostId).toBe(
      LOCAL,
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("does not create for a blank name", async () => {
    const user = userEvent.setup();
    mountForm(TEAM_WITH_LOCAL);

    await user.type(screen.getByTestId("create-bot-title"), "   ");

    expect(submitButton().disabled).toBe(true);
  });
});

describe("<CreateBotForm /> failed create", () => {
  const CREATE_UNREACHED =
    "Couldn't create the bot right now. Check your connection, then try again.";
  const CREATE_OUTCOME_UNKNOWN =
    "The bot may have been created. Check your bots before you try again.";
  const CREATE_FAILED =
    "Couldn't create the bot. Try again, and report the problem if it keeps happening.";

  const transport = {
    requestId: "request-1",
    method: "bot.create",
  };

  // A session-level fatal, as `RemoteSession` rejects pending requests with.
  const sessionFatal = {
    code: "UNAUTHORIZED",
    reason: "credential revoked",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };

  it("shows a sentence, not the validation text, for a non-host error", () => {
    const parsed = botCreateRequestSchema.safeParse({
      environmentId: TEAM_ENV,
      title: "Release Bot",
      harness: "claude",
      model: "model-a",
      effort: null,
    });
    if (parsed.success) throw new Error("the request without a profile parsed");
    mocks.createError = parsed.error;
    mountForm(TEAM_WITH_LOCAL);

    expect(screen.getByRole("alert").textContent).toBe(CREATE_OUTCOME_UNKNOWN);
  });

  it.each([
    [
      "a request that never left",
      () =>
        new RetryableTransportError({
          ...transport,
          code: "RPC_ERROR",
          message: "socket closed",
          fatalDetails: null,
          replaySafetyFromKey: false,
        }),
      CREATE_UNREACHED,
    ],
    [
      "an abort before the request was sent",
      () =>
        new HostRequestAbortedError({
          ...transport,
          message: "aborted",
          mayHaveDispatched: false,
        }),
      CREATE_UNREACHED,
    ],
    [
      "the host refusing the request with a specific code",
      () =>
        new HostRpcError({
          ...transport,
          code: "FORBIDDEN",
          message: "not allowed",
          fatalDetails: null,
        }),
      CREATE_FAILED,
    ],
    [
      // `RemoteSession.close()` rejects every pending unary with this error,
      // whether or not the request had already reached the host.
      "a session closed while the create was pending",
      () =>
        new HostRpcError({
          code: "RPC_ERROR",
          message: "Remote session closed",
          requestId: "session-close",
          method: "",
          fatalDetails: null,
        }),
      CREATE_OUTCOME_UNKNOWN,
    ],
    [
      // A session fatal carries a specific code too, but it is about the
      // session, not this request.
      "a session fatal while the create was pending",
      () =>
        new HostRpcError({
          code: "UNAUTHORIZED",
          message: "credential revoked",
          requestId: "session-fatal",
          method: "",
          fatalDetails: sessionFatal,
        }),
      CREATE_OUTCOME_UNKNOWN,
    ],
    [
      // `notReadyRejection` on a closed session: nothing was sent, but the
      // class is the one a post-send drop uses, so it cannot prove that.
      "a create waiting on a session that closed before it was ready",
      () =>
        new HostTransportFailureError({
          ...transport,
          code: "RPC_ERROR",
          message: "Remote session is closed",
          fatalDetails: sessionFatal,
        }),
      CREATE_OUTCOME_UNKNOWN,
    ],
    [
      // The transport class alone leaves the outcome unknown, whatever code
      // it carries.
      "a transport failure carrying a specific code",
      () =>
        new HostTransportFailureError({
          ...transport,
          code: "FORBIDDEN",
          message: "dropped",
          fatalDetails: null,
        }),
      CREATE_OUTCOME_UNKNOWN,
    ],
    [
      "a keyed request dropped after it was sent",
      () =>
        new RetryableTransportError({
          ...transport,
          code: "RPC_ERROR",
          message: "socket closed",
          fatalDetails: null,
          replaySafetyFromKey: true,
        }),
      CREATE_OUTCOME_UNKNOWN,
    ],
    [
      "a create abandoned after it was sent",
      () =>
        new HostRequestAbortedError({
          ...transport,
          message: "aborted",
          mayHaveDispatched: true,
        }),
      CREATE_OUTCOME_UNKNOWN,
    ],
  ])("says the right thing for %s", (_label, makeError, sentence) => {
    mocks.createError = makeError();
    mountForm(TEAM_WITH_LOCAL);

    expect(screen.getByRole("alert").textContent).toBe(sentence);
  });
});

function cursorMaxRow(
  chat: ReadonlyArray<{ reasoningEffort: string | null; fast: boolean }>,
): ModelOption {
  return {
    harnessId: "cursor",
    slug: "cursor-max",
    label: "Cursor Max",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: ["low", "high"].map((id) => ({
      id,
      label: id,
      description: null,
    })),
    defaultServiceTier: null,
    supportedServiceTiers: [],
    deprecationNotice: null,
    metadata: { maxMode: { chat, judge: [], fastServiceTierId: "fast" } },
  };
}

function lastMaxModeContext(): MaxModeContext {
  const context = mocks.pickerContexts.at(-1);
  if (context === undefined) throw new Error("the picker never rendered");
  return context;
}

describe("<CreateBotForm /> Max Mode label", () => {
  beforeEach(() => {
    mocks.initialHarnessId = "cursor";
    mocks.initialModelSlug = "cursor-max";
    mocks.initialReasoning = "high";
  });

  it("uses the effort the bot sends with Fast off", () => {
    mountForm(TEAM_WITH_LOCAL);
    expect(lastMaxModeContext()).toEqual({
      kind: "chat",
      tuple: { reasoningEffort: "high", serviceTier: null },
    });
  });

  it("lists Max only for the selected effort with Fast off", () => {
    mountForm(TEAM_WITH_LOCAL);
    const context = lastMaxModeContext();
    expect(
      maxModeListedFor(
        cursorMaxRow([{ reasoningEffort: "high", fast: false }]),
        context,
      ),
    ).toBe(true);
    expect(
      maxModeListedFor(
        cursorMaxRow([{ reasoningEffort: "low", fast: false }]),
        context,
      ),
    ).toBe(false);
    expect(
      maxModeListedFor(
        cursorMaxRow([{ reasoningEffort: "high", fast: true }]),
        context,
      ),
    ).toBe(false);
  });

  it("does not re-render the form when only the catalog changes", () => {
    mountForm(TEAM_WITH_LOCAL);
    const apply = () =>
      act(() => {
        const store = mocks.stores.at(-1);
        if (store === undefined) throw new Error("no toolbar store");
        store.getState().setCatalog({
          hostId: LOCAL,
          chatLineCarriesAutoMode: null,
          harnesses: undefined,
          modelsHarnessId: "cursor",
          models: [],
          modelsLoaded: false,
          tuiOnly: false,
        });
      });
    apply();
    const settled = mocks.pickerContexts.length;
    apply();
    apply();
    expect(mocks.pickerContexts.length).toBe(settled);
  });
});
