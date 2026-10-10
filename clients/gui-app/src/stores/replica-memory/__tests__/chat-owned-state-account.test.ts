import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import type {
  ChatSessionState,
  LiveAssistantMessage,
} from "@/stores/chats/chat-session-store";
import { retainedValueSize } from "../retained-value-size";
import {
  getProcessMemoryRuntime,
  resetProcessMemoryRuntimeForTests,
} from "@/stores/replica-memory/process-memory-accountant";
import {
  CHAT_PRIVATE_STRING_SET_NAMES,
  CHAT_STATE_FIELD_ACCOUNTING,
  createChatOwnedStateAccount,
  noteLiveTextAppend,
} from "../chat-owned-state-account";

const EPIC_ID = "epic-chat-owned-state-account";
const CHAT_ID = "chat-owned-state-account";

// Every direct Map/Set allocation in chat-session-store.ts needs an ownership
// decision. This source census makes a future private collection fail a test
// until its accounting or exclusion is explained. The five durable ID ledgers
// use createPrivateStringSet instead and are tested by their charge behavior.
const PRIVATE_COLLECTION_DECISIONS = {
  liveChatSessionStores: "references live stores already charged per handle",
  handoffCaptureRoots:
    "temporary post-disposal custody until async draft handoff settles",
  surfaceVisibility: "one scalar per mounted surface in the fixed store charge",
  stagingRevisionByRestoredAction:
    "scalar sidecar bounded by outstanding restore actions",
  hydrationRequestMarks: "at most eight outstanding range requests",
  noticesSuppressedAfterDispatch: "short timeout per in-flight refusal notice",
  stickySweptByAction:
    "bounded by in-flight actions; values reference recovery evidence",
  taskIds: "temporary stop-all frame construction",
  next: "temporary copy of charged state collections",
  settledActionIds: "temporary snapshot reconciliation result",
  hiddenQueueItemIds: "temporary queue projection",
  byAction: "temporary draft handoff dedupe map",
  running: "temporary background-work projection",
  pending: "temporary interview projection",
  EMPTY_COLD_REWRITTEN_IDS: "shared immutable empty singleton",
  EMPTY_UNCONFIRMED_SEND_ACTION_IDS: "shared immutable empty singleton",
  NO_SWEPT_ACTION_IDS: "shared immutable empty singleton",
  unconfirmedSendTimers:
    "one timer handle per send dispatched in the last 30 seconds",
  opened: "temporary copy of a charged state collection",
} as const;

