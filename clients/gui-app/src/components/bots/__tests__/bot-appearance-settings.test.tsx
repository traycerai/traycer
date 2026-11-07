/**
 * A bot's icon, colour and channel background (Tracy Bots T147): the real
 * section, hooks and HostClient over a mock messenger whose host records each
 * `bot.updateAppearance` it is sent and answers it with the row it would
 * store. Nothing is faked but the tab's host binding and its method support.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
import type {
  BotAppearance,
  BotDirectoryRecord,
  BotUpdateAppearanceRequest,
} from "@traycer/protocol/host/bot/schemas";
import {
  chosenCreatureMark,
  creatureSheet,
  drawCreatureMark,
  nextCreatureSheet,
  ownCreature,
} from "@/lib/bots/creature-mark";

const mocks = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  /** Methods the tab's host does not advertise. */
  unsupported: new Set<string>(),
  appearanceWrites: [] as BotUpdateAppearanceRequest[],
  /** The appearance the host stored for the last write, as it answered it. */
  stored: null as BotAppearance | null,
  /** While set, `bot.updateAppearance` is not answered until it resolves. */
  writeGate: null as Promise<void> | null,
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
    useTabHostId: () => "host-1",
  }),
);
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    !mocks.unsupported.has(method),
}));

import { BotAppearanceSettings } from "@/components/bots/bot-appearance-settings";
import { NamedBotAvatar } from "@/components/bots/bot-avatars";
import { BotLooksContext, botLooksOf } from "@/hooks/bots/use-bot-appearance";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BARE: BotAppearance = { mark: null, swatch: null, background: null };

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
    swatch: request.swatch === undefined ? appearance.swatch : request.swatch,
    background:
      request.background === undefined
        ? appearance.background
        : request.background,
  };
}

let rerenderWith: (appearance: BotAppearance) => void = () => {};

/** The section and the bot's own avatar, over what the surface's list names. */
function mount(appearance: BotAppearance): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
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
          mocks.stored = applied(appearance, params);
          const answer = { bot: botRow(mocks.stored) };
          return mocks.writeGate === null
            ? answer
            : mocks.writeGate.then(() => answer);
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  mocks.client = spine.createRequester(mockLocalHostEntry);
  const tree = (looks: BotAppearance): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <BotLooksContext value={botLooksOf([botRow(looks)])}>
        <NamedBotAvatar botId={BOT_ID} size="sm" />
        <BotAppearanceSettings botId={BOT_ID} />
      </BotLooksContext>
    </QueryClientProvider>
  );
  const view = render(tree(appearance));
  rerenderWith = (looks) => view.rerender(tree(looks));
}

beforeEach(() => {
  mocks.unsupported.clear();
  mocks.appearanceWrites = [];
  mocks.stored = null;
  mocks.writeGate = null;
});

afterEach(() => {
  cleanup();
});

/** The path a creature preview or avatar draws, which says which creature it is. */
function pathIn(root: HTMLElement): string {
  const path = root.querySelector('[data-slot="bot-creature"] path');
  if (path === null) throw new Error("no creature drawn");
  return path.getAttribute("d") ?? "";
}

/** The creature each candidate button draws, in order. */
function candidatePaths(): string[] {
  return screen
    .getAllByRole("button", { name: /^Creature \d+$/ })
    .map((button) => pathIn(button));
}

function currentPath(): string {
  return pathIn(screen.getByTestId("bot-settings-icon-current"));
}

