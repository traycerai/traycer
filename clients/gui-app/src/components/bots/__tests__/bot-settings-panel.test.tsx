/**
 * A bot's model settings (Tracy Bots): the picker opens on what the bot RUNS,
 * not on the app default, so Apply has nothing to apply until the person
 * changes something. The toolbar-store hook is replaced by one that records
 * the seed source it was given and builds a REAL toolbar store from it, so
 * what the picker would show and what Apply compares are the production
 * store's own values.
 */
import { StrictMode, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { guiHarnessIdSchema } from "@traycer/protocol/host/index";
import type { ComposerSeedSource } from "@/lib/composer/composer-seed-source";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

const mocks = vi.hoisted(() => ({
  hostClient: { stub: "tab-host-client" },
  seeds: [] as ComposerSeedSource[],
  stores: [] as ComposerToolbarStore[],
  updateRunSettings: vi.fn<(variables: object) => void>(),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.hostClient,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div data-testid="stub-harness-model-picker" />,
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotUpdateTitleMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useBotDeleteMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useBotUpdateRunSettingsMutation: () => ({
    isPending: false,
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
};

function mountPanel(bot: BotRecord, canEdit: boolean): void {
  render(
    <StrictMode>
      <BotSettingsPanel bot={bot} canEdit={canEdit} />
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
});

afterEach(() => {
  cleanup();
});

describe("<BotSettingsPanel /> model", () => {
  it("seeds the picker with what the bot runs and leaves Apply disabled", () => {
    expect(guiHarnessIdSchema.safeParse(BOT.harness).success).toBe(true);
    mountPanel(BOT, true);

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
    expect(liveStore().getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "model-b",
      profileId: "profile-1",
    });
    expect(applyButton().disabled).toBe(true);
  });

  it("enables Apply once the person picks another model, and applies exactly that", async () => {
    const user = userEvent.setup();
    mountPanel(BOT, true);
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
    mountPanel(BOT, true);

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

  it("keeps Apply disabled for a bot this host cannot edit, whatever the picker holds", () => {
    mountPanel(BOT, false);

    act(() => {
      liveStore().getState().setSelection({
        harnessId: "claude",
        modelSlug: "model-c",
        profileId: "profile-1",
      });
    });
    expect(applyButton().disabled).toBe(true);
  });

  it("seeds nothing when the bot's harness is not one this client can pick", () => {
    mountPanel({ ...BOT, harness: "not-a-harness" }, true);

    expect(mocks.seeds.at(-1)).toEqual({ kind: "none" });
  });
});
