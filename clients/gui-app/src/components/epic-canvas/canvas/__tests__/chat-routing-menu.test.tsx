import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/persistence/epic/schemas";
import { chatRecordSchema } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ChatRoutingContextMenuGroup,
  ChatRoutingTabMenu,
} from "@/components/epic-canvas/canvas/chat-routing-menu";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  agentConfigureCarriesRouting,
  buildRoutingConfigureRequest,
  chatRoutingOf,
} from "@/lib/chat/chat-routing-setting";

const hoisted = vi.hoisted(() => ({
  mutate: vi.fn(),
  schemaVersion: { major: 7, minor: 1 },
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => hoisted.schemaVersion,
}));
vi.mock("@/hooks/agent/use-configure-agent-mutation", () => ({
  useAgentConfigure: () => ({ mutate: hoisted.mutate, isPending: false }),
}));

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: "work",
};

const CHAT_RECORD = {
  id: "chat-1",
  parentId: null,
  userId: "user-1",
  hostId: "host-1",
  title: "A chat",
  createdAt: 1,
  updatedAt: 1,
  isTitleEditedByUser: false,
  settings: SETTINGS,
  activeSessionChain: null,
  claudePendingWakes: [],
  messages: [],
  events: [],
  archivedAt: null,
  pinnedUserProviderHandle: null,
  lastDeliveredRolesDigest: null,
};

describe("the routing choice a chat carries", () => {
  it("reads an absent choice as following the device", () => {
    expect(chatRoutingOf({})).toBe("policy");
    expect(chatRoutingOf({ routing: "hold" })).toBe("hold");
  });

  it("survives the chat record the host sends, and a record without it still parses", () => {
    const base = CHAT_RECORD;
    const held = chatRecordSchema.parse({ ...base, routing: "hold" });
    expect(chatRoutingOf(held)).toBe("hold");
    expect(chatRoutingOf(chatRecordSchema.parse(base))).toBe("policy");
  });
});

describe("the agent.configure request that changes only the routing", () => {
  it("restates the persisted tuple, keeps the permission mode and names the chat as both caller and target", () => {
    expect(
      buildRoutingConfigureRequest({
        epicId: "epic-1",
        chatId: "chat-1",
        settings: SETTINGS,
        routing: "hold",
      }),
    ).toEqual({
      epicId: "epic-1",
      senderAgentId: "chat-1",
      agentId: "chat-1",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      profileSelection: { kind: "profile", profileId: "work" },
      reasoningEffort: "high",
      fastMode: false,
      serviceTier: null,
      permissionMode: null,
      routing: "hold",
    });
  });

  it("preserves a named service tier and an unpinned account", () => {
    const request = buildRoutingConfigureRequest({
      epicId: "epic-1",
      chatId: "chat-1",
      settings: { ...SETTINGS, serviceTier: "priority", profileId: null },
      routing: "policy",
    });
    expect(request?.fastMode).toBe(true);
    expect(request?.serviceTier).toBe("priority");
    expect(request?.profileSelection).toEqual({ kind: "ambient" });
    expect(request).toEqual({
      epicId: "epic-1",
      senderAgentId: "chat-1",
      agentId: "chat-1",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      profileSelection: { kind: "ambient" },
      reasoningEffort: "high",
      fastMode: true,
      serviceTier: "priority",
      permissionMode: null,
      routing: "policy",
    });
  });

  it("has nothing to restate before the chat has a run tuple", () => {
    expect(
      buildRoutingConfigureRequest({
        epicId: "epic-1",
        chatId: "chat-1",
        settings: null,
        routing: "hold",
      }),
    ).toBeNull();
  });

  it("requires 7.1 for an unpinned tier and 7.2 to preserve a named tier", () => {
    expect(agentConfigureCarriesRouting(null, null)).toBe(false);
    expect(agentConfigureCarriesRouting({ major: 7, minor: 0 }, null)).toBe(
      false,
    );
    expect(agentConfigureCarriesRouting({ major: 7, minor: 1 }, null)).toBe(
      true,
    );
    expect(
      agentConfigureCarriesRouting({ major: 7, minor: 1 }, "priority"),
    ).toBe(false);
    expect(
      agentConfigureCarriesRouting({ major: 7, minor: 2 }, "priority"),
    ).toBe(true);
    expect(
      agentConfigureCarriesRouting({ major: 8, minor: 0 }, "priority"),
    ).toBe(true);
  });
});

