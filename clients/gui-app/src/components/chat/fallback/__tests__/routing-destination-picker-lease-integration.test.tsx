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
import { RoutingDestinationPicker } from "@/components/chat/fallback/routing-destination-picker";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  fallbackProfileTarget,
  listTargetsResponse,
  pendingFallback,
} from "./fallback-fixtures";
import { kit, resetKit } from "./routing-picker-kit";

/**
 * B1 + B-RECONNECT, through the REAL session store and the REAL
 * `useFallbackChoiceLease` hook, against the routing chooser that replaced the
 * grace card's menu. `routing-destination-picker.test.tsx` mocks the lease
 * hook wholesale, so it cannot witness the seam this file is for: the
 * chooser's open/close/unmount/retire calls landing on the store's own
 * `fallbackHoldForChoice` / `fallbackReleaseChoice`, and the store's answer
 * (a token, a refusal, a retirement on reconnect) coming back as the
 * chooser's readiness. Only what has nothing to do with the lease is doubled:
 * the catalog and providers reads, the listing and the mutation transport.
 *
 * "Ready" here is what the chooser shows: the status line says the countdown
 * is paused, and stops saying it is pausing.
 */

const EPIC_ID = "epic-lease-integration";
const CHAT_ID = "chat-lease-integration";
const HOST_ID = "host-lease-integration";
const TRAVERSAL_ID = "traversal-lease-integration";
const PAUSING = "Pausing the countdown…";
const PAUSED = "Countdown paused while you choose.";

vi.mock("@/hooks/host/use-host-client-for-host-id", async () =>
  (await import("./routing-picker-kit")).hostClientModule(),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", async () =>
  (await import("./routing-picker-kit")).catalogModule(),
);
vi.mock("@/hooks/providers/use-providers-list-query", async () =>
  (await import("./routing-picker-kit")).providersListModule(),
);
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", async () =>
  (await import("./routing-picker-kit")).providersEnsurePackModule(),
);
vi.mock(
  "@/hooks/providers/use-providers-set-profile-enabled-mutation",
  async () =>
    (await import("./routing-picker-kit")).providersSetProfileEnabledModule(),
);
vi.mock("@/hooks/host/use-reactive-host-readiness", async () =>
  (await import("./routing-picker-kit")).reactiveHostReadinessModule(),
);
vi.mock("@/hooks/agent/use-host-reachability", async () =>
  (await import("./routing-picker-kit")).hostReachabilityModule(),
);
vi.mock("@/hooks/host/use-addressable-host-id", async () =>
  (await import("./routing-picker-kit")).addressableHostIdModule(),
);
vi.mock("@/hooks/host/use-host-directory-entry", async () =>
  (await import("./routing-picker-kit")).hostDirectoryEntryModule(),
);
vi.mock("@/hooks/host/use-host-directory-list-query", async () =>
  (await import("./routing-picker-kit")).hostDirectoryListModule(),
);
vi.mock("@/hooks/rate-limits/use-profile-usage-comparison", async () =>
  (await import("./routing-picker-kit")).usageComparisonModule(),
);
vi.mock("@/components/chat/fallback/use-fallback-targets", async () =>
  (await import("./routing-picker-kit")).listTargetsModule(),
);
vi.mock("@/hooks/host/use-host-scoped-mutation", async () =>
  (await import("./routing-picker-kit")).hostScopedMutationModule(),
);
vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) =>
    (await import("./routing-picker-kit")).identityModule(
      await importOriginal<
        typeof import("@/components/chat/fallback/fallback-identity")
      >(),
    ),
);
vi.mock("@/stores/tabs/use-system-tab-modal", async () =>
  (await import("./routing-picker-kit")).systemTabModalModule(),
);
vi.mock("react-virtuoso", async () =>
  (await import("./routing-picker-kit")).virtuosoModule(),
);
vi.mock("sonner", async () => ({
  toast: (await import("./routing-picker-kit")).kit.toast,
}));

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
        draftBlobBridgeSupported: () => false,
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
  callbacks.onConnectionStatus("open", null, null);
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
      portForwards: [],
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

