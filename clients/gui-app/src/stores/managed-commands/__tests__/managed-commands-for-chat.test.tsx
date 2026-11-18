import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { HeldManagedCommandUpdate } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  disposeManagedCommandChatSessions,
  installManagedCommandChatSession,
  type ManagedCommandChatSessionStub,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { useHeldManagedCommandsForChat } from "@/stores/managed-commands/managed-commands-for-chat";

/**
 * The read side of the Deliver affordance: which shells this chat is holding,
 * and in what order. `useManagedCommandsForChat` /
 * `useRunningManagedCommandsForChat`'s own ordering (running-first,
 * most-recent-activity) has its coverage through the Background panel's own
 * suite; this hook's ordering is the opposite on purpose, so it gets its own.
 */

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const HOST_ID = "host-1";

function held(
  over: Partial<HeldManagedCommandUpdate>,
): HeldManagedCommandUpdate {
  return {
    commandId: "cmd-1",
    description: "deploy watcher",
    heldAtMs: 10,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  disposeManagedCommandChatSessions();
});

describe("useHeldManagedCommandsForChat", () => {
  it("reads as empty for a chat with no live session", () => {
    const { result } = renderHook(() =>
      useHeldManagedCommandsForChat({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
      }),
    );

    expect(result.current).toEqual([]);
  });

  it("orders held shells oldest first - the reverse of the running list", () => {
    const session: ManagedCommandChatSessionStub =
      installManagedCommandChatSession({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
      });
    session.setHeldUpdates([
      held({ commandId: "newest", heldAtMs: 30 }),
      held({ commandId: "oldest", heldAtMs: 10 }),
      held({ commandId: "middle", heldAtMs: 20 }),
    ]);

    const { result } = renderHook(() =>
      useHeldManagedCommandsForChat({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
      }),
    );

    expect(result.current.map((h) => h.commandId)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
  });
});