describe("<BotAppearanceSettings />", () => {
  it("names the three sections Icon, Colour and Background", () => {
    mount(BARE);

    expect(screen.getByTestId("bot-settings-icon").textContent).toContain(
      "Icon",
    );
    expect(screen.getByTestId("bot-settings-colour").textContent).toContain(
      "Colour",
    );
    expect(screen.getByTestId("bot-settings-background").textContent).toContain(
      "Background",
    );
    expect(screen.getAllByText("Use the default")).toHaveLength(3);
  });

  it("is absent when the host does not support bot.updateAppearance", () => {
    mocks.unsupported.add("bot.updateAppearance");
    mount(BARE);

    expect(screen.queryByTestId("bot-settings-icon")).toBeNull();
    expect(screen.queryByTestId("bot-settings-colour")).toBeNull();
    expect(screen.queryByTestId("bot-settings-background")).toBeNull();
  });

  it("offers the sheet's twelve creatures and writes the chosen family and seed alone", async () => {
    const user = userEvent.setup();
    mount(BARE);
    const sheet = creatureSheet(BOT_ID);
    expect(candidatePaths()).toHaveLength(sheet.length);

    await user.click(screen.getByTestId("bot-settings-icon-creature-3"));

    await waitFor(() => {
      expect(mocks.appearanceWrites).toEqual([
        {
          botId: BOT_ID,
          mark: {
            kind: "creature",
            family: sheet[3].family,
            seed: sheet[3].seed,
          },
        },
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
      { botId: BOT_ID, swatch: 14 },
      { botId: BOT_ID, background: 5 },
    ]);
  });

  it("sends null for each Use the default, and only for its own field", async () => {
    const user = userEvent.setup();
    mount({
      mark: { kind: "creature", family: "ears", seed: 4 },
      swatch: 2,
      background: 9,
    });

    await user.click(screen.getByTestId("bot-settings-icon-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(1);
    });
    await user.click(screen.getByTestId("bot-settings-colour-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(2);
    });
    await user.click(screen.getByTestId("bot-settings-background-default"));
    await waitFor(() => {
      expect(mocks.appearanceWrites).toHaveLength(3);
    });

    expect(mocks.appearanceWrites).toEqual([
      { botId: BOT_ID, mark: null },
      { botId: BOT_ID, swatch: null },
      { botId: BOT_ID, background: null },
    ]);
  });

  it("offers Use the default only where a choice stands", () => {
    mount({ mark: null, swatch: 2, background: null });

    expect(
      screen.getByTestId<HTMLButtonElement>("bot-settings-icon-default")
        .disabled,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("bot-settings-colour-default")
        .disabled,
    ).toBe(false);
    expect(
      screen.getByTestId<HTMLButtonElement>("bot-settings-background-default")
        .disabled,
    ).toBe(true);
  });

  it("offers no upload: neither a button nor a file input", () => {
    mount(BARE);

    expect(screen.queryByText("Upload a picture")).toBeNull();
    expect(screen.queryByTestId("bot-settings-icon-upload")).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("shows a different sheet on Regenerate patterns, writing nothing", async () => {
    const user = userEvent.setup();
    mount(BARE);
    const before = candidatePaths();

    await user.click(screen.getByTestId("bot-settings-icon-regenerate"));

    const after = candidatePaths();
    expect(after).toHaveLength(before.length);
    for (const path of after) {
      expect(before).not.toContain(path);
    }
    expect(new Set(after).size).toBe(after.length);
    expect(mocks.appearanceWrites).toEqual([]);
  });

  it("keeps the current creature's preview through Regenerate patterns", async () => {
    const user = userEvent.setup();
    const stored = creatureSheet(BOT_ID)[4];
    mount({
      ...BARE,
      mark: { kind: "creature", family: stored.family, seed: stored.seed },
    });
    const expected = drawCreatureMark(
      chosenCreatureMark(BOT_ID, stored),
      40,
    ).path;
    expect(currentPath()).toBe(expected);

    await user.click(screen.getByTestId("bot-settings-icon-regenerate"));
    await user.click(screen.getByTestId("bot-settings-icon-regenerate"));

    expect(currentPath()).toBe(expected);
    expect(candidatePaths()).not.toContain(
      drawCreatureMark(chosenCreatureMark(BOT_ID, stored), 32).path,
    );
  });

  it("writes a regenerated candidate's family and seed, and a reload shows that creature as the current one and on the avatar", async () => {
    const user = userEvent.setup();
    mount(BARE);
    const regenerated = nextCreatureSheet(
      BOT_ID,
      creatureSheet(BOT_ID),
      ownCreature(BOT_ID),
    );
    const choice = regenerated[2];

    await user.click(screen.getByTestId("bot-settings-icon-regenerate"));
    await user.click(screen.getByTestId("bot-settings-icon-creature-2"));

    await waitFor(() => {
      expect(mocks.appearanceWrites).toEqual([
        {
          botId: BOT_ID,
          mark: { kind: "creature", family: choice.family, seed: choice.seed },
        },
      ]);
    });
    const returned = mocks.stored;
    if (returned === null) throw new Error("the host stored nothing");
    rerenderWith(returned);

    const mask = chosenCreatureMark(BOT_ID, choice);
    expect(currentPath()).toBe(drawCreatureMark(mask, 40).path);
    expect(pathIn(screen.getByTestId("bot-avatar"))).toBe(
      drawCreatureMark(mask, 24).path,
    );
  });

  it("sends null for Use the default, and a reload shows the bot's own creature again", async () => {
    const user = userEvent.setup();
    const stored = creatureSheet(BOT_ID)[5];
    mount({
      ...BARE,
      mark: { kind: "creature", family: stored.family, seed: stored.seed },
    });
    expect(currentPath()).not.toBe(
      drawCreatureMark(chosenCreatureMark(BOT_ID, ownCreature(BOT_ID)), 40)
        .path,
    );

    await user.click(screen.getByTestId("bot-settings-icon-default"));

    await waitFor(() => {
      expect(mocks.appearanceWrites).toEqual([{ botId: BOT_ID, mark: null }]);
    });
    const returned = mocks.stored;
    if (returned === null) throw new Error("the host stored nothing");
    rerenderWith(returned);

    const own = drawCreatureMark(
      chosenCreatureMark(BOT_ID, ownCreature(BOT_ID)),
      40,
    ).path;
    expect(currentPath()).toBe(own);
    expect(pathIn(screen.getByTestId("bot-avatar"))).toBe(
      drawCreatureMark(chosenCreatureMark(BOT_ID, ownCreature(BOT_ID)), 24)
        .path,
    );
  });

  it("holds Regenerate patterns while a write is pending", async () => {
    let release: () => void = () => {};
    mocks.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const user = userEvent.setup();
    mount(BARE);
    const regenerate = screen.getByTestId<HTMLButtonElement>(
      "bot-settings-icon-regenerate",
    );
    expect(regenerate.disabled).toBe(false);

    await user.click(screen.getByTestId("bot-settings-icon-creature-3"));

    await waitFor(() => {
      expect(regenerate.disabled).toBe(true);
    });
    release();
    await waitFor(() => {
      expect(regenerate.disabled).toBe(false);
    });
  });
});
