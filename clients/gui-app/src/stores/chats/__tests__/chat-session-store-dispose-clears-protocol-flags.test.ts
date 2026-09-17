import { describe, expect, it } from "vitest";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * The three per-stream capability flags must all read `false` on a DISPOSED
 * store.
 *
 * Each is computed in one place - `onConnectionStatus` - and each is true only
 * while `status === "open"`. `dispose()` calls `closeStreamClient()`, which
 * retires the stream guard BEFORE `client.close()`, so that callback never
 * runs on this path and nothing recomputes them. A store held past disposal
 * therefore keeps advertising capabilities of a stream it no longer has, and
 * `chat-tile` reads these to decide whether Cmd+Enter steers, whether a send
 * may go hash-only, and whether an interview delivery can be retried.
 *
 * `retry()` already clears all three together; this pins that `dispose()`
 * agrees with it. Written after only `draftBlobBridgeSupported` was cleared
 * here - the epic that added it cleared its own flag explicitly and left the
 * two older ones, which is why this asserts the SET rather than one member.
 */

const EPIC_ID = "epic-dispose-flags";
const CHAT_ID = "chat-dispose-flags";
const OWNER_ID = "owner-dispose-flags";

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

/** Every capability answers TRUE, so a surviving `true` can only be staleness. */
function createHarness(): Harness {
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        interviewSettlementActionsProtocolSupported: () => true,
        autoPermissionModeProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

/**
 * Every per-stream capability the state exposes, read by NAME PATTERN rather
 * than listed.
 *
 * Listing them is what let this defect recur. The suite first pinned three
 * flags; `auto` permission mode then added a fourth, cleared it in `retry()`
 * and not in `dispose()`, and a test naming the other three had nothing to say
 * about it. Deriving the set means the NEXT capability is covered the day it
 * lands, which is the invariant that actually matters here: the two teardown
 * paths agree, whatever the set happens to be.
 */
function capabilityFlags(
  state: ChatSessionState,
): Record<string, boolean | null> {
  // Spread into an index-signature local first. `Object.entries` on a declared
  // interface yields `any` values, which the lint rightly refuses; through this
  // local every value reads as `unknown` and is narrowed below.
  const record: Record<string, unknown> = { ...state };
  const flags: Record<string, boolean | null> = {};
  for (const key of Object.keys(record)) {
    if (!/Supported$/.test(key)) continue;
    const value = record[key];
    if (typeof value !== "boolean" && value !== null) continue;
    flags[key] = value;
  }
  return flags;
}

describe("chat session store - dispose clears every per-stream capability flag", () => {
  it("leaves no capability advertised after dispose", () => {
    const harness = createHarness();
    harness.callbacks().onConnectionStatus("open", null, null);

    // Precondition: every capability is advertised, so a survivor below can
    // only be staleness and not a flag that was never set.
    const open = capabilityFlags(harness.handle.store.getState());
    expect(Object.keys(open).length).toBeGreaterThanOrEqual(4);
    expect(Object.values(open).every((value) => value === true)).toBe(true);

    harness.handle.dispose();

    // Nothing still reads as advertised. `false` and `null` are both retired -
    // the auto flag's `null` means "cannot say", which is what a disposed store
    // is - so the assertion is that no capability remains TRUE.
    const closed = capabilityFlags(harness.handle.store.getState());
    expect(Object.keys(closed)).toEqual(Object.keys(open));
    expect(
      Object.entries(closed).filter(([, value]) => value === true),
    ).toEqual([]);
  });

  it("agrees with retry(), flag for flag, whatever the set is", () => {
    // Two paths tear the stream down and both must answer identically. This
    // compares the DERIVED set rather than named members, because the defect it
    // guards is a new capability joining one path and not the other - which has
    // happened twice now, once in each direction.
    const harness = createHarness();
    harness.callbacks().onConnectionStatus("open", null, null);
    harness.handle.store.getState().retry();
    const afterRetry = capabilityFlags(harness.handle.store.getState());

    harness.callbacks().onConnectionStatus("open", null, null);
    harness.handle.dispose();

    expect(capabilityFlags(harness.handle.store.getState())).toEqual(
      afterRetry,
    );
  });
});
