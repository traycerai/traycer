import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import type { LiveAssistantMessage } from "@/stores/chats/chat-session-store";
import {
  getProcessMemoryRuntime,
  resetProcessMemoryRuntimeForTests,
} from "@/stores/replica-memory/process-memory-accountant";
import { createChatOwnedStateAccount } from "../chat-owned-state-account";

const EPIC_ID = "epic-chat-owned-state-account";
const CHAT_ID = "chat-owned-state-account";

function bindingWithLargePath(path: string): WorktreeBinding {
  return {
    entries: [
      {
        workspacePath: path,
        mode: "worktree",
        repoIdentifier: { owner: "acme", repo: "accounting-test" },
        worktreePath: `${path}/worktree`,
        branch: "feature/accounting-test",
        isPrimary: true,
        isImported: false,
        setupState: "succeeded",
        setupTerminalSessionId: null,
        setupExitCode: 0,
        setupFailedAt: null,
        createdAt: 1,
        ownedSubmodules: [],
      },
    ],
  };
}

function openStore() {
  return createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-owned-state-test",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: null,
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
  });
}

function chatWindowUsage(): {
  readonly settledBytes: number;
  readonly holders: number;
} {
  const plane = getProcessMemoryRuntime()
    .accountant.snapshot()
    .planes.find((item) => item.planeId === BUDGET_PLANE_IDS.chatWindows);
  if (plane === undefined) {
    throw new Error("chat-windows plane was not registered");
  }
  return { settledBytes: plane.settledBytes, holders: plane.holderCount };
}

beforeEach(() => {
  resetProcessMemoryRuntimeForTests();
});

afterEach(() => {
  resetProcessMemoryRuntimeForTests();
});

describe("chat owned-state memory accounting", () => {
  it("measures changed non-transcript state and skips identical references", () => {
    const handle = openStore();
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      const account = createChatOwnedStateAccount();
      const initial = handle.store.getState();
      expect(account.update(initial)).toBe(true);

      const next = {
        ...initial,
        worktreeBinding: bindingWithLargePath(`/work/${"segment/".repeat(40)}`),
      };
      expect(account.update(next)).toBe(true);
      expect(account.size().rawBytes).toBeGreaterThan(0);
      expect(account.size().estimatedHeapBytes).toBeGreaterThan(0);

      encode.mockClear();
      expect(account.update(next)).toBe(false);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
      handle.dispose();
    }
  });

  it("reuses the measured block while live assistant metadata streams", () => {
    const handle = openStore();
    const account = createChatOwnedStateAccount();
    const initial = handle.store.getState();
    const block = {
      type: "text",
      blockId: "large-live-block",
      status: "streaming",
      timestamp: 1,
      text: "x".repeat(1024 * 1024),
      providerNotice: null,
    } as const;
    const live: LiveAssistantMessage = {
      turnId: "turn-live-cache",
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [block],
      startedAt: 1,
      blocksVersion: 1,
      imageResolutions: [],
      imageResolutionsVersion: 0,
      timestamp: 1,
      reasoningEffort: null,
      serviceTier: null,
    };
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      account.update({ ...initial, liveAssistantMessage: live });
      encode.mockClear();
      for (let update = 2; update < 32; update += 1) {
        account.update({
          ...initial,
          liveAssistantMessage: { ...live, blocksVersion: update },
        });
      }
      const largePayloadEncodes = encode.mock.calls.filter(
        ([value]) => typeof value === "string" && value.length >= 1024 * 1024,
      );
      expect(largePayloadEncodes).toHaveLength(0);
    } finally {
      encode.mockRestore();
      handle.dispose();
    }
  });

  it("adds non-transcript state to the chat holder and releases it on disposal", () => {
    const handle = openStore();
    const runtime = getProcessMemoryRuntime();
    const baselineUsage = chatWindowUsage();
    const baselineRaw = runtime.chatWindows.rawOwnedStateBytes();
    const baselineEstimated =
      runtime.chatWindows.estimatedOwnedStateHeapBytes();
    try {
      handle.store.setState({
        worktreeBinding: bindingWithLargePath(
          `/work/${"retained-path/".repeat(80)}`,
        ),
      });

      const retainedUsage = chatWindowUsage();
      expect(runtime.chatWindows.rawOwnedStateBytes()).toBeGreaterThan(
        baselineRaw,
      );
      expect(
        runtime.chatWindows.estimatedOwnedStateHeapBytes(),
      ).toBeGreaterThan(baselineEstimated);
      expect(retainedUsage.settledBytes).toBeGreaterThan(
        baselineUsage.settledBytes,
      );
    } finally {
      handle.dispose();
    }

    expect(runtime.chatWindows.rawOwnedStateBytes()).toBe(0);
    expect(runtime.chatWindows.estimatedOwnedStateHeapBytes()).toBe(0);
    expect(chatWindowUsage().settledBytes).toBeLessThan(
      baselineUsage.settledBytes,
    );
    expect(chatWindowUsage().holders).toBe(0);
  });
});