/**
 * Reads `pendingFallback` LIVE off the real store and hands it to the real
 * chooser - the wiring the composer's card does, minus everything about this
 * scenario that is not the lease. A frame that clears the DTO renders
 * nothing rather than throwing.
 */
function ChooserHarness({
  handle,
}: {
  readonly handle: ChatSessionStoreHandle;
}) {
  const pending = handle.store((state) => state.pendingFallback);
  if (pending === undefined) return null;
  return (
    <TooltipProvider>
      <TabHostProvider hostId={HOST_ID}>
        <RoutingDestinationPicker
          entry={{ kind: "countdown", pending }}
          triggerLabel="Choose differently…"
          triggerVariant="outline"
          triggerAriaLabel={null}
          triggerDisabled={false}
          canAct
          epicId={EPIC_ID}
          chatId={CHAT_ID}
          hostId={HOST_ID}
        />
      </TabHostProvider>
    </TooltipProvider>
  );
}

function renderChooser(handle: ChatSessionStoreHandle) {
  return render(<ChooserHarness handle={handle} />);
}

/** The trigger toggles the popover: the same click opens and closes it. */
function toggleChooser(): void {
  fireEvent.click(screen.getByRole("button", { name: "Choose differently…" }));
}

function expectPausing(): void {
  expect(screen.getByText(PAUSING)).toBeDefined();
  expect(screen.queryByText(PAUSED)).toBeNull();
}

function expectPaused(): void {
  expect(screen.queryByText(PAUSING)).toBeNull();
  expect(screen.getByText(PAUSED)).toBeDefined();
}

