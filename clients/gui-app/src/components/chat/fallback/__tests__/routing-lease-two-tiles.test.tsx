import {
  cleanup,
  fireEvent,
  render,
  within,
  type RenderResult,
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

const EPIC_ID = "epic-two-tiles";
const CHAT_ID = "chat-two-tiles";
const HOST_ID = "host-two-tiles";
const TRAVERSAL_ID = "traversal-two-tiles";

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
    userId: "owner-two-tiles",
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
    userId: "owner-two-tiles",
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
        ownerUserId: "owner-two-tiles",
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

function LeaseChooser({ handle }: { readonly handle: ChatSessionStoreHandle }) {
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
  emitSnapshot(harness.callbacks(), HOLD);
  const spies = spyOnLease(harness.handle);
  // Two separate roots over the ONE session handle.
  const tileA = render(<LeaseChooser handle={harness.handle} />);
  const tileB = render(<LeaseChooser handle={harness.handle} />);
  return { harness, spies, tileA, tileB };
}

function triggerIn(view: RenderResult): HTMLElement {
  return within(view.container).getByRole("button", {
    name: "Choose differently…",
  });
}

afterEach(() => {
  cleanup();
  disposeAllChatSessions();
});

describe("two tiles, one chat, one countdown traversal", () => {
  it("a tile whose chooser never opened releases nothing when it closes", () => {
    const { spies, tileA, tileB } = setUp();

    fireEvent.click(triggerIn(tileA));
    expect(spies.hold).toHaveBeenCalledTimes(1);
    expect(spies.release).toHaveBeenCalledTimes(0);

    tileB.unmount();
    expect(spies.release).toHaveBeenCalledTimes(0);

    fireEvent.click(triggerIn(tileA));
    expect(spies.release).toHaveBeenCalledTimes(1);
    expect(spies.hold).toHaveBeenCalledTimes(1);
  });

  it("a tile unmounted while its chooser is open releases exactly once", () => {
    const { spies, tileA, tileB } = setUp();

    fireEvent.click(triggerIn(tileA));
    expect(spies.hold).toHaveBeenCalledTimes(1);

    tileA.unmount();
    expect(spies.release).toHaveBeenCalledTimes(1);

    tileB.unmount();
    expect(spies.release).toHaveBeenCalledTimes(1);
    expect(spies.hold).toHaveBeenCalledTimes(1);
  });
});
