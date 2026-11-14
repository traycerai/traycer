/**
 * Who owns a run of look saves: the person who started it, and the host it
 * left through. The real settings panel, saver and HostClient run over a mock
 * messenger whose host holds every `bot.updateAppearance` until the test
 * answers or refuses it by hand.
 */
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
} from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  HostTransportFailureError,
  mayHaveReachedHost,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type {
  BotAppearance,
  BotDirectoryRecord,
  BotListResponse,
  BotUpdateAppearanceRequest,
} from "@traycer/protocol/host/bot/schemas";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useBotLookSaveStore } from "@/stores/bots/bot-look-save-store";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  MASCOT_AT_REST,
  botMascot,
  drawMascotMark,
} from "@/lib/bots/mascot-mark";

const mocks = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  hostId: "host-1",
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock(
  "@/components/epic-canvas/hooks/use-tab-host-id",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/hooks/use-tab-host-id")
    >()),
    useTabHostId: () => mocks.hostId,
  }),
);
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));

import { BotAppearanceSettings } from "@/components/bots/bot-appearance-settings";
import { NamedBotAvatar } from "@/components/bots/bot-avatars";
import { BotLooksContext, botLooksOf } from "@/hooks/bots/use-bot-appearance";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LISTED: BotAppearance = {
  mark: null,
  color: 3,
  background: null,
  eyewear: null,
  accessory: null,
};

function botRow(appearance: BotAppearance): BotDirectoryRecord {
  return {
    botId: BOT_ID,
    environmentId: "env-1",
    createdByUserId: "user-1",
    title: "Release Bot",
    harness: "claude",
    model: "model-a",
    effort: null,
    profile: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: null,
    trunkChatId: "trunk-1",
    boundHostId: "host-1",
    hostEpoch: 0,
    createdAt: 1_000,
    archivedAt: null,
    appearance,
  };
}

interface HeldWrite {
  readonly request: BotUpdateAppearanceRequest;
  readonly answer: (look: BotAppearance) => void;
  /** The cloud refuses the person or the host (`FORBIDDEN`): certainly not kept. */
  readonly refuse: (message: string) => void;
  /** The host fails in a way of its own (`RPC_ERROR`): the write may have been kept. */
  readonly fail: (message: string) => void;
  /** The answer is lost after the write left: it may yet be kept. */
  readonly lose: (message: string) => void;
  /** Whether the host still holds the write, neither answered nor ended. */
  readonly open: () => boolean;
}

interface FakeHost {
  readonly spine: HostClient<HostRpcRegistry>;
  readonly client: HostClient<HostRpcRegistry>;
  /** Every `bot.updateAppearance` the host was sent, each held until answered. */
  readonly writes: HeldWrite[];
  /** Holds this host's `bot.list` reads until the returned release is called. */
  readonly holdLists: () => () => void;
}

/** Every host a test made, so its held writes can be ended when it is over. */
let hosts: FakeHost[] = [];
/** Every gate a test opened, so none outlives it. */
let releases: Array<() => void> = [];

function heldOpen(): PromiseWithResolvers<void> {
  const gate = Promise.withResolvers<void>();
  releases.push(gate.resolve);
  return gate;
}

function userContext(userId: string) {
  const base = createAuthenticatedUserFixture(undefined);
  return createRequestContextFixture({
    origin: "renderer",
    bearerToken: `token-${userId}`,
    user: { ...base, user: { ...base.user, id: userId } },
  });
}

