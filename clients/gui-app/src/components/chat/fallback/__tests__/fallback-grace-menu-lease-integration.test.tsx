import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { PendingFallback } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatFallbackListTargetsResponse } from "@traycer/protocol/host/chat-fallback";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type ChatStreamClientHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  disposeAllChatSessions,
  getChatSessionRegistry,
} from "@/lib/registries/chat-session-registry";
import { FallbackGraceMenu } from "@/components/chat/fallback/fallback-card-menus";
import {
  CHOOSE_DIFFERENTLY_LABEL,
  PAUSING_COUNTDOWN_LABEL,
} from "@/components/chat/fallback/fallback-copy";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  fallbackProfileTarget,
  listTargetsResponse,
  pendingFallback,
} from "@/components/chat/fallback/__tests__/fallback-fixtures";

/**
 * B1 + B-RECONNECT, through the REAL store and the REAL
 * `useFallbackChoiceLease` hook - the seam `fallback-destination-menu.test.tsx`
 * cannot witness, since that file mocks that hook wholesale (D219 once
 * already this batch; not repeating it). Only the hooks with nothing to do
 * with the lease (list-targets, profile labels, the mutation transport) are
 * mocked below.
 */

const EPIC_ID = "epic-lease-integration";
const CHAT_ID = "chat-lease-integration";
const HOST_ID = "host-lease-integration";
const TRAVERSAL_ID = "traversal-lease-integration";

function fallbackDto(input: {
  readonly state: PendingFallback["state"];
  readonly revision: number;
}): PendingFallback {
  return pendingFallback({
    state: input.state,
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: input.state === "hold" ? 1_700_000_012_000 : null,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 0,
    siblingSwitching: 0,
    traversalId: TRAVERSAL_ID,
    revision: input.revision,
  });
}

const HOLD = fallbackDto({ state: "hold", revision: 1 });
const CHOOSING = fallbackDto({ state: "choosing", revision: 2 });

type ChatOwnerActionFrame = Parameters<ChatStreamClientHandle["sendAction"]>[0];

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatOwnerActionFrame[];
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  let callbacks: ChatStreamCallbacks | null = null;
  const sent: ChatOwnerActionFrame[] = [];
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: "owner-lease-integration",
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    sent,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

function registerHarness(harness: Harness): void {
  getChatSessionRegistry().acquire(
    { epicId: EPIC_ID, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "test" },
    () => harness.handle,
  );
}

function emptyChat(): Chat {
  return {
    id: CHAT_ID,
    parentId: null,
    userId: "owner-lease-integration",
    hostId: HOST_ID,
    title: "Host Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: null,
    activeSessionChain: null,
    claudePendingWakes: [],
    messages: [],
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
}

function emitSnapshot(
  callbacks: ChatStreamCallbacks,
  pending: PendingFallback | undefined,
): void {
  callbacks.onConnectionStatus("open", null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: emptyChat(),
      access: {
        role: "owner",
        ownerUserId: "owner-lease-integration",
        canAct: true,
      },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      pendingFallback: pending,
      pendingReturn: undefined,
    },
  });
}

/**
 * Unlike {@link emitSnapshot}, this does NOT touch `connectionStatus` - the
 * arms that must observe a hold attempt FAIL while the connection is still
 * `reconnecting` need a way to deliver a fresh `pendingFallback` object
 * without emitSnapshot's own `onConnectionStatus("open", ...)` preamble
 * silently repairing the connection first.
 */
function emitTurnState(
  callbacks: ChatStreamCallbacks,
  pending: PendingFallback | undefined,
): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "idle",
    activeTurn: null,
    pendingFallback: pending,
    pendingReturn: undefined,
  });
}

interface AckInput {
  readonly clientActionId: string;
  readonly status: "accepted" | "rejected";
  readonly token: string | null;
}

function emitActionAck(callbacks: ChatStreamCallbacks, input: AckInput): void {
  callbacks.onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: input.clientActionId,
    action: "fallback.holdForChoice",
    status: input.status,
    reason: input.status === "rejected" ? "traversal_advanced" : null,
    code: input.status === "rejected" ? "traversal_advanced" : null,
    backgroundStopTaskIds: [],
    token: input.token,
  });
}

