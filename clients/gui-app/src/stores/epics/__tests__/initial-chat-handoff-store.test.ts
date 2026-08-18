import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import {
  initialChatHandoffKey,
  migrateInitialChatHandoffState,
  selectInitialChatHandoff,
  useInitialChatHandoffStore,
  type InitialChatHandoffScope,
} from "../initial-chat-handoff-store";

const SCOPE: InitialChatHandoffScope = {
  hostId: "host-1",
  userId: "user-1",
  epicId: "epic-1",
};
const CHAT_ID = "chat-1";
const CONTENT: JsonContent = { type: "doc", content: [] };
const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function register(): void {
  useInitialChatHandoffStore.getState().register({
    ...SCOPE,
    chatId: CHAT_ID,
    content: CONTENT,
    settings: SETTINGS,
    worktreeIntent: null,
    placement: { kind: "active-tile" },
    messageId: "msg-1",
    clientActionId: "cai-1",
    createdAt: 1,
  });
}

function statusOf(): string | null {
  return (
    selectInitialChatHandoff(useInitialChatHandoffStore.getState(), SCOPE)
      ?.status ?? null
  );
}

describe("handoff identity is the epic, not the host", () => {
  beforeEach(() => {
    useInitialChatHandoffStore.getState().resetForTests();
  });

  it("finds a handoff registered under the PLACEMENT host when the canvas reads a different one", () => {
    // A landing composer pinned to host B creates the epic there, so
    // `useLandingComposerActions` registers under B. The canvas that consumes
    // the handoff reads the app-wide pointer, which is still host A. Keyed on
    // the host, that lookup missed entirely: the seeded chat was never
    // eager-opened and its pending-create mark was never cleared.
    register();

    const fromAnotherHost = selectInitialChatHandoff(
      useInitialChatHandoffStore.getState(),
      { hostId: "host-2", userId: SCOPE.userId, epicId: SCOPE.epicId },
    );

    expect(fromAnotherHost).not.toBeNull();
    expect(fromAnotherHost?.chatId).toBe(CHAT_ID);
    // The creating host is still carried as DATA - only the identity dropped it.
    expect(fromAnotherHost?.hostId).toBe("host-1");
  });

  it("still separates two users' handoffs for the same epic id", () => {
    register();

    const otherUser = selectInitialChatHandoff(
      useInitialChatHandoffStore.getState(),
      { hostId: SCOPE.hostId, userId: "user-2", epicId: SCOPE.epicId },
    );

    expect(otherUser).toBeNull();
  });
});