/** A real HostClient, signed in as `userId`, whose host holds every write. */
function fakeHost(userId: string): FakeHost {
  const writes: HeldWrite[] = [];
  let listGate: Promise<void> | null = null;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "bot.updateAppearance": (params) =>
          new Promise((resolve, reject) => {
            let open = true;
            writes.push({
              request: params,
              open: () => open,
              answer: (look) => {
                open = false;
                listed = look;
                resolve({ bot: botRow(look) });
              },
              refuse: (message) => {
                open = false;
                reject(
                  new HostRpcError({
                    code: "FORBIDDEN",
                    message,
                    requestId: "req-1",
                    method: "bot.updateAppearance",
                    fatalDetails: null,
                  }),
                );
              },
              fail: (message) => {
                open = false;
                reject(new Error(message));
              },
              lose: (message) => {
                open = false;
                const lost = new HostTransportFailureError({
                  code: "RPC_ERROR",
                  message,
                  requestId: "req-1",
                  method: "bot.updateAppearance",
                  fatalDetails: null,
                });
                expect(mayHaveReachedHost(lost)).toBe(true);
                reject(lost);
              },
            });
          }),
        "bot.list": async () => {
          await listGate;
          return { bots: [botRow(listed)], mainBotIds: null };
        },
      },
    }),
  });
  spine.setRequestContext(userContext(userId));
  const host: FakeHost = {
    spine,
    client: spine.createRequester(mockLocalHostEntry),
    writes,
    holdLists: () => {
      const gate = heldOpen();
      listGate = gate.promise;
      return gate.resolve;
    },
  };
  hosts.push(host);
  return host;
}

let queryClient = new QueryClient();
let view: RenderResult | null = null;
/** The look every fake host's `bot.list` answers with; an answered write becomes it. */
let listed: BotAppearance = LISTED;
/** Whether the bot's pictures draw over a real `bot.list` read, which a save can re-read. */
let listing = false;

function Pictures(): ReactNode {
  return (
    <>
      <NamedBotAvatar botId={BOT_ID} size="sm" />
      <BotAppearanceSettings botId={BOT_ID} />
    </>
  );
}

function ListedLooks(): ReactNode {
  const list = useBotListQuery(mocks.client, true);
  return (
    <BotLooksContext
      value={list.data === undefined ? null : botLooksOf(list.data)}
    >
      <Pictures />
    </BotLooksContext>
  );
}

function tree(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      {listing ? (
        <ListedLooks />
      ) : (
        <BotLooksContext
          value={botLooksOf({ bots: [botRow(LISTED)], mainBotIds: null })}
        >
          <Pictures />
        </BotLooksContext>
      )}
    </QueryClientProvider>
  );
}

/** The look the cached `bot.list` holds for the bot. */
function cachedLook(): BotAppearance | null {
  const list = queryClient
    .getQueriesData<BotListResponse>({
      predicate: (query) =>
        hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, "bot.list"),
    })
    .at(0)?.[1];
  return list?.bots.find((bot) => bot.botId === BOT_ID)?.appearance ?? null;
}

/** Points the panel at `host` over a real `bot.list` read, once it has answered. */
async function pointListedPanelAt(
  host: FakeHost,
  hostId: string,
): Promise<void> {
  listing = true;
  pointPanelAt(host, hostId);
  await waitFor(() => {
    expect(cachedLook()).toEqual(listed);
  });
}

/** Points the open panel at `host`, as moving the tab to another host does. */
function pointPanelAt(host: FakeHost, hostId: string): void {
  mocks.client = host.client;
  mocks.hostId = hostId;
  if (view === null) {
    view = render(tree());
    return;
  }
  view.rerender(tree());
}

/** Resolves once `count` of the panel's mutations have been answered or refused. */
async function settledMutations(count: number): Promise<void> {
  await waitFor(() => {
    const settled = queryClient
      .getMutationCache()
      .getAll()
      .filter((mutation) => mutation.state.status !== "pending");
    expect(settled).toHaveLength(count);
  });
}

async function writeAt(host: FakeHost, index: number): Promise<HeldWrite> {
  await waitFor(() => {
    expect(host.writes.length).toBeGreaterThan(index);
  });
  return host.writes[index];
}