function setUp() {
  resetKit();
  kit.listData = listTargetsResponse({
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
  const harness = createHarness();
  registerHarness(harness);
  const callbacks = harness.callbacks();
  emitSnapshot(callbacks, HOLD);
  return { harness, callbacks };
}

function firstHoldFrame(harness: Harness) {
  const frame = holdFrames(harness.sent)[0];
  if (frame.kind !== "fallback.holdForChoice") {
    throw new Error("expected a hold frame");
  }
  return frame;
}

afterEach(() => {
  cleanup();
  disposeAllChatSessions();
});

describe("B1: the routing chooser over the real lease, five ticket cases", () => {
  it("close-before-ack: the token is released and reopening reuses the in-flight hold, ending held", () => {
    const { harness, callbacks } = setUp();
    renderChooser(harness.handle);

    toggleChooser();
    expect(holdFrames(harness.sent)).toHaveLength(1);
    const first = firstHoldFrame(harness);

    // Close before the ack lands.
    toggleChooser();
    // The host already took the freeze by the time this close's release
    // would land - the DTO moves to `choosing`.
    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });

    // Reopen: must reuse the in-flight request, never stall.
    toggleChooser();
    expect(holdFrames(harness.sent)).toHaveLength(1);

    act(() => {
      emitActionAck(callbacks, {
        clientActionId: first.clientActionId,
        status: "accepted",
        token: "tok-close-before-ack",
      });
    });

    // Falsification: revert `fallbackHoldForChoice`'s `choosing` admission and
    // this reopen returns `null` - the chooser is stuck on "Pausing" forever.
    expectPaused();
    expect(screen.getByText("sibling-account")).toBeDefined();
  });

  it("snapshot-before-ack: a same-connection resnapshot to `choosing` while the ack is outstanding does not disturb the pending lease", () => {
    const { harness, callbacks } = setUp();
    renderChooser(harness.handle);

    toggleChooser();
    const pendingHold = firstHoldFrame(harness);

    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });
    // Still pausing - no token yet - but not stuck once the ack arrives.
    expectPausing();

    act(() => {
      emitActionAck(callbacks, {
        clientActionId: pendingHold.clientActionId,
        status: "accepted",
        token: "tok-snapshot-before-ack",
      });
    });

    expectPaused();
    expect(holdFrames(harness.sent)).toHaveLength(1);
  });

  it("snapshot-after-ack: a same-connection resnapshot to `choosing` after the hold is granted keeps the held token", () => {
    const { harness, callbacks } = setUp();
    renderChooser(harness.handle);

    toggleChooser();
    const heldHold = firstHoldFrame(harness);
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: heldHold.clientActionId,
        status: "accepted",
        token: "tok-snapshot-after-ack",
      });
    });
    // The token is held, but the DTO itself has not moved to `choosing` yet -
    // ready needs BOTH, so this is still the pausing line.
    expectPausing();

    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });

    // Falsification: revert the snapshot write's lease reconciliation to the
    // old unconditional `fallbackChoiceLease: null` - the held token is wiped
    // here and the chooser falls back to "Pausing" despite holding a token.
    expectPaused();
    expect(holdFrames(harness.sent)).toHaveLength(1);
  });

  it("reopen-during-release: closing and reopening before the release/ack race resolves reuses the same hold", () => {
    const { harness, callbacks } = setUp();
    renderChooser(harness.handle);

    toggleChooser();
    const firstHold = firstHoldFrame(harness);
    toggleChooser();
    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });
    toggleChooser();
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
    expectPaused();
  });

  it("genuine detach: a reconnect that retires the held lease under an open chooser re-asks and recovers on the same stream", () => {
    const { harness, callbacks } = setUp();
    renderChooser(harness.handle);

    toggleChooser();
    const firstHold = firstHoldFrame(harness);
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHold.clientActionId,
        status: "accepted",
        token: "tok-detach-1",
      });
    });
    // Settle fully - held token AND the DTO agrees the window is frozen -
    // before the detach, so the detach is a regression from a genuinely
    // steady state rather than from the still-pausing moment.
    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });
    expectPaused();

    // A REAL detach: connection drops (bumps connectionEpoch), then the host
    // reports the same traversal back at `hold` WHILE THE STREAM IS STILL
    // DOWN - `emitTurnState`, not `emitSnapshot`, so nothing silently repairs
    // `connectionStatus` before the reacquire effect's own `hold()` attempt.
    act(() => {
      callbacks.onConnectionStatus("reconnecting", null, null);
    });
    act(() => {
      emitTurnState(callbacks, fallbackDto({ state: "hold", revision: 3 }));
    });

    // The connection is not `open` at this instant, so the reacquire attempt
    // fails to send - the chooser is briefly stuck.
    expectPausing();

    // The stream comes back and the host resends the timed hold.
    act(() => {
      callbacks.onConnectionStatus("open", null, null);
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
    // The host confirms the freeze on the new connection.
    act(() => {
      emitSnapshot(callbacks, fallbackDto({ state: "choosing", revision: 5 }));
    });

    // Falsification: delete the reacquire effect in the chooser entirely - it
    // sits on "Pausing" forever from the first reconnecting status onward.
    expectPaused();
    expect(screen.getByText("sibling-account")).toBeDefined();
  });

  it("the confirm goes out with the token the real store minted, and only once both halves are true", () => {
    const { harness, callbacks } = setUp();
    renderChooser(harness.handle);

    toggleChooser();
    fireEvent.click(screen.getByRole("option", { name: /sibling-account/ }));
    const switchButton = screen.getByRole("button", { name: "Switch" });
    if (!(switchButton instanceof HTMLButtonElement)) {
      throw new Error("expected a Switch button");
    }
    expect(switchButton.disabled).toBe(true);

    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHoldFrame(harness).clientActionId,
        status: "accepted",
        token: "tok-confirm",
      });
    });
    expect(switchButton.disabled).toBe(true);
    act(() => {
      emitSnapshot(callbacks, CHOOSING);
    });
    expect(switchButton.disabled).toBe(false);
    fireEvent.click(switchButton);

    expect(kit.mutations).toHaveLength(1);
    expect(kit.mutations[0].variables).toMatchObject({
      traversalId: TRAVERSAL_ID,
      revision: 2,
      leaseToken: "tok-confirm",
    });
  });

  it("unmounting the open chooser hands the frozen window back through the real store", () => {
    const { harness, callbacks } = setUp();
    const view = renderChooser(harness.handle);

    toggleChooser();
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHoldFrame(harness).clientActionId,
        status: "accepted",
        token: "tok-unmount",
      });
    });
    expect(releaseFrames(harness.sent)).toHaveLength(0);

    view.unmount();

    expect(releaseFrames(harness.sent)).toHaveLength(1);
  });
});

