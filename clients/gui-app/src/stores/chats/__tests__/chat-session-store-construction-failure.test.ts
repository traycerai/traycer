import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { CHAT_WINDOWS_SOFT_LIMIT_BYTES } from "@/stores/replica-memory/budget-limits";
import {
  createProcessMemoryRuntime,
  resetProcessMemoryRuntimeForTests,
  setProcessMemoryRuntimeForTests,
  type ProcessMemoryRuntime,
} from "@/stores/replica-memory/process-memory-accountant";

const HOST_ID = "host-construction-failure";
const EPIC_ID = "epic-construction-failure";
const CHAT_ID = "chat-construction-failure";

function constructWithThrowingFactory(): void {
  expect(() => {
    createChatSessionStore({
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId: HOST_ID,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      userId: "user-1",
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: () => {
        throw new Error("transport failed to construct");
      },
    });
  }).toThrow("transport failed to construct");
}

describe("a chat session store whose construction failed", () => {
  // Captured from `beforeEach`, so every test reads the EXACT instance `createChatSessionStore`'s
  // own `ensureProcessMemoryRuntime()` call resolves to - a second `createProcessMemoryRuntime()`
  let runtime: ProcessMemoryRuntime;

  beforeEach(() => {
    // An isolated runtime per test, so `sessionCount()`/reconcile bytes are
    // not entangled with anything else this process has attached.
    runtime = createProcessMemoryRuntime(CHAT_STORE_TEST_ENVIRONMENT);
    setProcessMemoryRuntimeForTests(runtime);
  });

  afterEach(() => {
    resetProcessMemoryRuntimeForTests();
  });

  it("THE REDDENING ONE - leaves no holder that can crash a later reconcile", () => {
    constructWithThrowingFactory();

    runtime.accountant.settle(
      BUDGET_PLANE_IDS.chatWindows,
      "phantom-well-behaved-holder",
      CHAT_WINDOWS_SOFT_LIMIT_BYTES + 1_000,
    );

    // Red today as a TypeError escaping from the dead holder's `evict`
    // closure reading `get()` on a store that was never assigned.
    expect(() => {
      runtime.accountant.reconcile(BUDGET_PLANE_IDS.chatWindows);
    }).not.toThrow();
  });

  it("the book has no holder for the failed construction's id", () => {
    expect(runtime.chatWindows.sessionCount()).toBe(0);

    constructWithThrowingFactory();

    // THE REDDENING surface for THIS assertion, kept separate from the crash above: a construction
    // that threw must not leave an attached holder behind, observed through the book's own public
    expect(runtime.chatWindows.sessionCount()).toBe(0);
  });
});