function pressedIn(section: "eyewear" | "accessory"): string {
  const [pressed, ...rest] = within(
    screen.getByTestId(`bot-settings-${section}`),
  ).getAllByRole("button", { pressed: true });
  expect(rest).toEqual([]);
  return pressed.getAttribute("aria-label") ?? "";
}

function avatarPaths(): string[] {
  const paths = screen
    .getByTestId("bot-avatar")
    .querySelectorAll('[data-slot="bot-mascot"] path');
  return [...paths].map((path) => path.getAttribute("d") ?? "");
}

function avatarPathsFor(look: BotAppearance): string[] {
  return drawMascotMark(
    botMascot(BOT_ID, look, false),
    24,
    MASCOT_AT_REST,
  ).layers.map((layer) => layer.path);
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  view = null;
  mocks.client = null;
  mocks.hostId = "host-1";
  listed = LISTED;
  listing = false;
  hosts = [];
  releases = [];
  useBotLookSaveStore.setState(useBotLookSaveStore.getInitialState(), true);
});

afterEach(async () => {
  for (const release of releases) release();
  cleanup();
  // A write still held would answer into the next test's store.
  await waitFor(() => {
    for (const host of hosts) {
      for (const write of host.writes) {
        if (write.open()) write.refuse("The test is over.");
      }
    }
    expect(useBotLookSaveStore.getState().flights).toEqual({});
  });
  useBotLookSaveStore.setState(useBotLookSaveStore.getInitialState(), true);
  queryClient.clear();
});

describe("a run of look saves when the client's person changes", () => {
  it("retires the run at once, never sends what it had waiting, and shows no refusal", async () => {
    const user = userEvent.setup();
    const host = fakeHost("user-A");
    pointPanelAt(host, "host-1");
    await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
    const first = await writeAt(host, 0);
    await user.click(screen.getByTestId("bot-settings-accessory-halo"));
    expect(pressedIn("eyewear")).toBe("Shades");
    expect(pressedIn("accessory")).toBe("Halo");
    expect(first.request).toEqual({ botId: BOT_ID, eyewear: "shades" });

    act(() => {
      host.spine.setRequestContext(userContext("user-B"));
    });

    expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeUndefined();
    expect(avatarPaths()).toEqual(avatarPathsFor(LISTED));
    expect(pressedIn("eyewear")).toBe("None");
    expect(pressedIn("accessory")).toBe("None");
    await settledMutations(1);
    expect(host.writes).toHaveLength(1);
    expect(screen.queryByTestId("bot-settings-refusal")).toBeNull();
    expect(screen.queryAllByRole("alert")).toEqual([]);
    expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeUndefined();
  });
});

describe("a run of look saves retired while the cached bot lists are being settled", () => {
  it("never writes the answered look into the cached lists", async () => {
    const user = userEvent.setup();
    const host = fakeHost("user-A");
    pointPanelAt(host, "host-1");
    const listKey = [...hostQueryKeys.methodScope("host-1", "bot.list"), "all"];
    queryClient.setQueryData(listKey, {
      bots: [botRow(LISTED)],
      mainBotIds: null,
    });
    const readReleased = heldOpen();
    // A read of the list left before the save is answered and is still out.
    // Ending it is what the saver waits on, so the person changes as it ends.
    const refetch = queryClient.fetchQuery(
      queryOptions({
        queryKey: listKey,
        staleTime: 0,
        queryFn: async ({ signal }) => {
          signal.addEventListener("abort", () => {
            host.spine.setRequestContext(userContext("user-B"));
          });
          await readReleased.promise;
          return { bots: [botRow(LISTED)], mainBotIds: null };
        },
      }),
    );
    const refetchEnded = refetch.catch(() => {});

    await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
    const held = await writeAt(host, 0);
    act(() => {
      held.answer({ ...LISTED, eyewear: "shades" });
    });
    await settledMutations(1);
    await refetchEnded;
    readReleased.resolve();

    const cached = queryClient
      .getQueryCache()
      .findAll({ queryKey: listKey })
      .map((query) => query.state.data);
    expect(cached).toEqual([{ bots: [botRow(LISTED)], mainBotIds: null }]);
    expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeUndefined();
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });
});