function holdFrames(sent: ChatOwnerActionFrame[]): ChatOwnerActionFrame[] {
  return sent.filter((frame) => frame.kind === "fallback.holdForChoice");
}

function releaseFrames(sent: ChatOwnerActionFrame[]): ChatOwnerActionFrame[] {
  return sent.filter((frame) => frame.kind === "fallback.releaseChoice");
}

const LISTED_ONE_ROW: ChatFallbackListTargetsResponse = listTargetsResponse({
  outcome: "listed",
  failedTuple: FAILED_CLAUDE_TUPLE,
  profileTargets: [
    fallbackProfileTarget({
      profileId: "sibling-profile",
      label: "sibling-account",
      severity: "ok",
      usedPercent: 10,
      recommended: false,
      selectable: true,
      skip: null,
    }),
  ],
  modelTargets: [],
  modelTargetsSkip: null,
});

vi.mock("@/components/chat/fallback/use-fallback-targets", () => ({
  useFallbackListTargets: () => ({
    data: LISTED_ONE_ROW,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

/**
 * Reads `pendingFallback` LIVE off the real store and hands it to the real
 * `FallbackGraceMenu` - the same wiring the card does, minus everything about
 * this scenario that is not the lease. `pending === undefined` renders
 * nothing rather than throwing: a frame that clears the DTO entirely (not
 * exercised by any case below) should not crash the harness.
 */
function GraceMenuHarness({
  handle,
}: {
  readonly handle: ChatSessionStoreHandle;
}) {
  const pending = handle.store((state) => state.pendingFallback);
  if (pending === undefined) return null;
  return (
    <FallbackGraceMenu
      pending={pending}
      client={null}
      epicId={EPIC_ID}
      chatId={CHAT_ID}
      hostId={HOST_ID}
      canAct
    />
  );
}

function renderGraceMenu(handle: ChatSessionStoreHandle) {
  return render(
    <TabHostProvider hostId={HOST_ID}>
      <GraceMenuHarness handle={handle} />
    </TabHostProvider>,
  );
}

function openMenu(): void {
  fireEvent.click(
    screen.getByRole("button", { name: CHOOSE_DIFFERENTLY_LABEL }),
  );
}

function closeMenu(): void {
  fireEvent.click(
    screen.getByRole("button", { name: CHOOSE_DIFFERENTLY_LABEL }),
  );
}

afterEach(() => {
  cleanup();
  disposeAllChatSessions();
});

describe("B1: FallbackGraceMenu over the real lease, five ticket cases", () => {
  it("close-before-ack: the token is released and reopening reuses the in-flight hold, ending held", () => {
    const harness = createHarness();
    registerHarness(harness);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, HOLD);
    renderGraceMenu(harness.handle);

    openMenu();
    expect(holdFrames(harness.sent)).toHaveLength(1);
    const firstClientActionId = holdFrames(harness.sent)[0];
    if (firstClientActionId.kind !== "fallback.holdForChoice") {
      throw new Error("expected a hold frame");
    }

    // Close before the ack lands.
    closeMenu();
    // The host already took the freeze by the time this close's release
    // would land - the DTO moves to `choosing`.
    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });

    // Reopen: must reuse the in-flight request, never stall.
    openMenu();
    expect(holdFrames(harness.sent)).toHaveLength(1);

    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstClientActionId.clientActionId,
        status: "accepted",
        token: "tok-close-before-ack",
      });
    });

    // Falsification: revert `fallbackHoldForChoice`'s `choosing` admission
    // (see `chat-session-store-choice-lease.test.ts`'s own falsifier) and this
    // reopen returns `null` - the menu is stuck on the label below forever.
    expect(screen.queryByText(PAUSING_COUNTDOWN_LABEL)).toBeNull();
    expect(screen.getByText("sibling-account")).toBeDefined();
  });

  it("snapshot-before-ack: a same-connection resnapshot to `choosing` while the ack is outstanding does not disturb the pending lease", () => {
    const harness = createHarness();
    registerHarness(harness);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, HOLD);
    renderGraceMenu(harness.handle);

    openMenu();
    const pendingHold = holdFrames(harness.sent)[0];
    if (pendingHold.kind !== "fallback.holdForChoice") {
      throw new Error("expected a hold frame");
    }

    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });
    // Still preparing - no token yet - but not stuck once the ack arrives.
    expect(screen.getByText(PAUSING_COUNTDOWN_LABEL)).toBeDefined();

    act(() => {
      emitActionAck(callbacks, {
        clientActionId: pendingHold.clientActionId,
        status: "accepted",
        token: "tok-snapshot-before-ack",
      });
    });

    expect(screen.queryByText(PAUSING_COUNTDOWN_LABEL)).toBeNull();
    expect(screen.getByText("sibling-account")).toBeDefined();
    expect(holdFrames(harness.sent)).toHaveLength(1);
  });

  it("snapshot-after-ack: a same-connection resnapshot to `choosing` after the hold is granted keeps the held token", () => {
    const harness = createHarness();
    registerHarness(harness);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, HOLD);
    renderGraceMenu(harness.handle);

    openMenu();
    const heldHold = holdFrames(harness.sent)[0];
    if (heldHold.kind !== "fallback.holdForChoice") {
      throw new Error("expected a hold frame");
    }
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: heldHold.clientActionId,
        status: "accepted",
        token: "tok-snapshot-after-ack",
      });
    });
    // The token is held, but the DTO itself has not moved to `choosing` yet -
    // `preparing` needs BOTH, so this is still the pausing label, not rows.
    expect(screen.getByText(PAUSING_COUNTDOWN_LABEL)).toBeDefined();

    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });

    // Falsification: revert the snapshot write's lease reconciliation to the
    // old unconditional `fallbackChoiceLease: null` - the held token is wiped
    // here and the menu falls back to "Pausing the countdown…" despite
    // already holding a valid token.
    expect(screen.queryByText(PAUSING_COUNTDOWN_LABEL)).toBeNull();
    expect(screen.getByText("sibling-account")).toBeDefined();
    expect(holdFrames(harness.sent)).toHaveLength(1);
  });

  it("reopen-during-release: closing and reopening before the release/ack race resolves reuses the same hold", () => {
    const harness = createHarness();
    registerHarness(harness);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, HOLD);
    renderGraceMenu(harness.handle);

    openMenu();
    const firstHold = holdFrames(harness.sent)[0];
    if (firstHold.kind !== "fallback.holdForChoice") {
      throw new Error("expected a hold frame");
    }
    closeMenu();
    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });
    openMenu();
    // The reopen must not mint a second lease.
    expect(holdFrames(harness.sent)).toHaveLength(1);

    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHold.clientActionId,
        status: "accepted",
        token: "tok-reopen-during-release",
      });
    });
    // The reopen withdrew the release obligation, so the ack must not send one.
    expect(releaseFrames(harness.sent)).toHaveLength(0);
    expect(screen.queryByText(PAUSING_COUNTDOWN_LABEL)).toBeNull();
  });

  it("genuine detach: a reconnect that retires the held lease under an open menu re-asks and recovers on the same stream", () => {
    const harness = createHarness();
    registerHarness(harness);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, HOLD);
    renderGraceMenu(harness.handle);

    openMenu();
    const firstHold = holdFrames(harness.sent)[0];
    if (firstHold.kind !== "fallback.holdForChoice") {
      throw new Error("expected a hold frame");
    }
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHold.clientActionId,
        status: "accepted",
        token: "tok-detach-1",
      });
    });
    // Settle fully - held token AND the DTO agrees the window is frozen -
    // before the detach, so the detach is a regression from a genuinely
    // steady state rather than from the still-preparing moment.
    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });
    expect(screen.queryByText(PAUSING_COUNTDOWN_LABEL)).toBeNull();

    // A REAL detach: connection drops (bumps connectionEpoch), then the host
    // reports the same traversal back at `hold` WHILE THE STREAM IS STILL
    // DOWN - `emitTurnState`, not `emitSnapshot`, so nothing silently repairs
    // `connectionStatus` before the reacquire effect's own `hold()` attempt
    // runs. Retires the lease under the still-open menu.
    act(() => {
      callbacks.onConnectionStatus("reconnecting", null);
    });
    act(() => {
      emitTurnState(callbacks, fallbackDto({ state: "hold", revision: 3 }));
    });

    // The connection is still not `open` at this instant, so the reacquire
    // effect's own `hold()` attempt fails to send - the menu is briefly stuck.
    expect(screen.getByText(PAUSING_COUNTDOWN_LABEL)).toBeDefined();

    // The stream comes back and the host resends the timed hold.
    act(() => {
      callbacks.onConnectionStatus("open", null);
    });
    act(() => {
      emitTurnState(callbacks, fallbackDto({ state: "hold", revision: 4 }));
    });
    const secondHold = holdFrames(harness.sent).find(
      (frame) =>
        frame.kind === "fallback.holdForChoice" &&
        frame.clientActionId !== firstHold.clientActionId,
    );
    if (
      secondHold === undefined ||
      secondHold.kind !== "fallback.holdForChoice"
    ) {
      throw new Error("expected a second hold frame once the stream reopened");
    }
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: secondHold.clientActionId,
        status: "accepted",
        token: "tok-detach-2",
      });
    });
    // The host confirms the freeze on the new connection - `pending.state`
    // moves to `choosing` again, exactly as after the first hold.
    act(() => {
      emitSnapshot(callbacks, fallbackDto({ state: "choosing", revision: 5 }));
    });

    // Falsification: delete the reacquire effect in `FallbackGraceMenu`
    // entirely - the menu sits on "Pausing the countdown…" forever from the
    // first `onConnectionStatus("reconnecting", ...)` onward.
    expect(screen.queryByText(PAUSING_COUNTDOWN_LABEL)).toBeNull();
    expect(screen.getByText("sibling-account")).toBeDefined();
  });
});

