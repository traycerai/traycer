import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import * as Y from "yjs";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { TeardownForceDeleteDialog } from "@/components/worktree/teardown-force-delete-dialog";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

const HOLDER: WorktreeBusyHolder = {
  ownerRef: {
    epicId: "epic-1",
    ownerKind: "chat",
    ownerId: "chat-1",
  },
  holdKind: "chat-turn",
  activity: "working",
  label: "Old title is working",
};

function seedOpenEpicWithChatTitle(title: string): {
  rename: (next: string) => void;
} {
  let chatsById: Record<string, { readonly id: string; readonly title: string }> =
    {
      "chat-1": { id: "chat-1", title },
    };
  const listeners = new Set<() => void>();
  const doc = new Y.Doc();
  const handle = {
    store: {
      getState: () => ({
        chats: { allIds: ["chat-1"] as const, byId: chatsById },
        tuiAgents: { allIds: [] as const, byId: {} },
        snapshotMeta: null,
        isDirty: false,
        unsyncedQueueSize: 0,
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    doc,
    isClean: () => true,
    dispose: () => undefined,
    detachTransport: () => undefined,
  } as unknown as OpenEpicStoreHandle;
  __getOpenEpicRegistryForTests().acquire("epic-1", () => handle);
  return {
    rename: (next: string) => {
      chatsById = { "chat-1": { id: "chat-1", title: next } };
      for (const listener of listeners) listener();
    },
  };
}

describe("useTeardownAgentNames", () => {
  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
  });

  it("updates the actor row when a chat is renamed under an open dialog", () => {
    const { rename } = seedOpenEpicWithChatTitle("Old title");
    render(
      <TeardownForceDeleteDialog
        open
        worktreeLabel="feat-busy"
        holders={[HOLDER]}
        onConfirm={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByTestId("teardown-holder-label").textContent).toContain(
      "Old title",
    );
    act(() => {
      rename("Renamed title");
    });
    expect(screen.getByTestId("teardown-holder-label").textContent).toContain(
      "Renamed title",
    );
    expect(screen.getByTestId("teardown-holder-label").textContent).not.toContain(
      "Old title",
    );
  });
});
