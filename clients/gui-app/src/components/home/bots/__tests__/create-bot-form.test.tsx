/**
 * The create-bot form (Tracy Bots): the person names the bot and picks its
 * model, never the machine. The app chooses the host (`chooseBotCreateHost`),
 * the form names none of them, and the create goes to the chosen host's own
 * client. When no host qualifies the form says what the bot needs and where to
 * set it up. The toolbar-store hook is replaced by one that builds a REAL
 * toolbar store, so the model the form submits is the production store's.
 */
import { StrictMode, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  botCreateRequestSchema,
  type BotCreateRequest,
  type BotCreateResponse,
} from "@traycer/protocol/host/bot/schemas";
import { markMayHaveReachedHost } from "@traycer/protocol/host-transport/remote/rpc-types";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type HostRequestOptions,
  type IHostMessenger,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createAuthAwareMessenger } from "@traycer-clients/shared/host-transport/auth-aware-messenger";
import {
  createRetryingMessenger,
  RetryEpisodeOutcomeUnknownError,
  type TransportRetryPolicy,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { HostRpcRegistry } from "@/lib/host";
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
  createAsync:
    vi.fn<(variables: BotCreateRequest) => Promise<BotCreateResponse>>(),
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
  /**
   * The error `useBotCreateMutation` reports before any submit has failed;
   * once one has, it reports the latest submit's, as the real mutation does.
   */
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
    const [latest, setLatest] = useState<{ error: Error | null } | null>(null);
    return {
      isPending: false,
      error: latest === null ? mocks.createError : latest.error,
      mutateAsync: (variables: BotCreateRequest) => {
        setLatest({ error: null });
        return mocks.createAsync(variables).then(
          (response) => response,
          (error: unknown) => {
            setLatest({
              error: error instanceof Error ? error : new Error("rejected"),
            });
            throw error;
          },
        );
      },
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
const LOWERCASE_UUID: unknown = expect.stringMatching(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);

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
      directive: null,
      replyMode: "thread",
      appConversationChatId: null,
    },
    appConversationChatId: "conversation-1",
  };
}

const retryFailed = vi.fn<() => void>();
const onCreated = vi.fn<() => void>();

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
        onCreated={onCreated}
        onCancel={() => undefined}
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

// A session-level fatal, as `RemoteSession` rejects pending requests with.
const sessionFatal = {
  code: "UNAUTHORIZED",
  reason: "credential revoked",
  incompatibleMethods: null,
  upgradeGuidance: null,
};

/**
 * What `RemoteSession.rejectAllPendingUnary` rejects a request already sent
 * with: marked, because the host may have run it.
 */
function sessionFatalError(): HostRpcError {
  const error = new HostRpcError({
    code: "UNAUTHORIZED",
    message: "credential revoked",
    requestId: "session-fatal",
    method: "",
    fatalDetails: sessionFatal,
  });
  markMayHaveReachedHost(error);
  return error;
}

const FAST_RETRY_POLICY: TransportRetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 0,
  maxDelayMs: 0,
  sleep: () => Promise.resolve(),
  random: () => 0,
};

/**
 * The messenger as `host-runtime-provider` composes it: the retrying layer
 * outside the auth-aware one, over `inner`. `recover` plays the credential
 * recovery the auth layer waits on, and a recovery that rotates the lease
 * makes the auth layer send the original call again.
 */
