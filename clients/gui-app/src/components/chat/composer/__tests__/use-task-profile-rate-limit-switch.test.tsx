import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ModelOption } from "@/components/home/data/landing-options";
import type {
  ChatProjection,
  ChatsSlice,
} from "@/stores/epics/open-epic/types";
import { useTaskProfileRateLimitSwitch } from "../use-task-profile-rate-limit-switch";

const TAB_HOST_ID = "host-a";
const OTHER_HOST_ID = "host-b";
const EPIC_ID = "epic-1";
const CURRENT_CHAT_ID = "chat-current";

const epicRecords = vi.hoisted(() => {
  let state: {
    readonly chatRecords: ChatsSlice;
    readonly chats: ChatsSlice;
  } = {
    chatRecords: { byId: {}, allIds: [] },
    chats: { byId: {}, allIds: [] },
  };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(next: typeof state): void {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const batch = vi.hoisted(() => ({
  chatIds: [] as ReadonlyArray<string>,
  settingsByChatId: new Map<string, ChatRunSettings>(),
}));
const updateProfile = vi.hoisted(() => vi.fn());
const tabHostClient = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => TAB_HOST_ID,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => tabHostClient,
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({ store: epicRecords }),
}));

vi.mock("@/hooks/chats/use-chat-run-settings-query", () => ({
  useChatRunSettingsBatch: (args: {
    readonly chatIds: ReadonlyArray<string>;
  }) => {
    batch.chatIds = args.chatIds;
    return args.chatIds.map((chatId) => ({
      data: { settings: batch.settingsByChatId.get(chatId) ?? null },
    }));
  },
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicUpdateChatProfile: () => ({ mutate: updateProfile }),
}));

function settings(overrides: Partial<ChatRunSettings> = {}): ChatRunSettings {
  return {
    harnessId: "claude",
    model: "opus[1m]",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: "limited",
    ...overrides,
  };
}

function chat(id: string, hostId: string | null): ChatProjection {
  return {
    id,
    title: id,
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    userId: "viewer",
    hostId,
    isTitleEditedByUser: false,
    settings: null,
    archivedAt: null,
    docResident: false,
  };
}

function slice(chats: ReadonlyArray<ChatProjection>): ChatsSlice {
  return {
    allIds: chats.map((entry) => entry.id),
    byId: Object.fromEntries(chats.map((entry) => [entry.id, entry])),
  };
}

const SELECTED_MODEL: ModelOption = {
  harnessId: "claude",
  slug: "opus[1m]",
  label: "Opus",
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  defaultReasoningEffort: null,
  supportedReasoningEfforts: [],
  defaultServiceTier: null,
  supportedServiceTiers: [],
  metadata: {},
};

describe("useTaskProfileRateLimitSwitch", () => {
  beforeEach(() => {
    epicRecords.setState({
      chatRecords: { byId: {}, allIds: [] },
      chats: { byId: {}, allIds: [] },
    });
    batch.chatIds = [];
    batch.settingsByChatId.clear();
    updateProfile.mockReset();
  });

  afterEach(cleanup);

  it("switches matching registry chats on the tab host without reading legacy or cross-host chats", () => {
    const sameHostMatch = chat("chat-same-match", TAB_HOST_ID);
    const sameHostDifferentModel = chat("chat-same-other-model", TAB_HOST_ID);
    const crossHostMatch = chat("chat-cross-host", OTHER_HOST_ID);
    const current = chat(CURRENT_CHAT_ID, TAB_HOST_ID);
    const legacy = chat("chat-legacy", TAB_HOST_ID);

    epicRecords.setState({
      chatRecords: slice([
        current,
        sameHostMatch,
        sameHostDifferentModel,
        crossHostMatch,
      ]),
      // A doc-only chat appears in the combined projection but deliberately
      // not in `chatRecords`; new-chat-only switching must ignore it.
      chats: slice([
        current,
        sameHostMatch,
        sameHostDifferentModel,
        crossHostMatch,
        legacy,
      ]),
    });
    batch.settingsByChatId.set(sameHostMatch.id, settings());
    batch.settingsByChatId.set(
      sameHostDifferentModel.id,
      settings({ model: "sonnet" }),
    );
    batch.settingsByChatId.set(crossHostMatch.id, settings());
    batch.settingsByChatId.set(legacy.id, settings());

    const { result } = renderHook(() =>
      useTaskProfileRateLimitSwitch({
        enabled: true,
        harnessId: "claude",
        profileId: "limited",
        selectedModel: SELECTED_MODEL,
        epicId: EPIC_ID,
        chatId: CURRENT_CHAT_ID,
      }),
    );

    expect(batch.chatIds).toEqual([
      sameHostMatch.id,
      sameHostDifferentModel.id,
    ]);
    expect(result.current.affectedChatCount).toBe(2);

    act(() => result.current.switchOtherTaskChats("fresh"));

    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      chatId: sameHostMatch.id,
      profileId: "fresh",
    });
  });
});
