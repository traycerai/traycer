/**
 * A bot's model settings over the REAL toolbar-store hook: only the host's
 * harness and model catalogue, the palette registration and the seeded
 * profile check are replaced (the boundaries `use-composer-toolbar-store.test`
 * replaces). When the panel is handed a new bot prop whose row names another
 * tuple than the one in the picker - a change made elsewhere, or a write the
 * host answered with something else - the picker's store moves to the row's
 * tuple and Apply has nothing left to apply. The new prop is supplied by the
 * test; how the open panel receives a refetched row is not exercised here.
 */
import { StrictMode, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

function buildTabHostClient(): HostClient<HostRpcRegistry> {
  const entry = {
    hostId: "host-1",
    label: "host-1",
    kind: "local" as const,
    websocketUrl: "ws://127.0.0.1:0/host-1",
    version: "0.0.0-mock",
    transportDialability: "dialable" as const,
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (id) => (id === entry.hostId ? entry : null),
    // Never dispatched: the catalogue hooks and the mutation are replaced.
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-host-1",
      handlers: {},
    }),
  });
  return spine.createRequester(entry);
}

function modelOption(harnessId: string, slug: string, efforts: string[]) {
  return {
    harnessId,
    slug,
    label: slug,
    description: null,
    isDefault: false,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: efforts.map((id) => ({
      id,
      label: id,
      description: null,
    })),
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

const mocks = vi.hoisted(() => ({
  tabHostClient: null as HostClient<HostRpcRegistry> | null,
  stores: [] as ComposerToolbarStore[],
  runSettingsClients: [] as Array<HostClient<HostRpcRegistry> | null>,
  updateRunSettings: vi.fn<(variables: object) => void>(),
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data: {
      harnesses: [
        { id: "claude", available: true },
        { id: "codex", available: true },
      ],
    },
  }),
  useGuiHarnessModelsQueryForClient: (_client: unknown, harnessId: string) => ({
    data: {
      models:
        harnessId === "codex"
          ? [modelOption("codex", "model-x", [])]
          : [
              modelOption("claude", "model-b", ["high"]),
              modelOption("claude", "model-c", ["high"]),
            ],
    },
  }),
}));
vi.mock("@/hooks/command-palette/use-register-composer-controls", () => ({
  useRegisterFocusedComposerControls: () => undefined,
}));
vi.mock("@/hooks/providers/use-resolved-seeded-profile-id", () => ({
  useResolvedSeededProfileId: (_harnessId: string, profileId: string | null) =>
    profileId,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.tabHostClient,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/bots/use-environment-set-main-bot-mutation", () => ({
  useEnvironmentSetMainBotMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
}));
// The picker's own rendering is not under test: it is handed the store the
// panel built, which is what the person's picks write to.
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: (props: { store: ComposerToolbarStore }) => {
    mocks.stores.push(props.store);
    return <div data-testid="stub-harness-model-picker" />;
  },
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => {
  const idle = { isPending: false, error: null, mutate: vi.fn() };
  return {
    useBotUpdateTitleMutation: () => idle,
    useBotDeleteMutation: () => idle,
    useBotUpdateReplyModeMutation: () => idle,
    useBotUpdateRunSettingsMutation: (
      client: HostClient<HostRpcRegistry> | null,
    ) => {
      mocks.runSettingsClients.push(client);
      return {
        isPending: false,
        error: null,
        mutate: mocks.updateRunSettings,
      };
    },
  };
});
vi.mock("@/hooks/bots/use-bot-notification-level", () => ({
  useBotNotificationLevelsQuery: () => ({ data: undefined, error: null }),
  useBotNotificationLevelSetMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
}));

import { BotChannelSettingsPanel } from "@/components/bots/bot-settings-panel";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";

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
  replyMode: "thread",
  appConversationChatId: null,
};

function panel(bot: BotRecord): ReactNode {
  return (
    <StrictMode>
      <BotChannelSettingsPanel
        bot={bot}
        isMain={null}
        personal={false}
        channelId={null}
        environmentBots={null}
        onClose={vi.fn()}
      />
    </StrictMode>
  );
}

function liveStore(): ComposerToolbarStore {
  const store = mocks.stores.at(-1);
  if (store === undefined) throw new Error("the picker was never rendered");
  return store;
}

function applyButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: "Apply" });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Apply is not a button element");
  }
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tabHostClient = buildTabHostClient();
  mocks.stores.length = 0;
  mocks.runSettingsClients.length = 0;
  useComposerHarnessMemoryStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
});

describe("<BotChannelSettingsPanel /> model, over the real toolbar store", () => {
  it("applies the pick through the tab host's client, then moves the picker to the refetched row's tuple", async () => {
    const user = userEvent.setup();
    const { rerender } = render(panel(BOT));
    fireEvent.click(screen.getByTestId("bot-settings-advanced-toggle"));
    expect(liveStore().getState().selection).toMatchObject({
      harnessId: "claude",
      modelSlug: "model-b",
    });

    act(() => {
      liveStore().getState().setSelection({
        harnessId: "claude",
        modelSlug: "model-c",
        profileId: "profile-1",
      });
    });
    await user.click(applyButton());
    expect(mocks.updateRunSettings).toHaveBeenCalledWith({
      botId: BOT.botId,
      harness: "claude",
      model: "model-c",
      effort: "high",
      profile: "profile-1",
    });
    expect(mocks.runSettingsClients.at(-1)).toBe(mocks.tabHostClient);

    // The refetched row names a tuple other than the one in the picker.
    rerender(
      panel({ ...BOT, harness: "codex", model: "model-x", effort: null }),
    );

    expect(liveStore().getState().selection).toMatchObject({
      harnessId: "codex",
      modelSlug: "model-x",
    });
    expect(applyButton().disabled).toBe(true);
  });
});