/**
 * B-RECONNECT, precisely: the effect's dependency array is `[open, lease,
 * pending, hold]` - on the WHOLE `pendingFallback` object, not its `state`/
 * `traversalId` fields - because a failed send leaves the lease slot
 * (and therefore `lease`, the guard) untouched, and only a NEW `pending`
 * object (the next authoritative frame) makes the effect re-run to retry.
 * Counted here via a spy on the store's own `fallbackHoldForChoice`, since
 * this file deliberately does not mock `useFallbackChoiceLease` and the hook
 * exposes no call-count of its own.
 */
describe("B-RECONNECT: the reacquire effect re-asks per frame, not per lease-null render", () => {
  function spyOnHold(handle: ChatSessionStoreHandle): {
    readonly calls: () => number;
  } {
    const original = handle.store.getState().fallbackHoldForChoice;
    const spy: Mock<(traversalId: string) => string | null> = vi.fn(
      (traversalId: string) => original(traversalId),
    );
    handle.store.setState({ fallbackHoldForChoice: spy });
    return { calls: () => spy.mock.calls.length };
  }

  it("arm 1 (success): retires once, re-asks exactly once, and does not spin on further frames", () => {
    const harness = createHarness();
    registerHarness(harness);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, HOLD);
    renderGraceMenu(harness.handle);
    const spy = spyOnHold(harness.handle);

    openMenu();
    expect(spy.calls()).toBe(1);
    const firstHold = holdFrames(harness.sent)[0];
    if (firstHold.kind !== "fallback.holdForChoice") {
      throw new Error("expected a hold frame");
    }
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHold.clientActionId,
        status: "accepted",
        token: "tok-arm1",
      });
    });

    act(() => {
      callbacks.onConnectionStatus("reconnecting", null);
    });
    act(() => {
      emitSnapshot(callbacks, fallbackDto({ state: "hold", revision: 3 }));
    });
    // The retirement + first re-ask.
    expect(spy.calls()).toBe(2);

    // Anti-spin control: the lease is non-null again (pending, then held), so
    // several MORE frames must not call `hold` again.
    act(() => {
      emitSnapshot(callbacks, fallbackDto({ state: "hold", revision: 4 }));
    });
    act(() => {
      emitSnapshot(callbacks, fallbackDto({ state: "hold", revision: 5 }));
    });
    // Falsification: revert the effect's deps to
    // `[open, lease, pending.state, pending.traversalId, hold]` - this
    // assertion stays green regardless (nothing here changes `pending.state`
    // or `.traversalId`), which is exactly why arm 1 alone cannot catch the
    // regression; arm 2 below is what catches it.
    expect(spy.calls()).toBe(2);
  });

  it("arm 2 (stuck send recovers): a failed hold attempt retries on the NEXT frame instead of going silent", () => {
    const harness = createHarness();
    registerHarness(harness);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, HOLD);
    renderGraceMenu(harness.handle);
    const spy = spyOnHold(harness.handle);

    openMenu();
    expect(spy.calls()).toBe(1);
    const firstHold = holdFrames(harness.sent)[0];
    if (firstHold.kind !== "fallback.holdForChoice") {
      throw new Error("expected a hold frame");
    }
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHold.clientActionId,
        status: "accepted",
        token: "tok-arm2",
      });
    });

    // Retirement. The connection is `reconnecting`, and this frame is
    // delivered via `emitTurnState` rather than `emitSnapshot` specifically so
    // nothing silently repairs `connectionStatus` before the effect's own
    // `hold()` call below runs and FAILS to send (`canSendAction` reads
    // `connectionStatus === "open"`) - the lease slot stays `null`.
    act(() => {
      callbacks.onConnectionStatus("reconnecting", null);
    });
    act(() => {
      emitTurnState(callbacks, fallbackDto({ state: "hold", revision: 3 }));
    });
    expect(spy.calls()).toBe(2);
    expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();

    // A SECOND frame arrives while still not `open` - the connection has not
    // recovered yet, so this must retry AGAIN rather than sit silent because
    // `lease` never changed on the failed attempt above.
    act(() => {
      emitTurnState(callbacks, fallbackDto({ state: "hold", revision: 4 }));
    });
    // Falsification: revert the deps to
    // `[open, lease, pending.state, pending.traversalId, hold]`. `pending`
    // (the object) changed here but `.state`/`.traversalId` did not (both
    // frames are `hold`/the same traversal), so the reverted effect never
    // re-runs and this stays at 2 - which is the bug this message exists to
    // prevent, not a leak to guard against. With the real deps this must be 3.
    expect(spy.calls()).toBe(3);

    // Now the connection genuinely recovers and the retry succeeds.
    act(() => {
      callbacks.onConnectionStatus("open", null);
    });
    act(() => {
      emitTurnState(callbacks, fallbackDto({ state: "hold", revision: 5 }));
    });
    expect(spy.calls()).toBe(4);
  });

  it("control: pending.state === choosing under the same retirement requests nothing (a live window is required to freeze)", () => {
    const harness = createHarness();
    registerHarness(harness);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, HOLD);
    renderGraceMenu(harness.handle);
    const spy = spyOnHold(harness.handle);

    openMenu();
    const firstHold = holdFrames(harness.sent)[0];
    if (firstHold.kind !== "fallback.holdForChoice") {
      throw new Error("expected a hold frame");
    }
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHold.clientActionId,
        status: "accepted",
        token: "tok-control-choosing",
      });
    });
    expect(spy.calls()).toBe(1);

    act(() => {
      callbacks.onConnectionStatus("reconnecting", null);
    });
    act(() => {
      emitSnapshot(callbacks, fallbackDto({ state: "choosing", revision: 3 }));
    });
    // The lease WAS retired (epoch moved), but `choosing` already holds a
    // window with no host-side timer - nothing to freeze, so no re-ask.
    expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();
    expect(spy.calls()).toBe(1);
  });

  it("control: a refused lease is non-null, so it requests nothing and cannot loop", () => {
    const harness = createHarness();
    registerHarness(harness);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, HOLD);
    renderGraceMenu(harness.handle);
    const spy = spyOnHold(harness.handle);

    openMenu();
    const firstHold = holdFrames(harness.sent)[0];
    if (firstHold.kind !== "fallback.holdForChoice") {
      throw new Error("expected a hold frame");
    }
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHold.clientActionId,
        status: "rejected",
        token: null,
      });
    });
    expect(harness.handle.store.getState().fallbackChoiceLease?.status).toBe(
      "refused",
    );
    expect(spy.calls()).toBe(1);

    // Several further frames on the SAME (non-retired) connection: a refused
    // lease is not `null`, so the effect's own guard excludes it every time.
    act(() => {
      emitSnapshot(callbacks, fallbackDto({ state: "hold", revision: 3 }));
    });
    act(() => {
      emitSnapshot(callbacks, fallbackDto({ state: "hold", revision: 4 }));
    });
    expect(spy.calls()).toBe(1);
  });
});
