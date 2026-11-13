/**
 * A bot's icon, colour, eyewear, accessory and channel background (Tracy Bots
 * T147): the real
 * section, hooks and HostClient over a mock messenger whose host records each
 * `bot.updateAppearance` it is sent and answers it with the row it would
 * store. Nothing is faked but the tab's host binding and its method support.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import {
  BOT_MASCOT_ACCESSORIES,
  BOT_MASCOT_EYEWEAR,
  BOT_UNRECOGNISED_MARK,
  type BotAppearance,
  type BotDirectoryRecord,
  type BotListResponse,
  type BotMascotShape,
  type BotUpdateAppearanceRequest,
} from "@traycer/protocol/host/bot/schemas";
import { hostQueryKeys } from "@/lib/query-keys";
import { useBotLookSaveStore } from "@/stores/bots/bot-look-save-store";
import {
  DEFAULT_MASCOT_SHAPE,
  MASCOT_AT_REST,
  MASCOT_SHAPES,
  botMascot,
  drawMascotMark,
  ownMascotShape,
} from "@/lib/bots/mascot-mark";

const mocks = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  /** Methods the tab's host does not advertise. */
  unsupported: new Set<string>(),
  appearanceWrites: [] as BotUpdateAppearanceRequest[],
  /** The appearance the host stored for the last write, as it answered it. */
  stored: null as BotAppearance | null,
  /** While set, each `bot.updateAppearance` waits in `heldWrites` to be answered by hand. */
  hold: false,
  heldWrites: [] as HeldWrite[],
  /** Writes the host has taken and not yet answered or refused. */
  inFlight: 0,
  maxInFlight: 0,
  answered: 0,
  /** The look `bot.list` answers with; a held write's answer becomes it. */
  listed: { mark: null, color: null, background: null } as BotAppearance,
  /** The next `bot.list` read answers with the look it started with only once this resolves. */
  listGate: null as Promise<void> | null,
  listReads: 0,
}));

interface HeldWrite {
  readonly request: BotUpdateAppearanceRequest;
  /** Answers the write with `look`, which the cloud now holds. */
  readonly answer: (look: BotAppearance) => void;
  readonly refuse: (message: string) => void;
}

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock(
  "@/components/epic-canvas/hooks/use-tab-host-id",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/hooks/use-tab-host-id")
    >()),
    useTabHostId: () => "host-1",
  }),
);
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    !mocks.unsupported.has(method),
}));

import { BotAppearanceSettings } from "@/components/bots/bot-appearance-settings";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { NamedBotAvatar } from "@/components/bots/bot-avatars";
import { BotLooksContext, botLooksOf } from "@/hooks/bots/use-bot-appearance";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BARE: BotAppearance = { mark: null, color: null, background: null };

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

/** What the host stores when `request` is applied to `appearance`. */
function applied(
  appearance: BotAppearance,
  request: BotUpdateAppearanceRequest,
): BotAppearance {
  return {
    mark: request.mark === undefined ? appearance.mark : request.mark,
    color: request.color === undefined ? appearance.color : request.color,
    background:
      request.background === undefined
        ? appearance.background
        : request.background,
    eyewear:
      request.eyewear === undefined ? appearance.eyewear : request.eyewear,
    accessory:
      request.accessory === undefined
        ? appearance.accessory
        : request.accessory,
  };
}

let rerenderWith: (appearance: BotAppearance) => void = () => {};

/** The section and the bot's own avatar, over what the surface's list names. */
function mount(appearance: BotAppearance): void {
  mountListing(appearance, null);
}

/** The same, the surface's list naming the bot as its environment's main bot. */
function mountMain(appearance: BotAppearance): void {
  mountListing(appearance, { "env-1": BOT_ID });
}