const UNSURE = "This may not have been saved.";

function refusalUnder(section: "eyewear" | "accessory"): string | null {
  return (
    within(screen.getByTestId(`bot-settings-${section}`)).queryByTestId(
      "bot-settings-refusal",
    )?.textContent ?? null
  );
}

function savingShownUnder(section: "colour" | "eyewear"): boolean {
  const labelId = screen
    .getByTestId(`bot-settings-${section}`)
    .getAttribute("aria-labelledby");
  const label = labelId === null ? null : document.getElementById(labelId);
  expect(label).not.toBeNull();
  return (
    label?.querySelector('span[aria-hidden="true"]') instanceof HTMLElement
  );
}

describe("a run of look saves when a choice is made through another host", () => {
  const SHADES = { eyewear: "shades" } as const;
  const CHOSEN = {
    ...LISTED,
    ...SHADES,
    accessory: "halo",
    color: 7,
  } as const;

  function colourPressed(index: number): string | null {
    return screen
      .getByTestId(`bot-settings-colour-${String(index)}`)
      .getAttribute("aria-pressed");
  }

  /**
   * H1 holds a save of eyewear, with an accessory waiting when `waiting`; H2 is
   * then asked for a colour, and its write is not yet sent.
   */
  async function handOver(waiting: boolean): Promise<{
    readonly first: FakeHost;
    readonly second: FakeHost;
    readonly held: HeldWrite;
  }> {
    const user = userEvent.setup();
    const first = fakeHost("user-A");
    await pointListedPanelAt(first, "host-1");
    await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
    const held = await writeAt(first, 0);
    if (waiting) {
      await user.click(screen.getByTestId("bot-settings-accessory-halo"));
    }

    const second = fakeHost("user-A");
    pointPanelAt(second, "host-2");
    await user.click(screen.getByTestId("bot-settings-colour-7"));
    return { first, second, held };
  }

  it("holds the new host's request until the old host's save is done, then sends only what was waiting or chosen since, and writes the answered look to the lists", async () => {
    const { first, second, held } = await handOver(true);

    expect(useBotLookSaveStore.getState().saves[BOT_ID]?.hostId).toBe("host-2");
    expect(colourPressed(7)).toBe("true");
    await userEvent.click(screen.getByTestId("bot-settings-background-2"));
    expect(second.writes).toHaveLength(0);

    act(() => {
      held.answer({ ...LISTED, ...SHADES });
    });
    const takenOver = await writeAt(second, 0);

    expect(takenOver.request).toEqual({
      botId: BOT_ID,
      accessory: "halo",
      color: 7,
      background: 2,
    });
    expect(second.writes).toHaveLength(1);
    expect(first.writes).toHaveLength(1);
    expect(cachedLook()).toEqual({ ...LISTED, ...SHADES });
    expect(pressedIn("eyewear")).toBe("Shades");
    takenOver.answer({ ...CHOSEN, background: 2 });
  });

  it("keeps the saving indicator under a part the old host is still saving, beside the colour chosen through the new host, until both are answered", async () => {
    const { second, held } = await handOver(false);

    expect(savingShownUnder("eyewear")).toBe(true);
    expect(savingShownUnder("colour")).toBe(true);

    act(() => {
      held.answer({ ...LISTED, ...SHADES });
    });
    const takenOver = await writeAt(second, 0);

    expect(savingShownUnder("eyewear")).toBe(false);
    expect(savingShownUnder("colour")).toBe(true);
    takenOver.answer({ ...LISTED, ...SHADES, color: 7 });
    await waitFor(() => {
      expect(savingShownUnder("colour")).toBe(false);
    });
    expect(savingShownUnder("eyewear")).toBe(false);
  });

  it("does not replay a part the old host saved when only a colour is chosen through the new host", async () => {
    const { second, held } = await handOver(false);

    act(() => {
      held.answer({ ...LISTED, ...SHADES });
    });
    const takenOver = await writeAt(second, 0);

    expect(Object.keys(takenOver.request).sort()).toEqual(["botId", "color"]);
    takenOver.answer({ ...LISTED, ...SHADES, color: 7 });
  });

  it("never sends the old host's parts when its save is certainly refused, and returns them to the held look with the refusal", async () => {
    const { second, held } = await handOver(false);
    const run = useBotLookSaveStore.getState().saves[BOT_ID]?.run;

    held.refuse("Old host refused.");
    const takenOver = await writeAt(second, 0);

    expect(takenOver.request).toEqual({ botId: BOT_ID, color: 7 });
    expect(second.writes).toHaveLength(1);
    expect(refusalUnder("eyewear")).toBe("Old host refused.");
    expect(pressedIn("eyewear")).toBe("None");
    expect(colourPressed(7)).toBe("true");
    const entry = useBotLookSaveStore.getState().saves[BOT_ID];
    expect(entry.hostId).toBe("host-2");
    expect(entry.run).toBe(run);

    takenOver.answer({ ...LISTED, color: 7 });
    await waitFor(() => {
      expect(useBotLookSaveStore.getState().saves[BOT_ID]?.sending).toBeNull();
    });
  });

  it("treats the old host's plain failure as unknown: sends none of its parts, and says so under a part the re-read lists do not hold", async () => {
    const { second, held } = await handOver(true);

    held.fail("Host failed.");
    const takenOver = await writeAt(second, 0);

    expect(takenOver.request).toEqual({
      botId: BOT_ID,
      accessory: "halo",
      color: 7,
    });
    expect(second.writes).toHaveLength(1);
    expect(refusalUnder("eyewear")).toBe(UNSURE);
    expect(refusalUnder("accessory")).toBeNull();
    expect(pressedIn("eyewear")).toBe("None");
    takenOver.answer({ ...LISTED, accessory: "halo", color: 7 });
  });

  it("says nothing under a part the re-read lists hold when the old host's plain failure ends its save", async () => {
    const { second, held } = await handOver(true);
    listed = { ...LISTED, ...SHADES };

    held.fail("Host failed.");
    const takenOver = await writeAt(second, 0);

    expect(takenOver.request).toEqual({
      botId: BOT_ID,
      accessory: "halo",
      color: 7,
    });
    expect(refusalUnder("eyewear")).toBeNull();
    expect(pressedIn("eyewear")).toBe("Shades");
    takenOver.answer({ ...CHOSEN });
  });

  it("treats the old host's lost answer the same way: sends none of its parts, and says so under a part the re-read lists do not hold", async () => {
    const { second, held } = await handOver(true);

    held.lose("Connection dropped.");
    const takenOver = await writeAt(second, 0);

    expect(takenOver.request).toEqual({
      botId: BOT_ID,
      accessory: "halo",
      color: 7,
    });
    expect(second.writes).toHaveLength(1);
    expect(refusalUnder("eyewear")).toBe(UNSURE);
    expect(pressedIn("eyewear")).toBe("None");
    takenOver.answer({ ...LISTED, accessory: "halo", color: 7 });
  });

  it("sends none of the old host's parts when a colour is chosen through the new host while the lists are re-read after its save ended unknown", async () => {
    const user = userEvent.setup();
    const first = fakeHost("user-A");
    await pointListedPanelAt(first, "host-1");
    await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
    const lost = await writeAt(first, 0);
    const releaseLists = first.holdLists();

    act(() => {
      lost.lose("Connection dropped.");
    });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBeGreaterThan(0);
    });
    const second = fakeHost("user-A");
    pointPanelAt(second, "host-2");
    await user.click(screen.getByTestId("bot-settings-colour-7"));

    expect(second.writes).toHaveLength(0);
    releaseLists();
    const takenOver = await writeAt(second, 0);

    expect(takenOver.request).toEqual({ botId: BOT_ID, color: 7 });
    expect(second.writes).toHaveLength(1);
    takenOver.answer({ ...LISTED, color: 7 });
  });

  it("sends none of the answered save's parts when a colour is chosen through the new host while the lists in flight are being ended", async () => {
    const first = fakeHost("user-A");
    pointPanelAt(first, "host-1");
    const second = fakeHost("user-A");
    const listKey = [...hostQueryKeys.methodScope("host-1", "bot.list"), "all"];
    queryClient.setQueryData(listKey, {
      bots: [botRow(LISTED)],
      mainBotIds: null,
    });
    const readReleased = heldOpen();
    let writesInWindow = -1;
    // A read of the list is out when the save is answered. Ending it is what
    // the saver waits on, and the colour is chosen through H2 as it ends.
    const refetch = queryClient.fetchQuery(
      queryOptions({
        queryKey: listKey,
        staleTime: 0,
        queryFn: async ({ signal }) => {
          signal.addEventListener("abort", () => {
            fireEvent.click(screen.getByTestId("bot-settings-colour-7"));
            writesInWindow = second.writes.length;
          });
          await readReleased.promise;
          return { bots: [botRow(LISTED)], mainBotIds: null };
        },
      }),
    );
    const refetchEnded = refetch.catch(() => {});
    await userEvent.click(screen.getByTestId("bot-settings-eyewear-shades"));
    const held = await writeAt(first, 0);
    pointPanelAt(second, "host-2");

    act(() => {
      held.answer({ ...LISTED, ...SHADES });
    });
    await refetchEnded;
    const takenOver = await writeAt(second, 0);

    expect(writesInWindow).toBe(0);
    expect(takenOver.request).toEqual({ botId: BOT_ID, color: 7 });
    expect(second.writes).toHaveLength(1);
    takenOver.answer({ ...LISTED, ...SHADES, color: 7 });
  });
});