describe("v1 -> v2 persisted-key migration", () => {
  // The v1 key carried the creating host as its first segment.
  const V1_KEY = ["host-1", "user-1", "epic-1"].join("\x1f");
  const V1_RECORD = {
    key: V1_KEY,
    hostId: "host-1",
    userId: "user-1",
    epicId: "epic-1",
    chatId: CHAT_ID,
    status: "waitingChat",
    content: CONTENT,
    settings: SETTINGS,
    worktreeIntent: null,
    placement: { kind: "active-tile" },
    clientActionId: "cai-1",
    messageId: "msg-1",
    failureReason: null,
    createdAt: 1,
    updatedAt: 1,
  };

  it("re-keys a v1 record onto the host-free key and rewrites its own key field", () => {
    const migrated = migrateInitialChatHandoffState({
      handoffs: { [V1_KEY]: V1_RECORD },
    });

    const v2Key = initialChatHandoffKey(SCOPE);
    expect(Object.keys(migrated.handoffs)).toEqual([v2Key]);
    const record = migrated.handoffs[v2Key];
    // The record's own `key` field is redundant with its map key; leaving the
    // v1 string there would make the two disagree for the record's whole life.
    expect(record.key).toBe(v2Key);
    // Re-keyed, not rebuilt: the payload the user actually typed rides through.
    expect(record.chatId).toBe(CHAT_ID);
    expect(record.hostId).toBe("host-1");
    expect(record.status).toBe("waitingChat");
  });

  it("drops a record whose status is outside the union rather than stranding it", () => {
    const migrated = migrateInitialChatHandoffState({
      handoffs: {
        [V1_KEY]: { ...V1_RECORD, status: "someRetiredStatus" },
        bad: { ...V1_RECORD, epicId: 42 },
      },
    });

    expect(migrated.handoffs).toEqual({});
  });

  it("survives a blob that is not shaped like this store at all", () => {
    expect(migrateInitialChatHandoffState(null).handoffs).toEqual({});
    expect(migrateInitialChatHandoffState({}).handoffs).toEqual({});
    expect(
      migrateInitialChatHandoffState({ handoffs: "nope" }).handoffs,
    ).toEqual({});
  });

  it("rehydrates a v1 blob from localStorage at IMPORT time, findable under the v2 scope", async () => {
    // The real path, not just the pure function: `persist` calls `hydrate()`
    // inside `create()` and `toThenable` keeps that synchronous for a sync
    // storage, so `migrate` runs during MODULE EVALUATION. Anything it touches
    // that is declared after the `create()` call is still in its temporal dead
    // zone for precisely the installs that hold a v1 blob.
    //
    // Calling the migrate function directly cannot see that - only a fresh
    // import can. And the symptom is silent: zustand catches what `migrate`
    // throws, so moving the declaration makes this fail as `expected null not
    // to be null`, never as a ReferenceError.
    localStorage.setItem(
      persistKey(STORE_KEYS.initialChatHandoff),
      JSON.stringify({
        state: { handoffs: { [V1_KEY]: V1_RECORD } },
        version: 1,
      }),
    );
    vi.resetModules();

    const fresh = await import("../initial-chat-handoff-store");

    const found = fresh.selectInitialChatHandoff(
      fresh.useInitialChatHandoffStore.getState(),
      // The canvas reads a DIFFERENT host than the one v1 keyed under, which
      // is the whole reason the key changed.
      { hostId: "host-2", userId: "user-1", epicId: "epic-1" },
    );

    expect(found).not.toBeNull();
    expect(found?.chatId).toBe(CHAT_ID);
    localStorage.clear();
  });
});

describe("initial-chat-handoff-store markInitialTurnStarted", () => {
  beforeEach(() => {
    useInitialChatHandoffStore.getState().resetForTests();
  });

  it("transitions pending → sending using the pre-minted ids", () => {
    register();
    // `epic.create` resolves with initialTurnStarted while the handoff is still
    // `pending` (the projection-driven advance may not have run yet).
    expect(
      useInitialChatHandoffStore
        .getState()
        .markInitialTurnStarted(SCOPE, CHAT_ID),
    ).toBe(true);
    expect(statusOf()).toBe("sending");
    // The pre-minted ids are preserved so the `sending` policy can match the
    // persisted user message / accepted action.
    const handoff = selectInitialChatHandoff(
      useInitialChatHandoffStore.getState(),
      SCOPE,
    );
    expect(handoff?.messageId).toBe("msg-1");
    expect(handoff?.clientActionId).toBe("cai-1");
  });

  it("is a no-op once already sending", () => {
    register();
    useInitialChatHandoffStore
      .getState()
      .markInitialTurnStarted(SCOPE, CHAT_ID);
    expect(statusOf()).toBe("sending");
    expect(
      useInitialChatHandoffStore
        .getState()
        .markInitialTurnStarted(SCOPE, CHAT_ID),
    ).toBe(false);
    expect(statusOf()).toBe("sending");
  });

  it("is a no-op when the chatId does not match", () => {
    register();
    expect(
      useInitialChatHandoffStore
        .getState()
        .markInitialTurnStarted(SCOPE, "other-chat"),
    ).toBe(false);
    expect(statusOf()).toBe("pending");
  });

  it("is a no-op after the handoff failed", () => {
    register();
    useInitialChatHandoffStore.getState().markFailed(SCOPE, "boom");
    expect(
      useInitialChatHandoffStore
        .getState()
        .markInitialTurnStarted(SCOPE, CHAT_ID),
    ).toBe(false);
    expect(statusOf()).toBe("failed");
  });
});
