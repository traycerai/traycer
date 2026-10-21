import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  ChatServingKey,
  ChatServingVerdict,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  poolEntry,
  remoteEntry,
  sandboxFacts,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { ChatServing } from "@traycer/protocol/host/chat-serving/index";
import {
  ChatServingWitnessContext,
  useChatServing,
} from "@/lib/chats/chat-serving-witness";
import type { RetainingChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";

const CHAT: ChatServingKey = {
  hostId: "host-sandbox",
  epicId: "epic-1",
  chatId: "chat-1",
};

const state = vi.hoisted(
  (): {
    entry: HostDirectoryEntry | null;
    armChats: readonly CloudChatSummary[];
  } => ({ entry: null, armChats: [] }),
);

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => state.entry,
}));

vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    return {
      ...actual,
      readProcessHostRpcTierPlan: () => actual.createHostRpcTierPlan(poolEntry),
    };
  },
);

vi.mock("@/hooks/environment/use-environment-arms", () => ({
  useEnvironmentArmChats: () => state.armChats,
}));

class RecordingWitness implements RetainingChatServingWitness {
  retains = 0;
  releases = 0;

  verdictFor(_chat: ChatServingKey): ChatServingVerdict {
    return "unknown";
  }

  servingFor(_chat: ChatServingKey): ChatServing | null {
    return null;
  }

  subscribe(_listener: () => void): () => void {
    return () => undefined;
  }

  retain(_chat: ChatServingKey): () => void {
    this.retains += 1;
    return () => {
      this.releases += 1;
    };
  }
}

function armRow(chatId: string): CloudChatSummary {
  return {
    identity: { taskId: CHAT.epicId, chatId, ownerUserId: "viewer-1" },
    ownerHostId: CHAT.hostId,
    createdAt: 1,
    visibility: "task",
    title: chatId,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: true,
  };
}

function mount(witness: RecordingWitness) {
  state.entry = remoteEntry(CHAT.hostId, sandboxFacts("team-1"));
  state.armChats = [];
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(ChatServingWitnessContext.Provider, {
      value: witness,
      children,
    });
  return renderHook(() => useChatServing(CHAT), { wrapper });
}

describe("useChatServing re-subscribes when the chat reaches the environment arm", () => {
  afterEach(() => {
    cleanup();
    state.entry = null;
    state.armChats = [];
  });

  it("releases and retains again once the chat's row appears, and not on a rerender that still holds it", () => {
    const witness = new RecordingWitness();
    const view = mount(witness);
    expect(witness.retains).toBe(1);
    expect(witness.releases).toBe(0);

    state.armChats = [armRow("chat-other")];
    view.rerender();
    expect(witness.retains).toBe(1);

    state.armChats = [armRow("chat-other"), armRow(CHAT.chatId)];
    view.rerender();
    expect(witness.releases).toBe(1);
    expect(witness.retains).toBe(2);

    state.armChats = [armRow("chat-other"), armRow(CHAT.chatId)];
    view.rerender();
    expect(witness.releases).toBe(1);
    expect(witness.retains).toBe(2);
  });
});
