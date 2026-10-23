/**
 * A bot's settings (Tracy Bots). Model: the picker opens on what the bot
 * RUNS, not on the app default, so Apply has nothing to apply until the
 * person changes something. The toolbar-store hook is replaced by one that
 * records the seed source it was given and builds a REAL toolbar store from
 * it, so what the picker would show and what Apply compares are the
 * production store's own values.
 *
 * No control is gated on which host serves the tab (the panel takes no
 * `canEdit`): every control is live, and a host that refuses a write has the
 * refusal shown in place, under the control that made it.
 */
import { StrictMode, useState } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { ComposerSeedSource } from "@/lib/composer/composer-seed-source";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { ModelOption } from "@/components/home/data/landing-options";
import {
  maxModeListedFor,
  type MaxModeContext,
} from "@/components/home/data/model-max-mode";

const mocks = vi.hoisted(() => ({
  hostClient: { stub: "tab-host-client" },
  seeds: [] as ComposerSeedSource[],
  stores: [] as ComposerToolbarStore[],
  // Every `maxModeContext` the (stubbed) picker was rendered with, one per render.
  pickerContexts: [] as MaxModeContext[],
  updateRunSettings: vi.fn<(variables: object) => void>(),
  updateTitle: vi.fn<(variables: object) => void>(),
  deleteBot: vi.fn<(variables: object) => void>(),
  // What each write's mutation reports as its error; `null` = no refusal.
  refusal: {
    title: null as string | null,
    runSettings: null as string | null,
    remove: null as string | null,
  },
}));

function refusalOf(message: string | null): { message: string } | null {
  return message === null ? null : { message };
}

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.hostClient,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: (props: { maxModeContext: MaxModeContext }) => {
    mocks.pickerContexts.push(props.maxModeContext);
    return <div data-testid="stub-harness-model-picker" />;
  },
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotUpdateTitleMutation: () => ({
    isPending: false,
    error: refusalOf(mocks.refusal.title),
    mutate: mocks.updateTitle,
  }),
  useBotDeleteMutation: () => ({
    isPending: false,
    error: refusalOf(mocks.refusal.remove),
    mutate: mocks.deleteBot,
  }),
  useBotUpdateRunSettingsMutation: () => ({
    isPending: false,
    error: refusalOf(mocks.refusal.runSettings),
    mutate: mocks.updateRunSettings,
  }),
}));
vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createComposerToolbarStore } =
    await import("@/stores/composer/composer-toolbar-store");
  return {
    useComposerToolbarStore: (
      _registerAs: string | null,
      seedSource: ComposerSeedSource,
    ): ComposerToolbarStore => {
      mocks.seeds.push(seedSource);
      const [store] = useState(() => {
        const settings =
          seedSource.kind === "none" ? null : seedSource.settings;
        const created = createComposerToolbarStore({
          purpose: "run",
          reasoningFallback: "model-default",
          seedKey: "bot-settings-test",
          values: {
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
          hostId: "host-1",
        });
        return created;
      });
      // StrictMode runs the initializer twice and keeps one result, so the
      // store in use is the one the hook returns, recorded here.
      mocks.stores.push(store);
      return store;
    },
  };
});

import { BotSettingsPanel } from "@/components/bots/bot-settings-panel";
import { useSettingsStore } from "@/stores/settings/settings-store";

const BOT: BotRecord = {
  botId: "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  environmentId: "env-personal",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "model-b",
  effort: "high",
  profile: "profile-1",
  trunkChatId: "trunk-1",
  boundHostId: "host-1",
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
};

function mountPanel(bot: BotRecord): void {
  render(
    <StrictMode>
      <BotSettingsPanel bot={bot} />
    </StrictMode>,
  );
}

function applyButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: "Apply" });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Apply is not a button element");
  }
  return button;
}

function liveStore(): ComposerToolbarStore {
  const store = mocks.stores.at(-1);
  if (store === undefined) throw new Error("no toolbar store was created");
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.seeds.length = 0;
  mocks.stores.length = 0;
  mocks.pickerContexts.length = 0;
  mocks.refusal.title = null;
  mocks.refusal.runSettings = null;
  mocks.refusal.remove = null;
});

afterEach(() => {
  cleanup();
});

describe("<BotSettingsPanel /> model", () => {
  it("seeds the picker with what the bot runs and leaves Apply disabled", () => {
    mountPanel(BOT);

    const seed = mocks.seeds.at(-1);
    expect(seed).toEqual({
      kind: "fallback",
      settings: {
        harnessId: "claude",
        model: "model-b",
        permissionMode: useSettingsStore.getState().defaultPermission,
        reasoningEffort: "high",
        serviceTier: null,
        agentMode: "regular",
        profileId: "profile-1",
      },
      client: mocks.hostClient,
    });
    expect(applyButton().disabled).toBe(true);
  });

  it("enables Apply once the person picks another model, and applies exactly that", async () => {
    const user = userEvent.setup();
    mountPanel(BOT);
    expect(applyButton().disabled).toBe(true);

    act(() => {
      liveStore().getState().setSelection({
        harnessId: "claude",
        modelSlug: "model-c",
        profileId: "profile-1",
      });
    });
    expect(applyButton().disabled).toBe(false);

    await user.click(applyButton());
    expect(mocks.updateRunSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateRunSettings).toHaveBeenCalledWith({
      botId: BOT.botId,
      harness: "claude",
      model: "model-c",
      effort: "high",
      profile: "profile-1",
    });
  });

  it("disables Apply again when the person picks the bot's own model back", () => {
    mountPanel(BOT);

    act(() => {
      liveStore().getState().setSelection({
        harnessId: "claude",
        modelSlug: "model-c",
        profileId: "profile-1",
      });
    });
    expect(applyButton().disabled).toBe(false);

    act(() => {
      liveStore().getState().setSelection({
        harnessId: "claude",
        modelSlug: "model-b",
        profileId: "profile-1",
      });
    });
    expect(applyButton().disabled).toBe(true);
  });

  it("seeds nothing when the bot's harness is not one this client can pick", () => {
    mountPanel({ ...BOT, harness: "not-a-harness" });

    expect(mocks.seeds.at(-1)).toEqual({ kind: "none" });
  });
});