describe("the setting in the tab menu", () => {
  afterEach(cleanup);

  function openMenu(
    onChange: (routing: string) => void,
    value: "policy" | "hold",
  ) {
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <span data-testid="tab">tab</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ChatRoutingContextMenuGroup
            value={value}
            disabled={false}
            onChange={onChange}
          />
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("tab"));
  }

  it("names the setting and offers the two choices, with the current one checked", async () => {
    openMenu(vi.fn(), "hold");

    const trigger = await screen.findByText("On a usage limit or error");
    fireEvent.keyDown(trigger, { key: "ArrowRight" });

    const follow = await screen.findByRole("menuitemradio", {
      name: "Follow the device routing",
    });
    const wait = await screen.findByRole("menuitemradio", {
      name: "Wait it out here",
    });
    expect(follow.getAttribute("aria-checked")).toBe("false");
    expect(wait.getAttribute("aria-checked")).toBe("true");
  });

  it("reports the choice the person makes", async () => {
    const onChange = vi.fn();
    openMenu(onChange, "policy");

    const trigger = await screen.findByText("On a usage limit or error");
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Wait it out here" }),
    );

    expect(onChange).toHaveBeenCalledWith("hold");
  });
});

describe("the setting for an open chat", () => {
  const registry = getChatSessionRegistry();
  afterEach(() => {
    cleanup();
    hoisted.mutate.mockReset();
    hoisted.schemaVersion = { major: 7, minor: 1 };
    registry.disposeAll();
  });

  /** A chat session the way the tab's tile holds it, over a stream that goes nowhere. */
  function openSession(
    role: "owner" | "viewer",
    settings: ChatRunSettings,
  ): void {
    const handle = registry.acquire(
      {
        epicId: "epic-1",
        chatId: "chat-1",
        hostId: "host-1",
        scopeKey: "routing-menu",
      },
      () =>
        createChatSessionStore({
          environment: CHAT_STORE_TEST_ENVIRONMENT,
          hostId: "host-1",
          epicId: "epic-1",
          chatId: "chat-1",
          userId: "user-1",
          onAuthError: null,
          onProviderAuthError: null,
          wakeTransport: null,
          streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
          streamClientFactory: () => ({
            sendAction: () => undefined,
            sameTurnSteeringProtocolSupported: () => true,
            draftBlobBridgeSupported: () => true,
            requestTranscriptRange: () => undefined,
            requestResnapshot: () => undefined,
            close: () => undefined,
          }),
        }),
    );
    handle.store.setState({
      chat: chatRecordSchema.parse({ ...CHAT_RECORD, settings }),
      access: { role, ownerUserId: "user-1", canAct: role === "owner" },
    });
  }

  function openMenu(): void {
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <span data-testid="tab">tab</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ChatRoutingTabMenu epicId="epic-1" chatId="chat-1" hostId="host-1" />
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("tab"));
  }

  it("sends the chat's own restated tuple with the new routing when its owner picks it", async () => {
    openSession("owner", SETTINGS);
    openMenu();

    const trigger = await screen.findByText("On a usage limit or error");
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Wait it out here" }),
    );

    expect(hoisted.mutate).toHaveBeenCalledWith({
      epicId: "epic-1",
      senderAgentId: "chat-1",
      agentId: "chat-1",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      profileSelection: { kind: "profile", profileId: "work" },
      reasoningEffort: "high",
      fastMode: false,
      serviceTier: null,
      permissionMode: null,
      routing: "hold",
    });
  });

  it("hides the setting when 7.1 cannot preserve a named tier", () => {
    openSession("owner", { ...SETTINGS, serviceTier: "priority" });
    openMenu();

    expect(screen.queryByText("On a usage limit or error")).toBeNull();
  });

  it("offers the setting when 7.2 can preserve a named tier", async () => {
    hoisted.schemaVersion = { major: 7, minor: 2 };
    openSession("owner", { ...SETTINGS, serviceTier: "priority" });
    openMenu();

    expect(await screen.findByText("On a usage limit or error")).toBeTruthy();
  });

  it("cannot be changed from a chat shared with the person as a viewer", async () => {
    openSession("viewer", SETTINGS);
    openMenu();

    const trigger = await screen.findByText("On a usage limit or error");
    expect(trigger.closest("[data-disabled]")).not.toBeNull();
  });

  // The menu was opened on a tab whose chat had no session yet; the stale peek
  // memo left the setting out for as long as the menu stayed up.
  it("offers the setting once the chat's session opens while the menu is up", () => {
    openMenu();
    expect(screen.queryByText("On a usage limit or error")).toBeNull();

    act(() => openSession("owner", SETTINGS));

    expect(screen.getByText("On a usage limit or error")).toBeDefined();
  });
});