function composedMessenger(
  inner: IHostMessenger<HostRpcRegistry>,
  recover: (controller: AbortController, lease: MutableBearerLease) => void,
): {
  readonly messenger: IHostMessenger<HostRpcRegistry>;
  readonly options: HostRequestOptions;
} {
  const controller = new AbortController();
  const lease = new MutableBearerLease("token", "user-1");
  const messenger = createRetryingMessenger(
    createAuthAwareMessenger(
      inner,
      {
        revalidateExpectedBearer: () => {
          recover(controller, lease);
          return Promise.resolve("rotated");
        },
      },
      "always",
    ),
    FAST_RETRY_POLICY,
  );
  return {
    messenger,
    options: {
      replayMustBeKeyed: false,
      requiredHostMethodVersion: null,
      idempotencyKey: null,
      authority: {
        endpoint: { hostId: LOCAL, websocketUrl: "ws://host-local/rpc" },
        bearer: lease,
        abortSignal: controller.signal,
      },
    },
  };
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
      "This bot needs a computer that runs bots for Acme. Set one up in Settings.",
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
      "This bot needs a computer that runs bots for Personal. Set one up in Settings.",
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
      "Some of your computers couldn't be checked.",
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
      screen.getByText("Finding a computer that runs Acme's bots…"),
    ).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });
});

async function createBot(user: UserEvent): Promise<void> {
  await user.type(screen.getByTestId("create-bot-title"), "  Release Bot  ");
  await user.click(submitButton());
}

describe("<CreateBotForm /> create goes to the chosen host", () => {
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
      requestKey: LOWERCASE_UUID,
      directive: null,
    });
    const record = lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID);
    expect(record?.hostId).toBe(LOCAL);
    expect(record?.title).toBe("Release Bot");
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
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
      requestKey: LOWERCASE_UUID,
      directive: null,
    });
    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)?.hostId).toBe(
      LOCAL,
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("does not create for a blank name", async () => {
    const user = userEvent.setup();
    mountForm(TEAM_WITH_LOCAL);

    await user.type(screen.getByTestId("create-bot-title"), "   ");

    expect(submitButton().disabled).toBe(true);
  });
});

describe("<CreateBotForm /> directive", () => {
  it("sends a null directive when the directive field holds only whitespace", async () => {
    const user = userEvent.setup();
    mountForm(TEAM_WITH_LOCAL);

    await user.type(screen.getByTestId("create-bot-directive"), "   ");
    await createBot(user);

    expect(mocks.createAsync).toHaveBeenCalledTimes(1);
    expect(mocks.createAsync.mock.calls[0]?.[0].directive).toBeNull();
  });

  it("sends the typed directive trimmed", async () => {
    const user = userEvent.setup();
    mountForm(TEAM_WITH_LOCAL);

    await user.type(
      screen.getByTestId("create-bot-directive"),
      "  Own the release checklist.  ",
    );
    await createBot(user);

    expect(mocks.createAsync).toHaveBeenCalledTimes(1);
    expect(mocks.createAsync.mock.calls[0]?.[0].directive).toBe(
      "Own the release checklist.",
    );
  });
});

