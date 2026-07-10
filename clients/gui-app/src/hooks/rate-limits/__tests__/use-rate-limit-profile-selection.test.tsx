import "../../../../__tests__/test-browser-apis";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import {
  resolveRateLimitProfileId,
  useRateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";

const CODEX_TERMINAL_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const CHAT_TILE: EpicCanvasTileRef = {
  id: "chat-1",
  instanceId: "chat-tile-1",
  type: "chat",
  name: "Chat 1",
  hostId: "host-1",
};

const TERMINAL_TILE: EpicCanvasTileRef = {
  id: "terminal-1",
  instanceId: "terminal-tile-1",
  type: "terminal",
  name: "Terminal 1",
  titleSource: "default",
  hostId: "host-1",
  cwd: "/tmp",
};

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label: kind === "ambient" ? "Terminal" : profileId,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: {
      email: `${profileId}@example.com`,
      tier: "Pro",
      accountUuid: `${profileId}-uuid`,
    },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

const CODEX_PROFILES = [
  profile("ambient", "ambient"),
  profile("personal-profile", "managed"),
  profile("work-profile", "managed"),
];

const CLAUDE_PROFILES = [
  profile("ambient", "ambient"),
  profile("claude-work", "managed"),
];

function registerChatSession(): ChatSessionStoreHandle {
  return __getChatSessionRegistryForTests().acquire(
    "epic-1",
    CHAT_TILE.id,
    "test:epic-1:chat-1",
    (epicId, chatId) =>
      createChatSessionStore({
        epicId,
        chatId,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          close: () => undefined,
        }),
      }),
  );
}

function setFocusedTile(tile: EpicCanvasTileRef): void {
  const canvas: EpicCanvasState = {
    root: {
      kind: "pane",
      id: "pane-1",
      tabInstanceIds: [tile.instanceId],
      activeTabId: tile.instanceId,
      previewTabId: null,
      activationHistory: [tile.instanceId],
    },
    activePaneId: "pane-1",
    tilesByInstanceId: { [tile.instanceId]: tile },
    sizesByGroupId: {},
  };
  useEpicCanvasStore.setState({
    tabsById: {
      "view-tab-1": {
        tabId: "view-tab-1",
        epicId: "epic-1",
        name: "Epic 1",
      },
    },
    canvasByTabId: { "view-tab-1": canvas },
    openTabOrder: ["view-tab-1"],
    activeTabId: "view-tab-1",
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
  __getChatSessionRegistryForTests().disposeAll();
});

afterEach(() => {
  cleanup();
  __getChatSessionRegistryForTests().disposeAll();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
});

describe("rate-limit profile selection", () => {
  it("uses the focused chat profile for its harness and per-harness memory for the other glyph", () => {
    const memory = useComposerHarnessMemoryStore.getState();
    memory.recordProfileSelection("codex", "personal-profile");
    memory.recordProfileSelection("claude", "claude-work");
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(
        { ...CODEX_TERMINAL_SETTINGS, profileId: "personal-profile" },
        1,
      );
    const handle = registerChatSession();
    handle.store.getState().setCurrentComposerSettings(CODEX_TERMINAL_SETTINGS);
    setFocusedTile(CHAT_TILE);

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      const selection = useRateLimitProfileSelection();
      return {
        codex: resolveRateLimitProfileId(selection, "codex", CODEX_PROFILES),
        claude: resolveRateLimitProfileId(
          selection,
          "claude-code",
          CLAUDE_PROFILES,
        ),
      };
    });

    // Regression: the active Codex chat is Terminal, so its live null profile
    // wins over remembered Personal. Claude independently keeps its own memory.
    expect(result.current).toEqual({ codex: null, claude: "claude-work" });

    const settledRenderCount = renderCount;
    act(() => {
      handle.store.setState({ runStatus: "running" });
    });
    // Token/run/approval updates share this store and can be very frequent;
    // the header subscription filters them before they can schedule React.
    expect(renderCount).toBe(settledRenderCount);

    act(() => {
      handle.store.getState().setCurrentComposerSettings({
        ...CODEX_TERMINAL_SETTINGS,
        profileId: "work-profile",
      });
    });
    expect(result.current).toEqual({
      codex: "work-profile",
      claude: "claude-work",
    });
    expect(renderCount).toBeGreaterThan(settledRenderCount);
  });

  it("uses per-harness memory when the focused pane is not a chat and falls back to Terminal for stale ids", () => {
    const memory = useComposerHarnessMemoryStore.getState();
    memory.recordProfileSelection("codex", "personal-profile");
    memory.recordProfileSelection("claude", "removed-profile");
    registerChatSession()
      .store.getState()
      .setCurrentComposerSettings({
        ...CODEX_TERMINAL_SETTINGS,
        profileId: "work-profile",
      });
    setFocusedTile(TERMINAL_TILE);

    const { result } = renderHook(() => {
      const selection = useRateLimitProfileSelection();
      return {
        codex: resolveRateLimitProfileId(selection, "codex", CODEX_PROFILES),
        claude: resolveRateLimitProfileId(
          selection,
          "claude-code",
          CLAUDE_PROFILES,
        ),
      };
    });

    expect(result.current).toEqual({
      codex: "personal-profile",
      claude: null,
    });
  });
});
