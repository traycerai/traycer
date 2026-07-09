import { beforeEach, describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
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