const IMAGE_WITNESS_COLLECTION_DECISIONS = {
  heldEvidence: 1, // Weak keys cannot hold a message after its transcript copy dies.
  resetFloors: 1, // Charged incrementally, including keys whose rows left the window.
  truncated: 1, // Bounded at 512 and charged incrementally.
  stamps: 3, // Per-copy metadata follows the transcript's retained image rows.
} as const;

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
  it("classifies every collection allocated by the retained image witness sidecar", () => {
    const path = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../chats/image-witness-store.ts",
    );
    const tree = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const allocations = new Map<string, number>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["Map", "Set", "WeakMap", "WeakSet"].includes(node.expression.text)
      ) {
        const parent = node.parent;
        let owner: string | null = null;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          owner = parent.name.text;
        } else if (
          ts.isPropertyAssignment(parent) &&
          ts.isIdentifier(parent.name)
        ) {
          owner = parent.name.text;
        }
        expect(owner).not.toBeNull();
        if (owner !== null) {
          allocations.set(owner, (allocations.get(owner) ?? 0) + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(Object.fromEntries(allocations)).toEqual(
      IMAGE_WITNESS_COLLECTION_DECISIONS,
    );
  });

  it("has an explicit decision for each private Map or Set in the chat store", () => {
    const path = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../chats/chat-session-store.ts",
    );
    const source = readFileSync(path, "utf8");
    const tree = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const namedCollections = new Set<string>();
    const accountedPrivateSets = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isNewExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        (node.initializer.expression.text === "Map" ||
          node.initializer.expression.text === "Set")
      ) {
        namedCollections.add(node.name.text);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "createPrivateStringSet" &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        accountedPrivateSets.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(Array.from(namedCollections).sort()).toEqual(
      Object.keys(PRIVATE_COLLECTION_DECISIONS).sort(),
    );
    expect(Array.from(accountedPrivateSets).sort()).toEqual(
      [...CHAT_PRIVATE_STRING_SET_NAMES].sort(),
    );
  });

  it("classifies every data field the real store publishes", () => {
    const handle = openStore();
    try {
      const dataKeys = Object.entries(handle.store.getState())
        .filter(([, value]) => typeof value !== "function")
        .map(([key]) => key)
        .sort();
      expect(Object.keys(CHAT_STATE_FIELD_ACCOUNTING).sort()).toEqual(dataKeys);
      for (const classification of Object.values(CHAT_STATE_FIELD_ACCOUNTING)) {
        expect(classification === true || classification.length > 0).toBe(true);
      }
    } finally {
      handle.dispose();
    }
  });

  it("charges private string ledgers incrementally and releases deleted entries", () => {
    const account = createChatOwnedStateAccount();
    const changed = vi.fn();
    const ledger = account.createPrivateStringSet(
      "watchedMessageDeliveryIds",
      changed,
    );
    const before = account.size();
    ledger.add("first-message");
    const first = account.size();
    expect(first.estimatedHeapBytes).toBeGreaterThan(before.estimatedHeapBytes);
    ledger.add("first-message");
    expect(account.size()).toEqual(first);
    expect(changed).toHaveBeenCalledTimes(1);

    ledger.add("second-message");
    expect(account.size().estimatedHeapBytes).toBeGreaterThan(
      first.estimatedHeapBytes,
    );
    ledger.delete("first-message");
    ledger.delete("second-message");
    expect(account.size()).toEqual(before);
  });

  it("settles handle-owned toast and restore ledgers without a store write", () => {
    const handle = openStore();
    try {
      const baseline = chatWindowUsage().settledBytes;
      handle.deliveredNotices.retainedClientActionIds.add("last-copy-action");
      const afterNotice = chatWindowUsage().settledBytes;
      expect(afterNotice).toBeGreaterThan(baseline);

      handle.deliveredRestoreCompletionKeys.add("restore-completion");
      expect(chatWindowUsage().settledBytes).toBeGreaterThan(afterNotice);
      handle.deliveredRestoreCompletionKeys.delete("restore-completion");
      expect(chatWindowUsage().settledBytes).toBe(afterNotice);
    } finally {
      handle.dispose();
    }
  });

  it("counts an unpublished summary generation without encoding its unchanged prefix", () => {
    const handle = openStore();
    const account = createChatOwnedStateAccount();
    const initial = handle.store.getState();
    const summary = (
      filePath: string,
    ): ChatSessionState["accumulatedFileChangeSummaries"][number] => ({
      filePath,
      operation: "edit",
      diffSource: "snapshot",
      reason: "snapshot",
      undoable: true,
      hasContents: true,
      digest: `digest-${filePath}`,
      counts: { additions: 1, deletions: 0 },
    });
    const first = summary(`first-${"x".repeat(100_000)}`);
    const second = summary("second.ts");
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      account.update(initial);
      const baseline = account.size();
      expect(account.updateSummaryAssembly([first], [])).toBe(true);
      const firstSize = account.size();
      expect(firstSize.estimatedHeapBytes).toBeGreaterThan(
        baseline.estimatedHeapBytes,
      );

      encode.mockClear();
      expect(account.updateSummaryAssembly([first, second], [])).toBe(true);
      expect(account.size().estimatedHeapBytes).toBeGreaterThan(
        firstSize.estimatedHeapBytes,
      );
      expect(
        encode.mock.calls.some(
          ([value]) =>
            typeof value === "string" && value.includes(first.filePath),
        ),
      ).toBe(false);

      expect(account.updateSummaryAssembly(null, [])).toBe(true);
      expect(account.size()).toEqual(baseline);
      account.update({ ...initial, accumulatedFileChangeSummaries: [first] });
      const publishedSize = account.size();
      account.updateSummaryAssembly([first, second], [first]);
      expect(
        account.size().estimatedHeapBytes - publishedSize.estimatedHeapBytes,
      ).toBe(32 + 2 * 8 + retainedValueSize(second).estimatedHeapBytes);
    } finally {
      encode.mockRestore();
      handle.dispose();
    }
  });

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

  it("charges a paths-only missing-worktree update", () => {
    const handle = openStore();
    const account = createChatOwnedStateAccount();
    try {
      const initial = handle.store.getState();
      expect(account.update(initial)).toBe(true);
      const baseline = account.size();
      const paths = ["/workspace/missing-repo", "/workspace/another-repo"];

      expect(account.update({ ...initial, missingWorktreePaths: paths })).toBe(
        true,
      );
      const expectedPathDelta = retainedValueSize(paths);
      const previousPathSize = retainedValueSize(initial.missingWorktreePaths);
      expect(account.size()).toEqual({
        rawBytes:
          baseline.rawBytes +
          expectedPathDelta.rawBytes -
          previousPathSize.rawBytes,
        estimatedHeapBytes:
          baseline.estimatedHeapBytes +
          expectedPathDelta.estimatedHeapBytes -
          previousPathSize.estimatedHeapBytes,
      });
    } finally {
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

  it("accounts growing text deltas without re-encoding the accumulated live text", () => {
    const handle = openStore();
    const account = createChatOwnedStateAccount();
    const initial = handle.store.getState();
    const startingText = "x".repeat(1024 * 1024);
    const block = {
      type: "text",
      blockId: "growing-live-text",
      status: "streaming",
      timestamp: 1,
      text: startingText,
      providerNotice: null,
    } as const;
    const live: LiveAssistantMessage = {
      turnId: "turn-live-deltas",
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
    account.update({ ...initial, liveAssistantMessage: live });
    const initialSize = account.size().estimatedHeapBytes;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      let text = startingText;
      let previousBlocks: readonly (typeof block)[] = [block];
      let finalLive = live;
      for (let version = 2; version <= 31; version += 1) {
        text += "x";
        const nextBlocks = [{ ...block, text }];
        noteLiveTextAppend(previousBlocks, nextBlocks, block.blockId, "x");
        finalLive = {
          ...live,
          blocksVersion: version,
          blocks: nextBlocks,
        };
        account.update({
          ...initial,
          liveAssistantMessage: finalLive,
        });
        previousBlocks = nextBlocks;
      }
      expect(account.size().estimatedHeapBytes).toBeGreaterThan(initialSize);
      const encodedCharacters = encode.mock.calls.reduce(
        (total, [value]) =>
          total + (typeof value === "string" ? value.length : 0),
        0,
      );
      expect(encodedCharacters).toBeLessThan(20_000);

      encode.mockClear();
      const fullMeasure = createChatOwnedStateAccount();
      fullMeasure.update({ ...initial, liveAssistantMessage: finalLive });
      expect(account.size()).toEqual(fullMeasure.size());
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
