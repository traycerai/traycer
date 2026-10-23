/**
 * A team's onboarding card (Tracy Bots T48): step 1 shows the GitHub set,
 * with a read-only mark where the installing admin can only read, "Connect
 * GitHub" to an admin and "Waiting for an admin" to anyone else; step 2 keeps
 * the team's ticks; "Open your channels" creates the chosen bots once the set
 * holds a repository and opens the first channel. The real query and
 * mutation hooks run over the mock host messenger, so every assertion on a
 * request is on what the host was sent; the model picker and the toolbar
 * store hook are replaced, the store itself is the production one.
 */
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotOnboardingChooseRequest,
  BotOnboardingCompleteRequest,
  BotOnboardingGithub,
  BotOnboardingReadResponse,
} from "@traycer/protocol/host/bot/onboarding-schemas";
import type {
  EnvironmentDescriptor,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

const HOST_ID = mockLocalHostEntry.hostId;
const ENV = "env-team";
const BOT_A = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOT_B = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const mocks = vi.hoisted(() => ({
  requester: null as object | null,
  supported: true,
  navigateToTabIntent: vi.fn<(intent: unknown) => void>(),
  openLink: vi.fn<(url: string, kind: string) => Promise<void>>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: (_navigate: unknown, intent: unknown) =>
    mocks.navigateToTabIntent(intent),
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.requester,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === HOST_ID ? mocks.requester : null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) =>
    hostId === HOST_ID && method === "bot.onboarding.read" && mocks.supported,
}));
vi.mock("@/hooks/host/use-hosts-advertising-method", () => ({
  useHostsAdvertisingMethod: (hostIds: ReadonlyArray<string>, method: string) =>
    new Set(method === "bot.onboarding.complete" ? hostIds : []),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => HOST_ID,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ signInUrl: "https://platform.traycer.ai" }),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div data-testid="stub-harness-model-picker" />,
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
          seedKey: "bot-onboarding-card-test",
          values: {
            permission: "supervised",
            selection: {
              harnessId: "claude",
              modelSlug: "model-a",
              profileId: null,
            },
            reasoning: "",
            serviceTier: "",
          },
          onSettingsChange: null,
          tuiOnly: false,
          chatLineCarriesAutoMode: null,
          hostId: HOST_ID,
        }),
      );
      return store;
    },
  };
});

import { BotOnboardingCard } from "@/components/home/bots/bot-onboarding-card";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const CATALOG: BotOnboardingReadResponse["catalog"] = [
  {
    area: "ci-speed-and-cost",
    title: "CI speed and cost",
    description: "Measures minutes, cost and wall time.",
    when: "Weekly; the baseline on the first run",
    tickedByDefault: true,
  },
  {
    area: "trunk-watch",
    title: "Trunk watch",
    description: "When the default branch goes red, finds the commit.",
    when: "When the default branch goes red",
    tickedByDefault: true,
  },
  {
    area: "alerts",
    title: "Alerts (SRE)",
    description: "Triages alerts as they fire.",
    when: null,
    tickedByDefault: false,
  },
];

function github(input: {
  readonly repositories: BotOnboardingGithub["repositories"];
  readonly callerCanConnect: boolean;
  readonly state: BotOnboardingGithub["state"];
}): BotOnboardingGithub {
  return {
    state: input.state,
    installingAdmin:
      input.repositories.length === 0
        ? null
        : { displayName: "Ada", you: false },
    repositories: input.repositories,
    callerCanConnect: input.callerCanConnect,
  };
}

const NO_SET = github({
  repositories: [],
  callerCanConnect: false,
  state: "ok",
});

const CONNECTED = github({
  repositories: [
    { repositoryId: "1", fullName: "acme/api", permission: "write" },
    { repositoryId: "2", fullName: "acme/docs", permission: "read" },
  ],
  callerCanConnect: true,
  state: "ok",
});

function descriptor(): EnvironmentDescriptor {
  return {
    environmentId: ENV,
    ownerKind: "organization",
    ownerId: "team-1",
    roomId: "room-team",
    label: "acme",
  };
}