function buildClient(appearance: BotAppearance): void {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "bot.updateAppearance": (params) => {
          mocks.appearanceWrites.push(params);
          if (mocks.hold) {
            mocks.inFlight += 1;
            mocks.maxInFlight = Math.max(mocks.maxInFlight, mocks.inFlight);
            return new Promise((resolve, reject) => {
              mocks.heldWrites.push({
                request: params,
                answer: (look) => {
                  mocks.inFlight -= 1;
                  mocks.answered += 1;
                  mocks.listed = look;
                  resolve({ bot: botRow(look) });
                },
                refuse: (message) => {
                  mocks.inFlight -= 1;
                  reject(new Error(message));
                },
              });
            });
          }
          mocks.stored = applied(appearance, params);
          return { bot: botRow(mocks.stored) };
        },
        "bot.list": () => {
          mocks.listReads += 1;
          const read = { bots: [botRow(mocks.listed)], mainBotIds: null };
          const gate = mocks.listGate;
          mocks.listGate = null;
          return gate === null ? read : gate.then(() => read);
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  mocks.client = spine.createRequester(mockLocalHostEntry);
}

function mountListing(
  appearance: BotAppearance,
  mainBotIds: BotListResponse["mainBotIds"],
): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  buildClient(appearance);
  const tree = (looks: BotAppearance): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <BotLooksContext
        value={botLooksOf({ bots: [botRow(looks)], mainBotIds })}
      >
        <NamedBotAvatar botId={BOT_ID} size="sm" />
        <BotAppearanceSettings botId={BOT_ID} />
      </BotLooksContext>
    </QueryClientProvider>
  );
  const view = render(tree(appearance));
  rerenderWith = (looks) => view.rerender(tree(looks));
}

/** The surface's own `bot.list` read, whose rows the pictures draw. */
function Surface(): ReactNode {
  const list = useBotListQuery(mocks.client, true);
  return (
    <BotLooksContext
      value={list.data === undefined ? null : botLooksOf(list.data)}
    >
      <NamedBotAvatar botId={BOT_ID} size="sm" />
      <BotAppearanceSettings botId={BOT_ID} />
    </BotLooksContext>
  );
}

const IS_BOT_LIST = {
  predicate: (query: { readonly queryKey: readonly unknown[] }) =>
    hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, "bot.list"),
};

interface Listed {
  readonly queryClient: QueryClient;
  readonly unmount: () => void;
}

/** The section and avatar over a real `bot.list` read of `appearance`, once it has answered. */
async function mountListed(appearance: BotAppearance): Promise<Listed> {
  mocks.listed = appearance;
  mocks.hold = true;
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  buildClient(appearance);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Surface />
    </QueryClientProvider>,
  );
  await waitFor(() => {
    expect(cachedLook(queryClient)).toEqual(appearance);
  });
  return { queryClient, unmount: view.unmount };
}

/** The look the cached `bot.list` holds for the bot. */
function cachedLook(queryClient: QueryClient): BotAppearance | null {
  const entry = queryClient.getQueriesData<BotListResponse>(IS_BOT_LIST).at(0);
  const list = entry?.[1];
  return list?.bots.find((bot) => bot.botId === BOT_ID)?.appearance ?? null;
}

/** Replaces the look the cached `bot.list` holds, as another member's change would. */
function setCachedLook(queryClient: QueryClient, look: BotAppearance): void {
  const entry = queryClient.getQueriesData<BotListResponse>(IS_BOT_LIST).at(0);
  if (entry === undefined) throw new Error("no list cached");
  queryClient.setQueryData<BotListResponse>(entry[0], {
    bots: [botRow(look)],
    mainBotIds: null,
  });
}

beforeEach(() => {
  mocks.unsupported.clear();
  mocks.appearanceWrites = [];
  mocks.stored = null;
  mocks.hold = false;
  mocks.heldWrites = [];
  mocks.inFlight = 0;
  mocks.maxInFlight = 0;
  mocks.answered = 0;
  mocks.listGate = null;
  mocks.listReads = 0;
  useBotLookSaveStore.setState({ saves: {} });
});

afterEach(() => {
  cleanup();
});

/** The paths a mascot in `root` draws, which say which shape it is. */
function pathsIn(root: HTMLElement): string[] {
  const paths = root.querySelectorAll('[data-slot="bot-mascot"] path');
  if (paths.length === 0) throw new Error("no mascot drawn");
  return [...paths].map((path) => path.getAttribute("d") ?? "");
}

/** The paths the avatar draws at 24 px for a bot showing `look`. */
function avatarPathsFor(look: BotAppearance): string[] {
  return drawMascotMark(
    botMascot(BOT_ID, look, false),
    24,
    MASCOT_AT_REST,
  ).layers.map((layer) => layer.path);
}