describe("a run of look saves through one host whose save ends unknown", () => {
  async function unknownWithAccessoryWaiting(): Promise<{
    readonly host: FakeHost;
    readonly lost: HeldWrite;
  }> {
    const user = userEvent.setup();
    const host = fakeHost("user-A");
    await pointListedPanelAt(host, "host-1");
    await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
    const lost = await writeAt(host, 0);
    await user.click(screen.getByTestId("bot-settings-accessory-halo"));
    return { host, lost };
  }

  it("still sends the part waiting behind it, never sends the unknown part again, and says so when the lists do not hold it", async () => {
    const { host, lost } = await unknownWithAccessoryWaiting();

    lost.fail("Host failed.");
    const next = await writeAt(host, 1);

    expect(next.request).toEqual({ botId: BOT_ID, accessory: "halo" });
    expect(host.writes).toHaveLength(2);
    expect(refusalUnder("eyewear")).toBe(UNSURE);
    expect(pressedIn("eyewear")).toBe("None");
    next.answer({ ...LISTED, accessory: "halo" });
    await waitFor(() => {
      expect(useBotLookSaveStore.getState().saves[BOT_ID]?.sending).toBeNull();
    });
    expect(host.writes).toHaveLength(2);
  });

  it("says nothing under the unknown part when the lists hold it", async () => {
    const { host, lost } = await unknownWithAccessoryWaiting();
    listed = { ...LISTED, eyewear: "shades" };

    lost.fail("Host failed.");
    const next = await writeAt(host, 1);

    expect(next.request).toEqual({ botId: BOT_ID, accessory: "halo" });
    expect(refusalUnder("eyewear")).toBeNull();
    expect(pressedIn("eyewear")).toBe("Shades");
    next.answer({ ...listed, accessory: "halo" });
  });
});
