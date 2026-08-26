import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  ChatQueuedItem,
  ChatQueueState,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiAgentCommandOption } from "@traycer/protocol/host/index";

import {
  findManualCompactCommand,
  promoteQueuedMessageToFront,
} from "@/lib/chats/compact-conversation";
import { optimisticQueuedItemId } from "@/stores/chats/optimistic-queue";

function command(
  name: string,
  metadata: Record<string, unknown>,
): GuiAgentCommandOption {
  return {
    harnessId: "claude",
    name,
    description: "",
    argumentHint: null,
    kind: "slash-command",
    metadata,
  };
}

function queuedItem(queueItemId: string, messageId: string): ChatQueuedItem {
  return {
    kind: "prompt",
    queueItemId,
    messageId,
    message: {
      kind: "user",
      content: { type: "doc", content: [] },
      browserContextAttachments: [],
      browserAnnotations: [],
    },
    sender: { type: "user", userId: "u1" },
    settings: {
      harnessId: "claude",
      model: "claude-opus-5",
      permissionMode: "supervised",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    },
    accountContext: { type: "PERSONAL" },
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function queue(items: ReadonlyArray<ChatQueuedItem>): ChatQueueState {
  return { status: "running", items: [...items] };
}

/** Minimal zustand-shaped store: the helper only ever reads `queue`. */
function makeStore(initial: ChatQueueState) {
  let state = { queue: initial };
  const listeners = new Set<(next: { queue: ChatQueueState }) => void>();
  return {
    getState: () => state,
    subscribe: (listener: (next: { queue: ChatQueueState }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push: (next: ChatQueueState) => {
      state = { queue: next };
      for (const listener of [...listeners]) listener(state);
    },
    listenerCount: () => listeners.size,
  };
}

describe("findManualCompactCommand", () => {
  it("matches the providerKind marker, not the command name", () => {
    // Name alone is not the contract: a harness could expose a differently
    // named compaction command, and a user skill could be called "compact".
    const commands = [
      command("compact", { providerKind: "skill" }),
      command("summarise", { providerKind: "compaction" }),
    ];
    expect(findManualCompactCommand(commands)?.name).toBe("summarise");
  });

  it("returns null for an auto-only harness that advertises no command", () => {
    // Copilot's shape: it compacts on its own and exposes nothing to invoke.
    const commands = [command("explain", { providerKind: "skill" })];
    expect(findManualCompactCommand(commands)).toBe(null);
  });
});

describe("promoteQueuedMessageToFront", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the authoritative item before reordering", () => {
    // The optimistic row carries a synthetic id the host has never seen, so
    // reordering against it would target nothing. This is the whole reason the
    // promotion cannot be issued inline with the send.
    const store = makeStore(
      queue([
        queuedItem("q-existing", "m-existing"),
        queuedItem(optimisticQueuedItemId("action-1"), "m-compact"),
      ]),
    );
    const reorder = vi.fn(() => "ok");

    promoteQueuedMessageToFront({ store, messageId: "m-compact", reorder });
    expect(reorder).not.toHaveBeenCalled();

    store.push(
      queue([
        queuedItem("q-existing", "m-existing"),
        queuedItem("q-compact", "m-compact"),
      ]),
    );
    expect(reorder).toHaveBeenCalledExactlyOnceWith("q-compact", "q-existing");
  });

  it("stops watching once the reorder is issued", () => {
    const store = makeStore(
      queue([queuedItem(optimisticQueuedItemId("a"), "m-compact")]),
    );
    const reorder = vi.fn(() => "ok");
    promoteQueuedMessageToFront({ store, messageId: "m-compact", reorder });

    store.push(
      queue([
        queuedItem("q-first", "m-other"),
        queuedItem("q-compact", "m-compact"),
      ]),
    );
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(store.listenerCount()).toBe(0);

    // A later queue change must not re-issue a second reorder.
    store.push(
      queue([
        queuedItem("q-compact", "m-compact"),
        queuedItem("q-first", "m-other"),
      ]),
    );
    expect(reorder).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the message is already first", () => {
    const store = makeStore(
      queue([
        queuedItem("q-compact", "m-compact"),
        queuedItem("q-other", "m-other"),
      ]),
    );
    const reorder = vi.fn(() => "ok");
    promoteQueuedMessageToFront({ store, messageId: "m-compact", reorder });
    expect(reorder).not.toHaveBeenCalled();
    expect(store.listenerCount()).toBe(0);
  });

  it("never aims at another send's optimistic row", () => {
    // A concurrent send's optimistic row sits ahead of ours. Using it as
    // `beforeQueueItemId` would be rejected host-side, so it is skipped and
    // the first authoritative row is targeted instead.
    const store = makeStore(
      queue([
        queuedItem(optimisticQueuedItemId("other"), "m-other"),
        queuedItem("q-real", "m-real"),
        queuedItem("q-compact", "m-compact"),
      ]),
    );
    const reorder = vi.fn(() => "ok");
    promoteQueuedMessageToFront({ store, messageId: "m-compact", reorder });
    expect(reorder).toHaveBeenCalledExactlyOnceWith("q-compact", "q-real");
  });

  it("gives up quietly if the host never acknowledges the send", () => {
    // Failure leaves the message queued at the back rather than reordered -
    // a worse position, never a lost message.
    const store = makeStore(
      queue([queuedItem(optimisticQueuedItemId("a"), "m-compact")]),
    );
    const reorder = vi.fn(() => "ok");
    promoteQueuedMessageToFront({ store, messageId: "m-compact", reorder });

    vi.advanceTimersByTime(15_000);
    expect(store.listenerCount()).toBe(0);

    store.push(queue([queuedItem("q-compact", "m-compact")]));
    expect(reorder).not.toHaveBeenCalled();
  });

  it("does not re-filter the queue when the reference is unchanged", () => {
    // The watch fires on every store notification, including the rAF-cadence
    // stream-flush delta while a turn runs - none of which touch `queue`.
    // This pins the reference-equality gate that keeps those from re-running
    // attempt()'s filter+scan.
    const items = [queuedItem(optimisticQueuedItemId("a"), "m-compact")];
    const filterSpy = vi.spyOn(items, "filter");
    const q: ChatQueueState = { status: "running", items };
    const store = makeStore(q);
    const reorder = vi.fn(() => "ok");
    promoteQueuedMessageToFront({ store, messageId: "m-compact", reorder });
    filterSpy.mockClear();

    // Same reference: the gate should skip attempt() entirely.
    store.push(q);
    expect(filterSpy).not.toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();

    // A genuinely new queue reference still gets scanned and reordered.
    store.push(
      queue([
        queuedItem("q-other", "m-other"),
        queuedItem("q-compact", "m-compact"),
      ]),
    );
    expect(reorder).toHaveBeenCalledExactlyOnceWith("q-compact", "q-other");
  });

  it("can be cancelled by the caller", () => {
    const store = makeStore(
      queue([queuedItem(optimisticQueuedItemId("a"), "m-compact")]),
    );
    const reorder = vi.fn(() => "ok");
    const cancel = promoteQueuedMessageToFront({
      store,
      messageId: "m-compact",
      reorder,
    });

    cancel();
    expect(store.listenerCount()).toBe(0);

    store.push(
      queue([
        queuedItem("q-other", "m-other"),
        queuedItem("q-compact", "m-compact"),
      ]),
    );
    expect(reorder).not.toHaveBeenCalled();
  });
});
