import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type {
  Chat,
  ChatRunSettings,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  FallbackImpendingAction,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
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
  PREFERRED_CLAUDE_TUPLE,
  fallbackImpendingAction,
  fallbackProfileTarget,
  listTargetsResponse,
  pendingFallback,
} from "./fallback-fixtures";
import { kit, resetKit } from "./routing-picker-kit";

/**
 * RE-OPENED WINDOW (host ruling), through the REAL session store and the REAL
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

const EPIC_ID = "epic-reopened-window";
const CHAT_ID = "chat-reopened-window";
const HOST_ID = "host-reopened-window";
const TRAVERSAL_ID = "traversal-reopened-window";

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

function plan(planId: string, target: ChatRunSettings) {
  return fallbackImpendingAction({
    planId,
    rung: "profile",
    target,
    targetModelFamily: null,
    resumesAt: null,
    pending: null,
  });
}

function fallbackDto(input: {
  readonly state: PendingFallback["state"];
  readonly revision: number;
  readonly targetTuple: ChatRunSettings | null;
  readonly impendingAction: FallbackImpendingAction | null;
  readonly deadline: number | null;
}): PendingFallback {
  return pendingFallback({
    state: input.state,
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: input.targetTuple,
    impendingAction: input.impendingAction,
    deadline: input.deadline,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 0,
    siblingSwitching: 0,
    traversalId: TRAVERSAL_ID,
    revision: input.revision,
  });
}

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
    userId: "owner-reopened-window",
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
    userId: "owner-reopened-window",
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
        ownerUserId: "owner-reopened-window",
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

const HOLD_P = fallbackDto({
  state: "hold",
  revision: 1,
  targetTuple: TARGET_CODEX_TUPLE,
  impendingAction: plan("plan-P", TARGET_CODEX_TUPLE),
  deadline: 1_700_000_012_000,
});
/** The re-opened window: SAME traversal, new plan naming B, later deadline, higher revision. */
const HOLD_P_PRIME = fallbackDto({
  state: "hold",
  revision: 2,
  targetTuple: PREFERRED_CLAUDE_TUPLE,
  impendingAction: plan("plan-P-prime", PREFERRED_CLAUDE_TUPLE),
  deadline: 1_700_000_017_000,
});
const CHOOSING_P_PRIME = fallbackDto({
  state: "choosing",
  revision: 3,
  targetTuple: PREFERRED_CLAUDE_TUPLE,
  impendingAction: plan("plan-P-prime", PREFERRED_CLAUDE_TUPLE),
  deadline: null,
});
/** Honoured branch: the window is spent; the host commits with no target yet. */
const SWITCHING_NO_TARGET = fallbackDto({
  state: "switching",
  revision: 2,
  targetTuple: null,
  impendingAction: plan("plan-P", TARGET_CODEX_TUPLE),
  deadline: null,
});

function switchButton(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: "Switch" });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected a Switch button");
  }
  return button;
}

function spyOnLease(handle: ChatSessionStoreHandle) {
  const state = handle.store.getState();
  const originalHold = state.fallbackHoldForChoice;
  const originalRelease = state.fallbackReleaseChoice;
  const hold: Mock<(traversalId: string) => string | null> = vi.fn(
    (traversalId: string) => originalHold(traversalId),
  );
  const release: Mock<() => string | null> = vi.fn(() => originalRelease());
  handle.store.setState({
    fallbackHoldForChoice: hold,
    fallbackReleaseChoice: release,
  });
  return { hold, release };
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
        recommended: true,
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
  emitSnapshot(callbacks, HOLD_P);
  const spies = spyOnLease(harness.handle);
  render(<ChooserHarness handle={harness.handle} />);
  return { harness, callbacks, spies };
}

function openChooser(): void {
  fireEvent.click(screen.getByRole("button", { name: "Choose differently…" }));
}

afterEach(() => {
  cleanup();
  disposeAllChatSessions();
});

describe("a re-opened countdown window (same traversal, new plan)", () => {
  it("a chooser opened as window one ends keeps its pending hold into the re-opened window", () => {
    const { harness, callbacks, spies } = setUp();

    openChooser();
    expect(spies.hold).toHaveBeenCalledTimes(1);
    expect(harness.handle.store.getState().fallbackChoiceLease?.status).toBe(
      "pending",
    );
    const heldRequest = holdFrames(harness.sent)[0];
    if (heldRequest.kind !== "fallback.holdForChoice") {
      throw new Error("expected a hold frame");
    }

    // The host re-opens the window: same traversal, plan P', higher revision.
    act(() => {
      emitTurnState(callbacks, HOLD_P_PRIME);
    });

    expect(harness.handle.store.getState().fallbackChoiceLease?.status).toBe(
      "pending",
    );
    expect(spies.hold).toHaveBeenCalledTimes(1);
    expect(holdFrames(harness.sent)).toHaveLength(1);
    expect(spies.release).toHaveBeenCalledTimes(0);
    expect(switchButton().disabled).toBe(true);

    act(() => {
      emitActionAck(callbacks, {
        clientActionId: heldRequest.clientActionId,
        status: "accepted",
        token: "tok-reopened-window",
      });
    });
    act(() => {
      emitTurnState(callbacks, CHOOSING_P_PRIME);
    });
    expect(harness.handle.store.getState().fallbackChoiceLease?.status).toBe(
      "held",
    );
    expect(switchButton().disabled).toBe(false);

    openChooser();
    expect(spies.release).toHaveBeenCalledTimes(1);
    expect(releaseFrames(harness.sent)).toHaveLength(1);
  });

  it("the honoured branch retires the lease", () => {
    const { harness, callbacks, spies } = setUp();

    openChooser();
    expect(harness.handle.store.getState().fallbackChoiceLease?.status).toBe(
      "pending",
    );

    act(() => {
      emitTurnState(callbacks, SWITCHING_NO_TARGET);
    });
    expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();

    // Close (the chooser may already be gone with the card): no release goes out.
    const trigger = screen.queryByRole("button", {
      name: "Choose differently…",
    });
    if (trigger !== null) fireEvent.click(trigger);
    expect(releaseFrames(harness.sent)).toHaveLength(0);
    expect(harness.handle.store.getState().fallbackChoiceLease).toBeNull();
    expect(spies.hold).toHaveBeenCalledTimes(1);
  });
});
