import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { persistKey, STORE_KEYS } from "@/lib/persist";
import {
  migrateInitialChatHandoffState,
  useInitialChatHandoffStore,
  type InitialChatHandoff,
} from "../initial-chat-handoff-store";

const STORAGE_KEY = persistKey(STORE_KEYS.initialChatHandoff);

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
  identityId: null,
};

function b64ImageContent(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "img-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 12,
              byHashEligible: true,
              b64content: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            },
          },
          { type: "text", text: "hello" },
        ],
      },
    ],
  };
}

function containsB64String(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsB64String);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, v]) => {
      if (key === "b64content" && typeof v === "string" && v.length > 0) {
        return true;
      }
      return containsB64String(v);
    });
  }
  return false;
}

beforeEach(() => {
  window.localStorage.clear();
  useInitialChatHandoffStore.getState().resetForTests();
});

afterEach(() => {
  window.localStorage.clear();
  useInitialChatHandoffStore.getState().resetForTests();
});

describe("initial-chat-handoff store: base64 strip at the persist boundary", () => {
  it("persists a hash-only shape while the in-memory handoff keeps the pending b64 node", () => {
    const content = b64ImageContent();
    useInitialChatHandoffStore.getState().register({
      hostId: "host-1",
      userId: "user-1",
      epicId: "epic-1",
      chatId: "chat-1",
      content,
      settings: SETTINGS,
      worktreeIntent: null,
      placement: null,
      messageId: "msg-1",
      clientActionId: "cai-1",
      createdAt: 1,
    });

    const options = useInitialChatHandoffStore.persist.getOptions();
    const rawPartialized = options.partialize?.(
      useInitialChatHandoffStore.getState(),
    );
    expect(rawPartialized).toBeDefined();
    if (rawPartialized === undefined) return;
    const partialized = rawPartialized as {
      readonly handoffs: Readonly<Record<string, InitialChatHandoff>>;
    };

    const handoffs = partialized.handoffs;
    const keys = Object.keys(handoffs);
    expect(keys).toHaveLength(1);
    const persistedHandoff = handoffs[keys[0]];

    // (a) PERSISTED shape carries no b64content anywhere.
    expect(containsB64String(persistedHandoff)).toBe(false);
    expect(JSON.stringify(persistedHandoff.content)).not.toContain(
      "b64content",
    );

    // (b) What actually lands in localStorage after the store's own
    // subscription-driven write matches the same property.
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    expect(containsB64String(parsed)).toBe(false);

    // (c) The LIVE in-memory handoff still holds the original b64 node —
    // the resend and the GC root source both read the live content, and a
    // b64 node is what a legacy v3 entry (and this fresh registration,
    // mid-ingest) may still carry.
    const liveHandoffs = useInitialChatHandoffStore.getState().handoffs;
    const liveKeys = Object.keys(liveHandoffs);
    expect(liveKeys).toHaveLength(1);
    const live = liveHandoffs[liveKeys[0]];
    expect(containsB64String(live)).toBe(true);
    expect(live.content).toEqual(content);
  });
});

describe("initial-chat-handoff store: v3 -> v4 migration", () => {
  it("bumps version and carries a legacy fully-inlined entry through VERBATIM", () => {
    const legacyContent = b64ImageContent();
    const v3Key = "user:user-1\x1fepic-1";
    const v3State = {
      handoffs: {
        [v3Key]: {
          key: v3Key,
          hostId: "host-1",
          userId: "user-1",
          epicId: "epic-1",
          chatId: "chat-1",
          status: "waitingChat",
          content: legacyContent,
          settings: SETTINGS,
          worktreeIntent: null,
          placement: null,
          clientActionId: "cai-1",
          messageId: "msg-1",
          failureReason: null,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    };

    const migrated = migrateInitialChatHandoffState(v3State);

    const keys = Object.keys(migrated.handoffs);
    expect(keys).toHaveLength(1);
    const entry = migrated.handoffs[keys[0]];
    // Carried through VERBATIM - still fully inlined, no hash node, base64
    // intact. The strip applies only to the NEXT persisted write, not to
    // what hydration/migration hands back, because this is a message the
    // user already sent that must still re-send in this session.
    expect(entry.content).toEqual(legacyContent);
    expect(containsB64String(entry.content)).toBe(true);
    expect(entry.status).toBe("waitingChat");
  });

  it("rehydrates a v3 blob from localStorage at IMPORT time, still fully inlined", async () => {
    const legacyContent = b64ImageContent();
    const v3Key = "user:user-1\x1fepic-1";
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        state: {
          handoffs: {
            [v3Key]: {
              key: v3Key,
              hostId: "host-1",
              userId: "user-1",
              epicId: "epic-1",
              chatId: "chat-1",
              status: "waitingChat",
              content: legacyContent,
              settings: SETTINGS,
              worktreeIntent: null,
              placement: null,
              clientActionId: "cai-1",
              messageId: "msg-1",
              failureReason: null,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
      }),
    );

    vi.resetModules();
    const fresh = await import("../initial-chat-handoff-store");
    const found = fresh.selectInitialChatHandoff(
      fresh.useInitialChatHandoffStore.getState(),
      {
        hostId: "host-1",
        userId: "user-1",
        epicId: "epic-1",
      },
    );

    expect(found).not.toBeNull();
    expect(found?.content).toEqual(legacyContent);
    expect(containsB64String(found?.content)).toBe(true);
  });
});
