import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
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
import {
  agentConfigureCarriesRouting,
  buildRoutingConfigureRequest,
  chatRoutingOf,
} from "@/lib/chat/chat-routing-setting";

const hoisted = vi.hoisted(() => ({
  session: { current: null as { store: unknown } | null },
  mutate: vi.fn(),
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  getChatSessionRegistry: () => ({ peek: () => hoisted.session.current }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => ({ major: 7, minor: 1 }),
}));
vi.mock("@/hooks/agent/use-configure-agent-mutation", () => ({
  useAgentConfigure: () => ({ mutate: hoisted.mutate, isPending: false }),
}));

const SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: "work",
};

describe("the routing choice a chat carries", () => {
  it("reads an absent choice as following the device", () => {
    expect(chatRoutingOf({})).toBe("policy");
    expect(chatRoutingOf({ routing: "hold" })).toBe("hold");
  });

  it("survives the chat record the host sends, and a record without it still parses", () => {
    const base = {
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
      permissionMode: null,
      routing: "hold",
    });
  });

  it("carries a fast tier as fast mode and an unpinned account as ambient", () => {
    const request = buildRoutingConfigureRequest({
      epicId: "epic-1",
      chatId: "chat-1",
      settings: { ...SETTINGS, serviceTier: "fast", profileId: null },
      routing: "policy",
    });
    expect(request?.fastMode).toBe(true);
    expect(request?.profileSelection).toEqual({ kind: "ambient" });
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

  it("is offered only to a host whose agent.configure carries the field", () => {
    expect(agentConfigureCarriesRouting(null)).toBe(false);
    expect(agentConfigureCarriesRouting({ major: 7, minor: 0 })).toBe(false);
    expect(agentConfigureCarriesRouting({ major: 7, minor: 1 })).toBe(true);
    expect(agentConfigureCarriesRouting({ major: 8, minor: 0 })).toBe(true);
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
  afterEach(() => {
    cleanup();
    hoisted.mutate.mockReset();
    hoisted.session.current = null;
  });

  function openFor(role: "owner" | "viewer") {
    hoisted.session.current = {
      store: createStore(() => ({
        chat: { id: "chat-1", settings: SETTINGS, routing: "policy" },
        access: { role, canAct: role === "owner" },
      })),
    };
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
    openFor("owner");

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
      permissionMode: null,
      routing: "hold",
    });
  });

  it("cannot be changed from a chat shared with the person as a viewer", async () => {
    openFor("viewer");

    const trigger = await screen.findByText("On a usage limit or error");
    expect(trigger.closest("[data-disabled]")).not.toBeNull();
  });
});