describe("<BotSettingsPanel /> controls", () => {
  it("renames through the tab host with the trimmed name", async () => {
    const user = userEvent.setup();
    mountPanel(BOT);

    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "  Renamed Bot  ");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(mocks.updateTitle).toHaveBeenCalledTimes(1);
    expect(mocks.updateTitle.mock.calls[0][0]).toEqual({
      botId: BOT.botId,
      title: "Renamed Bot",
    });
  });
});

describe("<BotSettingsPanel /> refusals", () => {
  it("shows no refusal line while every write is accepted", () => {
    mountPanel(BOT);

    expect(screen.queryByTestId("bot-settings-refusal")).toBeNull();
  });

  it("states a rename refusal under the name field, and nowhere else", () => {
    mocks.refusal.title = "Only the bot's owner can rename it";
    mountPanel(BOT);

    const refusals = screen.getAllByTestId("bot-settings-refusal");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].textContent).toBe("Only the bot's owner can rename it");
    expect(refusals[0].getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("bot-settings-title").contains(refusals[0])).toBe(
      true,
    );
  });

  it("states a model refusal inside the model section, and nowhere else", () => {
    mocks.refusal.runSettings = "This machine cannot change the model";
    mountPanel(BOT);

    const refusals = screen.getAllByTestId("bot-settings-refusal");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].textContent).toBe(
      "This machine cannot change the model",
    );
    expect(screen.getByTestId("bot-settings-model").contains(refusals[0])).toBe(
      true,
    );
  });

  it("states a delete refusal inside the confirm dialog, not on the panel", async () => {
    const user = userEvent.setup();
    mocks.refusal.remove = "Only the bot's owner can delete it";
    mountPanel(BOT);
    // Closed: the refusal lives in the dialog, which is not rendered yet.
    expect(screen.queryByTestId("bot-settings-refusal")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete bot" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("bot-settings-refusal").textContent).toBe(
      "Only the bot's owner can delete it",
    );
    expect(mocks.deleteBot).not.toHaveBeenCalled();
  });

  it("deletes the bot when the confirm dialog is confirmed", async () => {
    const user = userEvent.setup();
    mountPanel(BOT);

    await user.click(screen.getByRole("button", { name: "Delete bot" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Delete bot" }),
    );

    expect(mocks.deleteBot).toHaveBeenCalledTimes(1);
    expect(mocks.deleteBot.mock.calls[0][0]).toEqual({ botId: BOT.botId });
  });
});

// The bot's next turn runs its stored harness/model/effort/profile with NO
// service tier (`serviceTier: null`), so the pre-send Max Mode label must be
// keyed on that exact tuple: the bot's effort, Fast off.
describe("<BotSettingsPanel /> Max Mode label", () => {
  const CURSOR_BOT: BotRecord = {
    ...BOT,
    harness: "cursor",
    model: "cursor-max",
    effort: "high",
  };

  function cursorRow(
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
      metadata: {
        maxMode: { chat, judge: [], fastServiceTierId: "fast" },
      },
    };
  }

  function lastContext(): MaxModeContext {
    const context = mocks.pickerContexts.at(-1);
    if (context === undefined) throw new Error("the picker never rendered");
    return context;
  }

  it("hands the picker the bot's own tuple: its effort and Fast off, never the none context", () => {
    mountPanel(CURSOR_BOT);

    expect(lastContext()).toEqual({
      kind: "chat",
      tuple: { reasoningEffort: "high", serviceTier: null },
    });
  });

  it("lists Max at the bot's selected effort with Fast off", () => {
    mountPanel(CURSOR_BOT);

    expect(
      maxModeListedFor(
        cursorRow([{ reasoningEffort: "high", fast: false }]),
        lastContext(),
      ),
    ).toBe(true);
  });

  it("does not list Max when only another effort is Max-only", () => {
    mountPanel(CURSOR_BOT);

    expect(
      maxModeListedFor(
        cursorRow([{ reasoningEffort: "low", fast: false }]),
        lastContext(),
      ),
    ).toBe(false);
  });

  it("does not list Max when only the Fast-on selection is Max-only", () => {
    mountPanel(CURSOR_BOT);

    expect(
      maxModeListedFor(
        cursorRow([{ reasoningEffort: "high", fast: true }]),
        lastContext(),
      ),
    ).toBe(false);
  });

  it("does not re-render the owner (and so the picker) when only the catalog moves", () => {
    mountPanel(CURSOR_BOT);
    const apply = () =>
      act(() => {
        liveStore().getState().setCatalog({
          hostId: "host-1",
          chatLineCarriesAutoMode: null,
          harnesses: undefined,
          modelsHarnessId: "cursor",
          models: [],
          modelsLoaded: false,
          tuiOnly: false,
        });
      });
    // The first write may settle derived state; a second write with fresh
    // arrays and the same values must not render the owner again. A broad
    // `useStore(toolbarStore)` there feeds the catalog effect that owns the
    // write, which is the update-depth loop.
    apply();
    const settled = mocks.pickerContexts.length;
    apply();
    apply();

    expect(mocks.pickerContexts.length).toBe(settled);
  });
});