function boundHere(): HostEnvironmentBindings {
  const binding: EnvironmentHostBinding = {
    hostId: HOST_ID,
    environment: descriptor(),
    explicit: true,
    enrolledByUserId: "user-1",
    canUnbind: true,
  };
  return {
    byHostId: new Map([[HOST_ID, binding]]),
    failedHostIds: [],
    retryFailed: () => undefined,
  };
}

type World = {
  read: BotOnboardingReadResponse;
  reads: number;
  readonly queryClient: QueryClient;
  readonly chooses: BotOnboardingChooseRequest[];
  readonly completes: BotOnboardingCompleteRequest[];
};

function mount(read: BotOnboardingReadResponse): World {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const world: World = {
    read,
    reads: 0,
    queryClient,
    chooses: [],
    completes: [],
  };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: {
      "bot.onboarding.read": () => {
        world.reads += 1;
        return world.read;
      },
      "bot.onboarding.choose": (params) => {
        world.chooses.push(params);
        const choice = {
          areas: params.areas,
          chosenAt: 2_000,
          completedAt: null,
        };
        world.read = { ...world.read, choice };
        return { choice };
      },
      "bot.onboarding.complete": (params) => {
        world.completes.push(params);
        const areas = world.read.choice?.areas ?? [];
        const choice = { areas, chosenAt: 2_000, completedAt: 3_000 };
        world.read = { ...world.read, choice };
        return {
          choice,
          bots: areas.map((area, index) => ({
            area,
            botId: index === 0 ? BOT_A : BOT_B,
          })),
        };
      },
    },
  });
  const hostClient = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger,
  });
  hostClient.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const requester = hostClient.createRequester(mockLocalHostEntry);
  mocks.requester = requester;
  render(
    <QueryClientProvider client={queryClient}>
      <BotOnboardingCard
        environmentId={ENV}
        teamName="acme"
        connectableHostIds={[HOST_ID]}
        environmentBindings={boundHere()}
      />
    </QueryClientProvider>,
  );
  return world;
}

function area(key: string): HTMLElement {
  const found = screen
    .getAllByTestId("bot-onboarding-area")
    .find((element) => element.getAttribute("data-area") === key);
  if (found === undefined) throw new Error(`no area ${key}`);
  return found;
}

function checkbox(key: string): HTMLElement {
  return within(area(key)).getByRole("checkbox");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supported = true;
  mocks.openLink.mockResolvedValue(undefined);
  useBotTabsStore.setState({ tabs: {} });
});

afterEach(() => {
  cleanup();
  resetHostConnectionRegistryForTest();
});

describe("<BotOnboardingCard /> before the set holds a repository", () => {
  it("tells a member who cannot connect GitHub that it waits for an admin, ticks the default bots, and keeps a change as the team's choice", async () => {
    const world = mount({
      github: NO_SET,
      unlocked: false,
      choice: null,
      catalog: CATALOG,
    });

    expect(
      await screen.findByTestId("bot-onboarding-waiting-for-admin"),
    ).toBeTruthy();
    expect(screen.queryByTestId("bot-onboarding-connect-github")).toBeNull();
    expect(checkbox("ci-speed-and-cost").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(checkbox("trunk-watch").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("alerts").getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByTestId("bot-onboarding-open").hasAttribute("disabled"),
    ).toBe(true);

    await userEvent.click(checkbox("alerts"));

    await waitFor(() =>
      expect(world.chooses).toEqual([
        {
          environmentId: ENV,
          areas: ["ci-speed-and-cost", "trunk-watch", "alerts"],
        },
      ]),
    );
    await waitFor(() =>
      expect(checkbox("alerts").getAttribute("aria-checked")).toBe("true"),
    );
    expect(world.completes).toEqual([]);
  });

  it("offers an admin the team's GitHub page on the dashboard", async () => {
    mount({
      github: github({ repositories: [], callerCanConnect: true, state: "ok" }),
      unlocked: false,
      choice: null,
      catalog: CATALOG,
    });

    await userEvent.click(
      await screen.findByTestId("bot-onboarding-connect-github"),
    );

    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://platform.traycer.ai/team/acme/environment/github",
      "account",
      expect.anything(),
    );
    expect(screen.queryByTestId("bot-onboarding-waiting-for-admin")).toBeNull();
  });

  it("shows nothing on a host that does not serve onboarding", () => {
    mocks.supported = false;
    const world = mount({
      github: NO_SET,
      unlocked: false,
      choice: null,
      catalog: CATALOG,
    });

    expect(screen.queryByTestId("bot-onboarding-card")).toBeNull();
    // The read is never sent, so nothing can arrive to draw.
    expect(world.queryClient.isFetching()).toBe(0);
    expect(world.reads).toBe(0);
  });
});