/** A choice's button name: "Blob", "Shades", "None". */
function partName(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/** The choice a section shows pressed. */
function pressedIn(section: "icon" | "eyewear" | "accessory"): string {
  const [pressed, ...rest] = within(
    screen.getByTestId(`bot-settings-${section}`),
  ).getAllByRole("button", { pressed: true });
  expect(rest).toEqual([]);
  return pressed.getAttribute("aria-label") ?? "";
}

/** The shape the icon section shows pressed. */
function pressedShape(): string {
  return pressedIn("icon");
}

/** A shape other than the one the bot's id gives it. */
function chosenShape(): BotMascotShape {
  const own = ownMascotShape(BOT_ID);
  const other = MASCOT_SHAPES.find((shape) => shape !== own);
  if (other === undefined) throw new Error("only one shape");
  return other;
}

describe("<BotAppearanceSettings />", () => {
  it("names the five sections Icon, Colour, Eyewear, Accessory and Background", () => {
    mount(BARE);

    expect(screen.getByTestId("bot-settings-icon").textContent).toContain(
      "Icon",
    );
    expect(screen.getByTestId("bot-settings-colour").textContent).toContain(
      "Colour",
    );
    expect(screen.getByTestId("bot-settings-eyewear").textContent).toContain(
      "Eyewear",
    );
    expect(screen.getByTestId("bot-settings-accessory").textContent).toContain(
      "Accessory",
    );
    expect(screen.getByTestId("bot-settings-background").textContent).toContain(
      "Background",
    );
    expect(screen.getAllByText("Use the default")).toHaveLength(5);
  });

  it("is absent when the host does not support bot.updateAppearance", () => {
    mocks.unsupported.add("bot.updateAppearance");
    mount(BARE);

    expect(screen.queryByTestId("bot-settings-icon")).toBeNull();
    expect(screen.queryByTestId("bot-settings-colour")).toBeNull();
    expect(screen.queryByTestId("bot-settings-background")).toBeNull();
  });

  it("offers exactly the shapes it draws and writes the chosen one alone", async () => {
    const user = userEvent.setup();
    mount(BARE);
    expect(
      within(screen.getByTestId("bot-settings-icon"))
        .getAllByRole("button", { name: /^[A-Z][a-z]+$/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Blob", "Flame", "Ghost", "Capsule", "Cat", "Sun"]);

    await user.click(
      screen.getByTestId(`bot-settings-icon-shape-${chosenShape()}`),
    );

    await waitFor(() => {
      expect(mocks.appearanceWrites).toEqual([
        { botId: BOT_ID, mark: { kind: "mascot", shape: chosenShape() } },
      ]);
    });
  });

  it("writes the chosen colour and the chosen background as their own partial payloads", async () => {
    const user = userEvent.setup();
    mount(BARE);

    await user.click(screen.getByTestId("bot-settings-colour-14"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(1);
    });
    await user.click(screen.getByTestId("bot-settings-background-5"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(2);
    });

    expect(mocks.appearanceWrites).toEqual([
      { botId: BOT_ID, color: 14 },
      { botId: BOT_ID, background: 5 },
    ]);
  });

  it("offers every eyewear and accessory and writes the chosen one alone", async () => {
    const user = userEvent.setup();
    mount(BARE);
    for (const [section, options] of [
      ["eyewear", BOT_MASCOT_EYEWEAR],
      ["accessory", BOT_MASCOT_ACCESSORIES],
    ] as const) {
      expect(
        within(screen.getByTestId(`bot-settings-${section}`))
          .getAllByRole("button", { name: /^[A-Z][a-z]+$/ })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(options.map(partName));
    }

    await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(1);
    });
    await user.click(screen.getByTestId("bot-settings-accessory-halo"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(2);
    });

    expect(mocks.appearanceWrites).toEqual([
      { botId: BOT_ID, eyewear: "shades" },
      { botId: BOT_ID, accessory: "halo" },
    ]);
  });

  it("sends null for each Use the default, and only for its own field", async () => {
    const user = userEvent.setup();
    mount({
      mark: { kind: "mascot", shape: "cat" },
      color: 2,
      background: 9,
      eyewear: "visor",
      accessory: "bow",
    });

    await user.click(screen.getByTestId("bot-settings-icon-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(1);
    });
    await user.click(screen.getByTestId("bot-settings-colour-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(2);
    });
    await user.click(screen.getByTestId("bot-settings-eyewear-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(3);
    });
    await user.click(screen.getByTestId("bot-settings-accessory-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(4);
    });
    await user.click(screen.getByTestId("bot-settings-background-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(5);
    });

    expect(mocks.appearanceWrites).toEqual([
      { botId: BOT_ID, mark: null },
      { botId: BOT_ID, color: null },
      { botId: BOT_ID, eyewear: null },
      { botId: BOT_ID, accessory: null },
      { botId: BOT_ID, background: null },
    ]);
  });

  it("offers Use the default only where a choice stands", () => {
    mount({ mark: null, color: 2, background: null, eyewear: "glasses" });

    expect(
      screen.getByTestId<HTMLButtonElement>("bot-settings-icon-default")
        .disabled,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("bot-settings-colour-default")
        .disabled,
    ).toBe(false);
    expect(
      screen.getByTestId<HTMLButtonElement>("bot-settings-eyewear-default")
        .disabled,
    ).toBe(false);
    for (const section of ["accessory", "background"]) {
      expect(
        screen.getByTestId<HTMLButtonElement>(`bot-settings-${section}-default`)
          .disabled,
      ).toBe(true);
    }
  });

  it("offers no upload: neither a button nor a file input", () => {
    mount(BARE);

    expect(screen.queryByText("Upload a picture")).toBeNull();
    expect(screen.queryByTestId("bot-settings-icon-upload")).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("presses the shape the bot shows: its own, the chosen one, or the default for one it cannot read", () => {
    mount(BARE);
    expect(pressedShape()).toBe(partName(ownMascotShape(BOT_ID)));
    cleanup();

    mount({ ...BARE, mark: { kind: "mascot", shape: chosenShape() } });
    expect(pressedShape()).toBe(partName(chosenShape()));
    cleanup();

    mount({ ...BARE, mark: BOT_UNRECOGNISED_MARK });
    expect(pressedShape()).toBe(partName(DEFAULT_MASCOT_SHAPE));
  });

  it("presses Blob, None and None for a main bot nothing was chosen for, where another bot shows its own", () => {
    expect(ownMascotShape(BOT_ID)).not.toBe(DEFAULT_MASCOT_SHAPE);
    mount(BARE);
    expect(pressedShape()).not.toBe(partName(DEFAULT_MASCOT_SHAPE));
    cleanup();

    mountMain(BARE);

    expect(pressedShape()).toBe(partName(DEFAULT_MASCOT_SHAPE));
    expect(pressedIn("eyewear")).toBe("None");
    expect(pressedIn("accessory")).toBe("None");
  });

  it("writes a chosen shape, and a reload shows that shape pressed and on the avatar", async () => {
    const user = userEvent.setup();
    mount(BARE);

    await user.click(
      screen.getByTestId(`bot-settings-icon-shape-${chosenShape()}`),
    );

    await waitFor(() => {
      expect(mocks.stored).not.toBeNull();
    });
    const returned = mocks.stored;
    if (returned === null) throw new Error("the host stored nothing");
    rerenderWith(returned);

    expect(pressedShape()).toBe(partName(chosenShape()));
    expect(pathsIn(screen.getByTestId("bot-avatar"))).toEqual(
      avatarPathsFor(returned),
    );
    expect(pathsIn(screen.getByTestId("bot-avatar"))).not.toEqual(
      avatarPathsFor(BARE),
    );
  });

  it("sends null for Use the default, and a reload shows the bot's own shape again", async () => {
    const user = userEvent.setup();
    mount({ ...BARE, mark: { kind: "mascot", shape: chosenShape() } });
    expect(pressedShape()).toBe(partName(chosenShape()));

    await user.click(screen.getByTestId("bot-settings-icon-default"));

    await waitFor(() => {
      expect(mocks.appearanceWrites).toEqual([{ botId: BOT_ID, mark: null }]);
    });
    const returned = mocks.stored;
    if (returned === null) throw new Error("the host stored nothing");
    rerenderWith(returned);

    expect(pressedShape()).toBe(partName(ownMascotShape(BOT_ID)));
    expect(pathsIn(screen.getByTestId("bot-avatar"))).toEqual(
      avatarPathsFor(BARE),
    );
  });

  describe("over the surface's own bot.list, with a save held open", () => {
    const BASE: BotAppearance = { ...BARE, color: 3, eyewear: null };

    /** The write the host holds `index`th, once it has reached the host. */
    async function writeAt(index: number): Promise<HeldWrite> {
      await waitFor(() => {
        expect(mocks.heldWrites.length).toBeGreaterThan(index);
      });
      return mocks.heldWrites[index];
    }

    it("presses a chosen eyewear and repaints the avatar before the host has answered", async () => {
      const user = userEvent.setup();
      await mountListed(BASE);
      const before = pathsIn(screen.getByTestId("bot-avatar"));

      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));

      expect(pressedIn("eyewear")).toBe("Shades");
      expect(pathsIn(screen.getByTestId("bot-avatar"))).toEqual(
        avatarPathsFor({ ...BASE, eyewear: "shades" }),
      );
      expect(pathsIn(screen.getByTestId("bot-avatar"))).not.toEqual(before);
      expect(mocks.answered).toBe(0);
      (await writeAt(0)).answer({ ...BASE, eyewear: "shades" });
    });

    it("fixture timing: the pressed state changes in the same act as the click, with no answer yet", async () => {
      await mountListed(BASE);

      act(() => {
        fireEvent.click(screen.getByTestId("bot-settings-eyewear-shades"));
      });

      expect(pressedIn("eyewear")).toBe("Shades");
      expect(mocks.answered).toBe(0);
      (await writeAt(0)).answer({ ...BASE, eyewear: "shades" });
    });

    it("keeps every choice enabled, presses a second part at once, and sends it only after the first is answered", async () => {
      const user = userEvent.setup();
      await mountListed(BASE);
      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
      const first = await writeAt(0);

      const halo = screen.getByTestId<HTMLButtonElement>(
        "bot-settings-accessory-sparkle",
      );
      expect(halo.disabled).toBe(false);
      await user.click(halo);

      expect(pressedIn("accessory")).toBe("Sparkle");
      expect(mocks.appearanceWrites).toEqual([
        { botId: BOT_ID, eyewear: "shades" },
      ]);

      first.answer({ ...BASE, eyewear: "shades" });
      const second = await writeAt(1);
      expect(mocks.appearanceWrites).toEqual([
        { botId: BOT_ID, eyewear: "shades" },
        { botId: BOT_ID, accessory: "sparkle" },
      ]);
      second.answer({ ...BASE, eyewear: "shades", accessory: "sparkle" });
      await waitFor(() => {
        expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeUndefined();
      });
      expect(mocks.maxInFlight).toBe(1);
    });

    it("sends the later of two rapid choices of a part, and never draws the earlier answer over it", async () => {
      const user = userEvent.setup();
      await mountListed(BASE);
      await user.click(screen.getByTestId("bot-settings-eyewear-glasses"));
      const first = await writeAt(0);
      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));

      first.answer({ ...BASE, eyewear: "glasses" });

      const second = await writeAt(1);
      expect(second.request).toEqual({ botId: BOT_ID, eyewear: "shades" });
      expect(pressedIn("eyewear")).toBe("Shades");
      expect(pathsIn(screen.getByTestId("bot-avatar"))).toEqual(
        avatarPathsFor({ ...BASE, eyewear: "shades" }),
      );
      second.answer({ ...BASE, eyewear: "shades" });
      await waitFor(() => {
        expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeUndefined();
      });
      expect(pressedIn("eyewear")).toBe("Shades");
    });

    it("still sends a newer choice of a part when the save in flight is refused, and shows no refusal for it", async () => {
      const user = userEvent.setup();
      await mountListed(BASE);
      await user.click(screen.getByTestId("bot-settings-eyewear-glasses"));
      const first = await writeAt(0);
      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));

      first.refuse("Not saved.");

      const second = await writeAt(1);
      expect(second.request).toEqual({ botId: BOT_ID, eyewear: "shades" });
      expect(pressedIn("eyewear")).toBe("Shades");
      expect(screen.queryByTestId("bot-settings-refusal")).toBeNull();
      second.answer({ ...BASE, eyewear: "shades" });
      await waitFor(() => {
        expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeUndefined();
      });
      expect(pressedIn("eyewear")).toBe("Shades");
      expect(screen.queryByTestId("bot-settings-refusal")).toBeNull();
    });

    it("returns a refused part to the look the list holds, says why under that section, and clears it on the next choice", async () => {
      const user = userEvent.setup();
      await mountListed({ ...BASE, eyewear: "glasses" });
      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
      expect(pressedIn("eyewear")).toBe("Shades");

      (await writeAt(0)).refuse("Only the owner may change this.");

      const section = screen.getByTestId("bot-settings-eyewear");
      await waitFor(() => {
        expect(within(section).getByRole("alert").textContent).toBe(
          "Only the owner may change this.",
        );
      });
      expect(pressedIn("eyewear")).toBe("Glasses");
      expect(
        within(screen.getByTestId("bot-settings-accessory")).queryByRole(
          "alert",
        ),
      ).toBeNull();

      await user.click(screen.getByTestId("bot-settings-eyewear-visor"));

      expect(within(section).queryByRole("alert")).toBeNull();
      (await writeAt(1)).answer({ ...BASE, eyewear: "visor" });
    });

    it("shows the value the host answered with when it differs from the one asked for", async () => {
      const user = userEvent.setup();
      await mountListed(BASE);
      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));

      (await writeAt(0)).answer({ ...BASE, eyewear: "visor" });

      await waitFor(() => {
        expect(pressedIn("eyewear")).toBe("Visor");
      });
      expect(pathsIn(screen.getByTestId("bot-avatar"))).toEqual(
        avatarPathsFor({ ...BASE, eyewear: "visor" }),
      );
    });

    it("keeps an answered look when a list read that started before the answer resolves after it with the old look", async () => {
      const user = userEvent.setup();
      const { queryClient } = await mountListed(BASE);
      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
      const first = await writeAt(0);
      await user.click(screen.getByTestId("bot-settings-accessory-sparkle"));

      let release: () => void = () => {};
      mocks.listGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const readsBefore = mocks.listReads;
      await act(() => {
        void queryClient.invalidateQueries(IS_BOT_LIST);
        return Promise.resolve();
      });
      await waitFor(() => {
        expect(mocks.listReads).toBe(readsBefore + 1);
      });
      first.answer({ ...BASE, eyewear: "shades" });
      const second = await writeAt(1);
      await act(() => {
        release();
        return Promise.resolve();
      });
      await waitFor(() => {
        expect(queryClient.isFetching()).toBe(0);
      });

      expect(cachedLook(queryClient)?.eyewear).toBe("shades");
      expect(pressedIn("eyewear")).toBe("Shades");
      second.answer({ ...BASE, eyewear: "shades", accessory: "sparkle" });
    });

    it("shows a part's own choice while it is pending, and another member's change to a part not pending at once", async () => {
      const user = userEvent.setup();
      const { queryClient } = await mountListed(BASE);
      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
      const write = await writeAt(0);

      setCachedLook(queryClient, { ...BASE, eyewear: "visor", color: 7 });

      await waitFor(() => {
        expect(
          screen
            .getByTestId("bot-settings-colour-7")
            .getAttribute("aria-pressed"),
        ).toBe("true");
      });
      expect(pressedIn("eyewear")).toBe("Shades");
      write.answer({ ...BASE, eyewear: "shades", color: 7 });
    });

    it("leaves the bot no entry once its saves are answered", async () => {
      const user = userEvent.setup();
      await mountListed(BASE);
      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
      expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeDefined();

      (await writeAt(0)).answer({ ...BASE, eyewear: "shades" });

      await waitFor(() => {
        expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeUndefined();
      });
    });

    it("drops a refusal nobody is looking at when the panel unmounts", async () => {
      const user = userEvent.setup();
      const { unmount } = await mountListed(BASE);
      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
      (await writeAt(0)).refuse("Not saved.");
      await waitFor(() => {
        expect(screen.getByTestId("bot-settings-refusal")).toBeDefined();
      });
      expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeDefined();

      unmount();

      expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeUndefined();
    });

    it("keeps no refusal that arrives after the panel closed, so a reopened panel shows the list's look without one", async () => {
      const user = userEvent.setup();
      const { unmount } = await mountListed(BASE);
      await user.click(screen.getByTestId("bot-settings-eyewear-shades"));
      const write = await writeAt(0);
      expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeDefined();
      unmount();

      write.refuse("Not saved.");

      await waitFor(() => {
        expect(useBotLookSaveStore.getState().saves[BOT_ID]).toBeUndefined();
      });
      await mountListed(BASE);
      expect(screen.queryByTestId("bot-settings-refusal")).toBeNull();
      expect(pressedIn("eyewear")).toBe("None");
    });
  });
});