/**
 * B-RECONNECT, precisely: the effect's dependency array is `[open, lease,
 * pending, hold]` - on the WHOLE `pendingFallback` object, not its `state`/
 * `traversalId` fields - because a failed send leaves the lease slot (and
 * therefore `lease`, the guard) untouched, and only a NEW `pending` object (the
 * next authoritative frame) makes the effect re-run to retry. Counted here via
 * a spy on the store's own `fallbackHoldForChoice`, since this file
 * deliberately does not mock `useFallbackChoiceLease` and the hook exposes no
 * call-count of its own.
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
    const { harness, callbacks } = setUp();
    renderChooser(harness.handle);
    const spy = spyOnHold(harness.handle);

    toggleChooser();
    // The store hands the lease back in the same commit, so the retire guard
    // finds one and does not ask a second time.
    expect(spy.calls()).toBe(1);
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHoldFrame(harness).clientActionId,
        status: "accepted",
        token: "tok-arm1",
      });
    });

    act(() => {
      callbacks.onConnectionStatus("reconnecting", null, null);
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
    expect(spy.calls()).toBe(2);
  });

  it("arm 2 (stuck send recovers): a failed hold attempt retries on the NEXT frame instead of going silent", () => {
    const { harness, callbacks } = setUp();
    renderChooser(harness.handle);
    const spy = spyOnHold(harness.handle);

    toggleChooser();
    expect(spy.calls()).toBe(1);
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHoldFrame(harness).clientActionId,
        status: "accepted",
        token: "tok-arm2",
      });
    });

    // Retirement. The connection is `reconnecting`, and this frame is
    // delivered via `emitTurnState` rather than `emitSnapshot` so nothing
    // repairs `connectionStatus` before the effect's own `hold()` call runs
    // and FAILS to send (`canSendAction` reads `connectionStatus === "open"`)
    // - the lease slot stays `null`.
    act(() => {
      callbacks.onConnectionStatus("reconnecting", null, null);
    });
    act(() => {
      emitTurnState(callbacks, fallbackDto({ state: "hold", revision: 3 }));
    });
    expect(spy.calls()).toBe(2);
    expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();

    // A SECOND frame arrives while still not `open`: it must retry AGAIN
    // rather than sit silent because `lease` never changed on the failed
    // attempt above. With the whole `pending` object in the deps this is 3.
    act(() => {
      emitTurnState(callbacks, fallbackDto({ state: "hold", revision: 4 }));
    });
    expect(spy.calls()).toBe(3);

    // Now the connection genuinely recovers and the retry succeeds.
    act(() => {
      callbacks.onConnectionStatus("open", null, null);
    });
    act(() => {
      emitTurnState(callbacks, fallbackDto({ state: "hold", revision: 5 }));
    });
    expect(spy.calls()).toBe(4);
  });

  it("control: pending.state === choosing under the same retirement requests nothing (a live window is required to freeze)", () => {
    const { harness, callbacks } = setUp();
    renderChooser(harness.handle);
    const spy = spyOnHold(harness.handle);

    toggleChooser();
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHoldFrame(harness).clientActionId,
        status: "accepted",
        token: "tok-control-choosing",
      });
    });
    expect(spy.calls()).toBe(1);

    act(() => {
      callbacks.onConnectionStatus("reconnecting", null, null);
    });
    act(() => {
      emitSnapshot(callbacks, fallbackDto({ state: "choosing", revision: 3 }));
    });
    // The lease WAS retired (epoch moved), but `choosing` already holds a
    // window with no host-side timer - nothing to freeze, so no re-ask.
    expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();
    expect(spy.calls()).toBe(1);
  });

  it("control: a refused lease is non-null, so it requests nothing and cannot loop - and the chooser says the countdown was not paused", () => {
    const { harness, callbacks } = setUp();
    renderChooser(harness.handle);
    const spy = spyOnHold(harness.handle);

    toggleChooser();
    act(() => {
      emitActionAck(callbacks, {
        clientActionId: firstHoldFrame(harness).clientActionId,
        status: "rejected",
        token: null,
      });
    });
    expect(harness.handle.store.getState().fallbackChoiceLease?.status).toBe(
      "refused",
    );
    expect(spy.calls()).toBe(1);
    expect(screen.getByText("Couldn't pause the countdown.")).toBeDefined();

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