describe("<BotOnboardingCard /> once the set holds a repository", () => {
  it("marks the repository the installing admin can only read", async () => {
    mount({
      github: CONNECTED,
      unlocked: true,
      choice: null,
      catalog: CATALOG,
    });

    const connected = await screen.findByTestId(
      "bot-onboarding-github-connected",
    );
    const rows = within(connected).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "acme/api",
      "acme/docsRead-only",
    ]);
  });

  it("keeps the default choice, creates the bots with the picked model on the chosen host, and opens the first channel", async () => {
    const world = mount({
      github: CONNECTED,
      unlocked: true,
      choice: null,
      catalog: CATALOG,
    });

    const open = await screen.findByTestId("bot-onboarding-open");
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    await userEvent.click(open);

    await waitFor(() =>
      expect(world.completes).toEqual([
        {
          environmentId: ENV,
          harness: "claude",
          model: "model-a",
          effort: null,
          profile: null,
        },
      ]),
    );
    expect(world.chooses).toEqual([
      { environmentId: ENV, areas: ["ci-speed-and-cost", "trunk-watch"] },
    ]);
    await waitFor(() =>
      expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1),
    );
    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_A)).toMatchObject({
      botId: BOT_A,
      hostId: HOST_ID,
      title: "CI speed and cost",
    });
    // The read carries the completion back, and the card leaves.
    await waitFor(() =>
      expect(screen.queryByTestId("bot-onboarding-card")).toBeNull(),
    );
  });

  it("sends a choice the team already kept without choosing again", async () => {
    const world = mount({
      github: CONNECTED,
      unlocked: true,
      choice: { areas: ["alerts"], chosenAt: 1_000, completedAt: null },
      catalog: CATALOG,
    });

    const open = await screen.findByTestId("bot-onboarding-open");
    expect(checkbox("ci-speed-and-cost").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(checkbox("alerts").getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
    await userEvent.click(open);

    await waitFor(() => expect(world.completes).toHaveLength(1));
    expect(world.chooses).toEqual([]);
  });
});

describe("<BotOnboardingCard /> after onboarding", () => {
  const completed = { areas: ["alerts"], chosenAt: 1_000, completedAt: 2_000 };

  it("tells an admin the set needs a new installing admin, with the page where one takes over", async () => {
    mount({
      github: { ...CONNECTED, state: "needs_installing_admin" },
      unlocked: false,
      choice: completed,
      catalog: CATALOG,
    });

    expect(
      await screen.findByTestId("bot-onboarding-needs-installing-admin"),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByTestId("bot-onboarding-needs-installing-admin-link"),
    );
    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://platform.traycer.ai/team/acme/environment/github",
      "account",
      expect.anything(),
    );
    expect(screen.queryByTestId("bot-onboarding-card")).toBeNull();
  });

  it("shows a member who cannot connect GitHub nothing", async () => {
    const world = mount({
      github: {
        ...CONNECTED,
        state: "needs_installing_admin",
        callerCanConnect: false,
      },
      unlocked: false,
      choice: completed,
      catalog: CATALOG,
    });

    await waitFor(() => expect(world.reads).toBe(1));
    await waitFor(() => expect(world.queryClient.isFetching()).toBe(0));
    expect(
      screen.queryByTestId("bot-onboarding-needs-installing-admin"),
    ).toBeNull();
    expect(screen.queryByTestId("bot-onboarding-card")).toBeNull();
  });
});