describe("<CreateBotForm /> request key", () => {
  function keysSent(): string[] {
    return mocks.createAsync.mock.calls.map(([variables]) => {
      return variables.requestKey;
    });
  }

  it("names the same key when the person submits again after a failed create", async () => {
    const user = userEvent.setup();
    mocks.createAsync.mockRejectedValueOnce(new Error("outcome unknown"));
    mountForm(TEAM_WITH_LOCAL);

    await createBot(user);
    await user.click(submitButton());

    const keys = keysSent();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(LOWERCASE_UUID);
    expect(keys[1]).toBe(keys[0]);
  });

  it("names a different key from a newly mounted form, even after a failed create", async () => {
    const user = userEvent.setup();
    mocks.createAsync.mockRejectedValueOnce(new Error("outcome unknown"));
    mountForm(TEAM_WITH_LOCAL);
    await createBot(user);
    cleanup();

    mountForm(TEAM_WITH_LOCAL);
    await createBot(user);

    const keys = keysSent();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("names a new key for the next create once a create succeeded", async () => {
    const user = userEvent.setup();
    mountForm(TEAM_WITH_LOCAL);

    await createBot(user);
    await user.click(submitButton());

    const keys = keysSent();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });
});

describe("<CreateBotForm /> a create the transport sends again", () => {
  function botNumbered(n: number): BotCreateResponse {
    const base = botCreateResponse();
    return { ...base, bot: { ...base.bot, botId: `${BOT_ID}-${n}` } };
  }

  function requestKeyOf(params: object): string | undefined {
    return "requestKey" in params && typeof params.requestKey === "string"
      ? params.requestKey
      : undefined;
  }

  it("makes one bot when credential recovery sends a create the host already committed again", async () => {
    const user = userEvent.setup();
    // The host and the cloud behind it: a request key names at most one bot,
    // and a create without one always makes a new bot, as the cloud did
    // before keys.
    const bots: BotCreateResponse[] = [];
    const botByKey = new Map<string, BotCreateResponse>();
    const sentKeys: Array<string | undefined> = [];
    const request = vi
      .fn()
      .mockImplementation(
        (_method: string, params: object): Promise<BotCreateResponse> => {
          const key = requestKeyOf(params);
          sentKeys.push(key);
          const existing = key === undefined ? undefined : botByKey.get(key);
          const made = existing ?? botNumbered(bots.length + 1);
          if (existing === undefined) {
            bots.push(made);
            if (key !== undefined) botByKey.set(key, made);
          }
          // The first answer is lost: the create is committed, then the
          // session goes fatal with it pending.
          return request.mock.calls.length === 1
            ? Promise.reject(sessionFatalError())
            : Promise.resolve(made);
        },
      );
    const { messenger, options } = composedMessenger(
      {
        request,
        requestWithResponseTimeout: () =>
          Promise.reject(new Error("the create is a plain request")),
      },
      (_controller, lease) => lease.rotate("rotated-token"),
    );
    mocks.createAsync.mockImplementation((variables) =>
      messenger.request("bot.create", variables, options),
    );
    mountForm(TEAM_WITH_LOCAL);

    await createBot(user);

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    // Sent twice, and one bot came of it, made by the first send.
    expect(request).toHaveBeenCalledTimes(2);
    expect(bots).toHaveLength(1);
    expect(sentKeys[0]).toEqual(LOWERCASE_UUID);
    expect(sentKeys[1]).toBe(sentKeys[0]);
    expect(Object.keys(useBotTabsStore.getState().tabs)).toEqual([
      bots[0].bot.botId,
    ]);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });
});

describe("<CreateBotForm /> failed create", () => {
  const UNCONFIRMED =
    "Couldn't confirm the bot was created. Try again. It won't make a second bot.";
  const REFUSED = "The bot wasn't created.";
  const KEY_REUSED =
    "A bot from an earlier try was already created. Check your bots.";

  const transport = {
    requestId: "request-1",
    method: "bot.create",
  };

  function hostRefusal(code: HostRpcError["code"]): HostRpcError {
    return new HostRpcError({
      ...transport,
      code,
      message: "refusal text the form must not show",
      fatalDetails: null,
    });
  }

  /**
   * The error the form receives when a create already sent is rejected by a
   * session fatal and then passes through the messenger the app composes:
   * `recover` plays the credential recovery, and `retry` answers the second
   * attempt the auth layer makes after a rotation.
   */
  async function throughAuthRecovery(
    recover: (controller: AbortController, lease: MutableBearerLease) => void,
    retry: () => Error,
  ): Promise<Error> {
    let attempts = 0;
    const { messenger, options } = composedMessenger(
      {
        request: () => {
          attempts += 1;
          return Promise.reject(attempts === 1 ? sessionFatalError() : retry());
        },
        requestWithResponseTimeout: () =>
          Promise.reject(new Error("the create is a plain request")),
      },
      recover,
    );
    const failure = await messenger
      .request(
        "bot.create",
        {
          environmentId: TEAM_ENV,
          title: "Release Bot",
          harness: "claude",
          model: "model-a",
          effort: null,
          profile: null,
          requestKey: "0c5f4b8e-3a1d-4f6b-9e2a-7d8c1b2a3f40",
          directive: null,
        },
        options,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    if (!(failure instanceof Error)) {
      throw new Error("the create did not fail through the messenger");
    }
    return failure;
  }

  it.each([
    [
      "a validation error",
      UNCONFIRMED,
      () => {
        const parsed = botCreateRequestSchema.safeParse({
          environmentId: TEAM_ENV,
          title: "Release Bot",
          harness: "claude",
          model: "model-a",
          effort: null,
        });
        if (parsed.success) {
          throw new Error("the request without a profile parsed");
        }
        return Promise.resolve<Error>(parsed.error);
      },
    ],
    [
      "a request that never left",
      UNCONFIRMED,
      () =>
        Promise.resolve<Error>(
          new RetryableTransportError({
            ...transport,
            code: "RPC_ERROR",
            message: "socket closed",
            fatalDetails: null,
            replaySafetyFromKey: false,
          }),
        ),
    ],
    [
      "a keyed request dropped after it was sent",
      UNCONFIRMED,
      () =>
        Promise.resolve<Error>(
          new RetryableTransportError({
            ...transport,
            code: "RPC_ERROR",
            message: "socket closed",
            fatalDetails: null,
            replaySafetyFromKey: true,
          }),
        ),
    ],
    [
      "an abort",
      UNCONFIRMED,
      () =>
        Promise.resolve<Error>(
          new HostRequestAbortedError({
            ...transport,
            message: "aborted",
            mayHaveDispatched: false,
          }),
        ),
    ],
    [
      "the host refusing the caller",
      REFUSED,
      () => Promise.resolve<Error>(hostRefusal("FORBIDDEN")),
    ],
    [
      "the host refusing the request's fields",
      REFUSED,
      () => Promise.resolve<Error>(hostRefusal("E_INVALID_ARGUMENT")),
    ],
    [
      "a host that does not serve the method",
      REFUSED,
      () => Promise.resolve<Error>(hostRefusal("E_HOST_UNSUPPORTED")),
    ],
    [
      "the host rejecting the bearer, which the create may have followed",
      UNCONFIRMED,
      () => Promise.resolve<Error>(hostRefusal("UNAUTHORIZED")),
    ],
    [
      "a key that already made a bot this create cannot be answered with",
      KEY_REUSED,
      () => Promise.resolve<Error>(hostRefusal("E_BOT_REQUEST_KEY_REUSED")),
    ],
    [
      // `RemoteSession.close()` rejects every pending unary with this error.
      "a session closed while the create was pending",
      UNCONFIRMED,
      () =>
        Promise.resolve<Error>(
          new HostRpcError({
            code: "RPC_ERROR",
            message: "Remote session closed",
            requestId: "session-close",
            method: "",
            fatalDetails: null,
          }),
        ),
    ],
    [
      // `notReadyRejection` on a closed session.
      "a create waiting on a session that closed before it was ready",
      UNCONFIRMED,
      () =>
        Promise.resolve<Error>(
          new HostTransportFailureError({
            ...transport,
            code: "RPC_ERROR",
            message: "Remote session is closed",
            fatalDetails: sessionFatal,
          }),
        ),
    ],
    [
      // A fatal whose own code is one the host also answers a refusal with:
      // the marked create was sent, so the code does not say nothing was made.
      "a session fatal naming a refusal code while the create was pending",
      UNCONFIRMED,
      () => {
        const error = new HostRpcError({
          code: "FORBIDDEN",
          message: "access revoked",
          requestId: "session-fatal",
          method: "",
          fatalDetails: { ...sessionFatal, code: "FORBIDDEN" },
        });
        markMayHaveReachedHost(error);
        return Promise.resolve<Error>(error);
      },
    ],
    [
      "a session fatal rewritten into an abort during credential recovery",
      UNCONFIRMED,
      async () => {
        const failure = await throughAuthRecovery(
          (controller) => controller.abort(),
          () => new Error("no second attempt after an abort"),
        );
        if (!(failure instanceof HostRequestAbortedError)) {
          throw new Error("recovery did not take the abort exit");
        }
        return failure;
      },
    ],
    [
      "a session fatal followed by a refused retry after the bearer rotated",
      UNCONFIRMED,
      async () => {
        const failure = await throughAuthRecovery(
          (_controller, lease) => lease.rotate("rotated-token"),
          () => hostRefusal("FORBIDDEN"),
        );
        if (!(failure instanceof RetryEpisodeOutcomeUnknownError)) {
          throw new Error("recovery did not take the retry exit");
        }
        return failure;
      },
    ],
    [
      "a session fatal followed by a retry the key refused after the bearer rotated",
      KEY_REUSED,
      async () => {
        const failure = await throughAuthRecovery(
          (_controller, lease) => lease.rotate("rotated-token"),
          () => hostRefusal("E_BOT_REQUEST_KEY_REUSED"),
        );
        if (!(failure instanceof RetryEpisodeOutcomeUnknownError)) {
          throw new Error("recovery did not take the retry exit");
        }
        return failure;
      },
    ],
  ])(
    "says what is known after %s, never the error's text",
    async (_label, line, makeError) => {
      mocks.createError = await makeError();
      mountForm(TEAM_WITH_LOCAL);

      expect(screen.getByRole("alert").textContent).toBe(line);
    },
  );

  describe("after an earlier submit under the same key", () => {
    async function settle(): Promise<void> {
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }

    async function submitAgain(user: UserEvent): Promise<void> {
      await user.click(submitButton());
      await settle();
    }

    function alertText(): string | null {
      return screen.queryByRole("alert")?.textContent ?? null;
    }

    it.each(["E_INVALID_ARGUMENT", "FORBIDDEN", "E_HOST_UNSUPPORTED"] as const)(
      "does not say the bot wasn't created when a later submit is refused with %s",
      async (code) => {
        const user = userEvent.setup();
        mocks.createAsync
          .mockRejectedValueOnce(sessionFatalError())
          .mockRejectedValueOnce(hostRefusal(code));
        mountForm(TEAM_WITH_LOCAL);

        await createBot(user);
        await settle();
        expect(alertText()).toBe(UNCONFIRMED);

        await submitAgain(user);
        expect(mocks.createAsync).toHaveBeenCalledTimes(2);
        expect(alertText()).toBe(UNCONFIRMED);
      },
    );

    it("says the key already made a bot when a later submit is refused for it", async () => {
      const user = userEvent.setup();
      mocks.createAsync
        .mockRejectedValueOnce(sessionFatalError())
        .mockRejectedValueOnce(hostRefusal("E_BOT_REQUEST_KEY_REUSED"));
      mountForm(TEAM_WITH_LOCAL);

      await createBot(user);
      await settle();
      expect(alertText()).toBe(UNCONFIRMED);

      await submitAgain(user);
      expect(mocks.createAsync).toHaveBeenCalledTimes(2);
      expect(alertText()).toBe(KEY_REUSED);
    });

    it("still says the bot wasn't created after earlier submits that were refused", async () => {
      const user = userEvent.setup();
      mocks.createAsync
        .mockRejectedValueOnce(hostRefusal("E_INVALID_ARGUMENT"))
        .mockRejectedValueOnce(hostRefusal("FORBIDDEN"));
      mountForm(TEAM_WITH_LOCAL);

      await createBot(user);
      await settle();
      expect(alertText()).toBe(REFUSED);

      await submitAgain(user);
      expect(mocks.createAsync).toHaveBeenCalledTimes(2);
      expect(alertText()).toBe(REFUSED);
    });

    it("trusts a refusal again once a create succeeded", async () => {
      const user = userEvent.setup();
      mocks.createAsync
        .mockRejectedValueOnce(sessionFatalError())
        .mockResolvedValueOnce(botCreateResponse())
        .mockRejectedValueOnce(hostRefusal("E_INVALID_ARGUMENT"));
      mountForm(TEAM_WITH_LOCAL);

      await createBot(user);
      await settle();
      expect(alertText()).toBe(UNCONFIRMED);

      await submitAgain(user);
      expect(alertText()).toBeNull();

      await submitAgain(user);
      expect(mocks.createAsync).toHaveBeenCalledTimes(3);
      expect(alertText()).toBe(REFUSED);
    });
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
