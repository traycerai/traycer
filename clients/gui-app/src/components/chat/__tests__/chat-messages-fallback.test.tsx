import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSender,
  Chat,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { assistantRowId } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type {
  ChatRunSettings,
  FallbackImpendingAction,
  LastFallbackOutcome,
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ChatLoadRangeRequest,
  ChatTranscriptDerived,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { ProviderNoticeDetail } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  isTailHydrated,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type ConfirmedManualFallbackAction,
} from "@/stores/chats/chat-session-store";
import {
  disposeAllChatSessions,
  getChatSessionRegistry,
} from "@/lib/registries/chat-session-registry";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import {
  createFallbackAnnouncementObserver,
  type FallbackAnnouncementsInput,
  type FallbackTraversalAnnouncement,
} from "@/stores/chats/chat-announcements";
import { ChatMessages } from "@/components/chat/chat-messages";
import type {
  ChatMessage as ChatMessageModel,
  ProviderNoticeSegment,
} from "@/stores/composer/chat-store";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import { FRESH_SESSION_HELPER } from "@/components/chat/fallback/fallback-copy";
import { usePublishConfirmedManualFallbackAction } from "@/components/chat/fallback/use-confirmed-manual-action";
import { useFallbackRunManualRung } from "@/components/chat/fallback/use-fallback-actions";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  installLegendListViewportMetrics,
  setLegendListScrollContainerScrollHeightOverride,
} from "./legend-list-test-environment";
import { makeMessage } from "./chat-message-fixtures";

/**
 * F22 integration pins for the fallback announcer's real wiring: props ->
 * store -> `ChatFallbackAnnouncementSource` -> `createFallbackAnnouncementObserver`
 * -> the polite live region, and the manual-switch publisher's real
 * mutation-outlives-unmount path. The pure-deriver contract itself (absorb
 * rules, semantic-key dedupe, reconnect persistence, hydration/resident-set
 * rules) is exhaustively pinned in
 * `stores/chats/__tests__/chat-announcements-fallback.test.ts`; this file
 * does NOT re-derive that machinery - it proves the real store/component
 * plumbing actually reaches it.
 *
 * Expected destination strings are HAND-WRITTEN literals, independent of
 * `fallbackDestinationOfTuple`/`fallbackDestinationSentence` (the SUT's own
 * formatters) - see the literal block below. The session-registry resolution
 * hook is seeded through the real `getChatSessionRegistry().acquire(...)`
 * seam (`registerHarness`), unmocked. `useHostScopedMutationForClient` is
 * unmocked too, backed by a real `HostClient` + `MockHostMessenger`
 * requester (bound to `mockLocalHostEntry`, which `HOST_ID` is aligned to)
 * with a controllable/deferred response per test - the D71 unmount-survival
 * tests hold that response open across a real `unmount()` before resolving
 * it, so a per-call callback regression (torn down with the component)
 * would actually redden them.
 *
 * Mocked, and OUTSIDE the store/observer/mutation lifecycle under test:
 * `useHostClientForHostId` (resolves to the one real `liveHostClient`
 * regardless of the id it's called with) and `useProvidersListForClient`
 * (returns `{ data: undefined }`, so every profile label degrades to its
 * id prefix - see the literal-string comment below). NOT mocked: the store
 * itself (a real `createChatSessionStore`), the observer
 * (`createFallbackAnnouncementObserver`), the announcer's queue/effect
 * wiring, and `usePublishConfirmedManualFallbackAction`.
 *
 * SCOPE NOTE (D224/R1): a REAL windowed-snapshot foundation
 * (`createWindowedHarness`/`emptyWindowedSnapshot`/`deferredWindowedSnapshot`/
 * `completeTail`, adapted from G1's
 * `chat-session-store-last-fallback-outcome.test.ts`) is fully wired
 * through both D224 epoch arms below, and a separate R1 scenario (its own
 * harness, its own tail response, real `useRenderedMessages`) proves the
 * eventual-body/eventual-projection side of the same outcome-metadata
 * pipeline.
 *
 * This file also includes one DIRECT observer guard control ("traversal
 * absorption", `createFallbackAnnouncementObserver` called with no React
 * involved at all) alongside its usual mounted-component integration
 * style - used where a mounted assertion stacks more than one independent
 * baseline protection and no single mutation against the mounted tree
 * alone can attribute a silence to one specific guard.
 */

// Bound to `mockLocalHostEntry.hostId` deliberately: the real
// `HostClient`/`MockHostMessenger` requester below is built against that
// entry, so the session-registry-seeded store and the RPC transport must
// name the SAME host or `client.getActiveHostId()`/the confirmed-action
// scoping guard would be comparing two different ids that happen to both be
// wrong.
const HOST_ID = mockLocalHostEntry.hostId;
const EPIC_ID = "epic-fallback-int";
const CHAT_ID = "chat-fallback-int";
const OWNER_ID = "owner-fallback-int";
const VIEWPORT_HEIGHT_PX = 700;
const VIEWPORT_WIDTH_PX = 800;

const FAILED_TUPLE: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-6-astra",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: "acct-north",
};
const TARGET_TUPLE: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-6-astra-mini",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: "acct-south",
};
const PREFERRED_TUPLE: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-opus-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: "acct-north",
};

// HAND-WRITTEN literal expected strings - deliberately NOT computed via
// `fallbackDestinationOfTuple`/`fallbackDestinationSentence` (the same
// production functions the SUT itself calls to build these sentences), so a
// broken formatter cannot pass by agreeing with itself. Derived by hand from
// `fallback-identity.ts`'s documented rules:
//   - the host client itself is REAL (a live `HostClient` + `MockHostMessenger`
//     requester bound to `mockLocalHostEntry`, unmocked at
//     `useHostScopedMutationForClient`); only `useProvidersListForClient`
//     (the providers-list RPC read, outside the store/observer/mutation
//     lifecycle under test) is mocked to `{ data: undefined }`, so no
//     providers RPC data resolves and every profile id degrades to its own
//     `PROFILE_ID_PREFIX_LENGTH` (8) char prefix - "acct-north"/"acct-south"
//     read as "acct-nor"/"acct-sou".
//   - a sentence is "<provider · model · effort> on <profile>", with the
//     provider clause included only when the caller says the switch crosses
//     providers.
const FAILED_PROFILE_LABEL = "acct-nor"; // "acct-north".slice(0, 8)
const TARGET_PROFILE_LABEL = "acct-sou"; // "acct-south".slice(0, 8)
// Same literal profile id as FAILED_TUPLE, on a DIFFERENT provider - the
// fixture's deliberate duplicate-label case (see FAILED_TUPLE/PREFERRED_TUPLE
// above), so a test matching on the bare label alone would be fooled by it.
const PREFERRED_PROFILE_LABEL = FAILED_PROFILE_LABEL;

// `pending.failedTuple`'s identity is ALWAYS built with `includeProvider:
// true` (chat-messages.tsx's `observeState`:
// `fallbackDestinationSentence(fallbackDestinationOfTuple(pending.failedTuple,
// labelFor), true)`), regardless of same/cross-provider - it names WHERE the
// chat is failing away FROM, which is worth saying even on a same-provider
// destination switch. The destination (`TARGET_IDENTITY`) is the one that
// omits the provider clause on a same-provider switch (`includeProvider:
// false`, F5's same-provider case) - these two are NOT symmetric, and using
// the destination's rule for the failed side was the actual bug this
// literal fixes.
const FAILED_IDENTITY = `Codex · gpt-6-astra · high on ${FAILED_PROFILE_LABEL}`;
const TARGET_IDENTITY = `gpt-6-astra-mini · high on ${TARGET_PROFILE_LABEL}`;
// Cross-provider (codex -> claude) return-offer text always includes it.
const PREFERRED_IDENTITY = `Claude Code · claude-opus-5 on ${PREFERRED_PROFILE_LABEL}`;
// The manual-switch CONFIRMATION sentence always includes the provider
// clause regardless of same-provider-ness (coordinator correction) - a
// DIFFERENT literal from TARGET_IDENTITY above precisely because TARGET_TUPLE
// is same-provider as FAILED_TUPLE. Using TARGET_IDENTITY here was the actual
// bug this constant fixes: it silently matched even though the real sentence
// carries a leading "Codex · " that TARGET_IDENTITY lacks.
const MANUAL_SWITCH_TARGET_IDENTITY = `Codex · gpt-6-astra-mini · high on ${TARGET_PROFILE_LABEL}`;

function impendingAction(input: {
  readonly planId: string;
  readonly rung: FallbackImpendingAction["rung"];
  readonly target: ChatRunSettings | null;
  readonly resumesAt: number | null;
  readonly pending: FallbackImpendingAction["pending"];
}): FallbackImpendingAction {
  return {
    planId: input.planId,
    rung: input.rung,
    target: input.target,
    targetModelFamily: null,
    resumesAt: input.resumesAt,
    pending: input.pending,
  };
}

function pendingFallback(input: {
  readonly state: PendingFallback["state"];
  readonly traversalId: string;
  readonly revision: number;
  readonly deadline: number | null;
  readonly targetTuple: ChatRunSettings | null;
  readonly impendingAction: FallbackImpendingAction | null;
  readonly queuedItemsMoving: number;
}): PendingFallback {
  return {
    traversalId: input.traversalId,
    revision: input.revision,
    state: input.state,
    reason: "rate_limit",
    failedTuple: FAILED_TUPLE,
    targetTuple: input.targetTuple,
    impendingAction: input.impendingAction,
    deadline: input.deadline,
    graceRemainingMs: null,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: input.queuedItemsMoving,
    siblingSwitching: 0,
  };
}

function pendingReturn(input: {
  readonly traversalId: string;
  readonly revision: number;
  readonly queuedItemsMoving: number;
}): PendingReturn {
  return {
    traversalId: input.traversalId,
    revision: input.revision,
    preferredTuple: PREFERRED_TUPLE,
    fallbackTuple: TARGET_TUPLE,
    queuedItemsMoving: input.queuedItemsMoving,
    offeredAt: 0,
  };
}

function providerNoticeSegment(input: {
  readonly id: string;
  readonly noticeKind: ProviderNoticeSegment["noticeKind"];
  readonly title: string;
  readonly details: ReadonlyArray<ProviderNoticeDetail>;
}): ProviderNoticeSegment {
  return {
    id: input.id,
    kind: "provider_notice",
    status: "completed",
    noticeKind: input.noticeKind,
    tone: "info",
    title: input.title,
    message: null,
    details: input.details,
    parentId: null,
  };
}

function assistantNoticeMessage(input: {
  readonly id: string;
  readonly segment: ProviderNoticeSegment;
}): ChatMessageModel {
  return {
    id: input.id,
    role: "assistant",
    content: "",
    segments: [input.segment],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: 1,
    stopped: null,
    persistentMessageId: input.id,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function emptyChat(): Chat {
  return {
    id: CHAT_ID,
    parentId: null,
    userId: OWNER_ID,
    hostId: HOST_ID,
    title: "Fallback integration chat",
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

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
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
 * The REAL windowed-snapshot foundation (D224/R1), adapted from G1's
 * `chat-session-store-last-fallback-outcome.test.ts` (`createWindowedHarness`
 * / `deferredWindowedSnapshot` / `completeTail`) - NOT a copy of that file,
 * read and re-derived against this file's own `HOST_ID`/`EPIC_ID`/`CHAT_ID`.
 * `requestTranscriptRange` here RECORDS every outstanding range request
 * (unlike the legacy `Harness`'s stub, which drops them), which is what lets
 * a test complete a held tail on demand via `completeTail`.
 */
interface WindowedHarness extends Harness {
  readonly rangeRequests: ChatLoadRangeRequest[];
  lastRangeRequestId(): string;
}

function createWindowedHarness(): WindowedHarness {
  const rangeRequests: ChatLoadRangeRequest[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: (request) => {
          rangeRequests.push(request);
        },
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    rangeRequests,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
    lastRangeRequestId: () => {
      const last = rangeRequests.at(-1);
      if (last === undefined) throw new Error("Expected an outstanding range");
      return last.requestId;
    },
  };
}

const WINDOWED_DERIVED: ChatTranscriptDerived = {
  latestAssistantUsage: null,
  pinnedTodo: null,
  pinnedTaskTodoItems: [],
  latestForkableAssistantMessageId: null,
  restorableSetupInterruption: null,
  interviewAnswerability: [],
  latestAssistantAuthFailureTurnKey: null,
  setupCardWindows: [],
};

/**
 * A windowed snapshot whose tail is deliberately UNHYDRATED
 * (`isTailHydrated` reads it false: `tail.fromOrdinal` is past ordinal 0 and
 * `rowCount` exceeds what `tail.messages` carries) - every D224 case below
 * relies on this to exercise the DEFERRAL branch, not the ordinary fold, so
 * the outcome metadata seats before any row is ever hydrated.
 */
const WINDOWED_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

/** A real persisted user `Message`, matching `row-<n>` in `completeTail` below. */
function userMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: {
      kind: "user",
      content: WINDOWED_CONTENT,
      browserAnnotations: [],
    },
    timestamp,
    sessionAnchor: null,
  };
}

function windowedSnapshotBase(input: {
  readonly transcriptEpoch: number;
  readonly rowCount: number;
  readonly tail: {
    fromOrdinal: number;
    messages: readonly Message[];
    events: readonly [];
  };
  readonly lastFallbackOutcome: LastFallbackOutcome | undefined;
}): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: HOST_ID,
        title: "Fallback integration chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        archivedAt: null,
        lastDeliveredRolesDigest: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        pinnedUserProviderHandle: null,
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      transcriptEpoch: input.transcriptEpoch,
      rowCount: input.rowCount,
      indexRevision: null,
      // Copy at this boundary - `input.tail.messages`/`events` are typed
      // `readonly`, but the wire schema's `tail` is mutable; passing the
      // readonly arrays through directly fails the compile, and a cast
      // would paper over the actual mismatch instead of fixing it.
      tail: {
        fromOrdinal: input.tail.fromOrdinal,
        messages: [...input.tail.messages],
        events: [...input.tail.events],
      },
      derived: WINDOWED_DERIVED,
      pendingFallback: undefined,
      pendingReturn: undefined,
      lastFallbackOutcome: input.lastFallbackOutcome,
    },
  };
}

/**
 * A truly EMPTY windowed baseline (`rowCount: 0`, `tail.fromOrdinal: 0`) -
 * `isTailHydrated` reads this TRUE trivially (there is nothing left to
 * cover), so it folds immediately via `applyAuthoritativeSnapshot` and
 * establishes `transcriptBaselineEpoch` with nothing already warm. Delivering
 * `deferredWindowedSnapshot` afterward at the SAME wire epoch then genuinely
 * exercises the deferral branch, rather than being silently absorbed by a
 * span the baseline already covered.
 */
function emptyWindowedSnapshot(
  transcriptEpoch: number,
): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  return windowedSnapshotBase({
    transcriptEpoch,
    rowCount: 0,
    tail: { fromOrdinal: 0, messages: [], events: [] },
    lastFallbackOutcome: undefined,
  });
}

/**
 * A windowed snapshot whose tail is deliberately UNHYDRATED
 * (`isTailHydrated` reads it false: `tail.fromOrdinal` is past ordinal 0 and
 * `rowCount` exceeds what `tail.messages` carries) - every D224 case below
 * relies on this to exercise the DEFERRAL branch, not the ordinary fold, so
 * the outcome metadata seats before any row is ever hydrated.
 */
function deferredWindowedSnapshot(
  lastFallbackOutcome: LastFallbackOutcome | undefined,
  transcriptEpoch: number,
): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  return windowedSnapshotBase({
    transcriptEpoch,
    rowCount: 2,
    tail: { fromOrdinal: 2, messages: [], events: [] },
    lastFallbackOutcome,
  });
}

/**
 * Completes the most recently outstanding range request with real persisted
 * `Message` rows matching `row-0`/`row-1`, hydrating the tail fully - a
 * bodyless range response can mark a span hydrated without proving real
 * transcript seating, so this must carry actual messages, not `[]`.
 */
function completeTail(harness: WindowedHarness, transcriptEpoch: number): void {
  harness.callbacks().onRange({
    kind: "range",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    range: {
      requestId: harness.lastRangeRequestId(),
      epoch: transcriptEpoch,
      fromOrdinal: 0,
      rowIds: ["row-0", "row-1"],
      messages: [userMessage("m-0", 0), userMessage("m-1", 1)],
      events: [],
      rowContext: {},
      reachedStart: true,
      reachedEnd: true,
    },
  });
}

/** Brings the store to `ready` (open, snapshot loaded) and returns the resulting baseline epoch. */
function bootstrap(
  harness: Harness,
  pending: PendingFallback | undefined,
  returning: PendingReturn | undefined,
  lastFallbackOutcome: LastFallbackOutcome | undefined,
): number {
  harness.callbacks().onConnectionStatus("open", null);
  harness.callbacks().onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: emptyChat(),
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
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
      pendingReturn: returning,
      lastFallbackOutcome,
    },
  });
  return harness.handle.store.getState().transcriptBaselineEpoch;
}

function setTurnState(
  harness: Harness,
  pending: PendingFallback | undefined,
  returning: PendingReturn | undefined,
  lastFallbackOutcome: LastFallbackOutcome | undefined,
): void {
  harness.callbacks().onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "idle",
    activeTurn: null,
    pendingFallback: pending,
    pendingReturn: returning,
    lastFallbackOutcome,
  });
}

/**
 * Seeds the REAL, process-wide chat-session registry (`getChatSessionRegistry`
 * - the same module-singleton `useExistingChatSessionHandle` reads through
 * via `registry.peek`) with an already-built handle, rather than mocking the
 * registry module. `useExistingChatSessionHandle` itself is exercised
 * unmocked below.
 */
function registerHarness(harness: Harness): void {
  getChatSessionRegistry().acquire(
    { epicId: EPIC_ID, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "test" },
    () => harness.handle,
  );
}

// REAL RPC transport: a real `HostClient` + `MockHostMessenger`, mirroring
// `chat-usage-dialog.test.tsx`'s established minimal-footprint pattern.
// `useHostScopedMutationForClient` itself is UNMOCKED below - only its
// transport (host client resolution) and its external providers-list read
// are faked, so the mutation's real TanStack lifecycle (mount-time
// `onMutate`, mutation-level `onSuccess` surviving an unmounted caller,
// `onError`) is what actually runs.
type RunManualRungResponse = ResponseOfMethod<
  HostRpcRegistry,
  "chat.fallback.runManualRung"
>;

const runManualRungState = vi.hoisted(() => ({
  // Overridable per test. Defaults to an immediately-resolved "applied" so
  // every test that doesn't care about the RPC's timing (most of them) keeps
  // working unchanged; only the unmount-survival test below swaps in a
  // controllable deferred promise.
  handler: (): Promise<RunManualRungResponse> =>
    Promise.resolve({ outcome: "applied" }),
  callCount: { current: 0 },
}));

const liveHostClientSpine = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: { invalidateHostScope: () => undefined },
  findHostById: (hostId) =>
    hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
    handlers: {
      "chat.fallback.runManualRung": () => {
        runManualRungState.callCount.current += 1;
        return runManualRungState.handler();
      },
    },
  }),
});
liveHostClientSpine.setRequestContext(
  createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
);
const liveHostClient = liveHostClientSpine.createRequester(mockLocalHostEntry);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => liveHostClient,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

/** A minimal deferred - lets a test hold the RPC response open across an unmount. */
function makeDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A tiny stand-in for a real popover: fires a confirmed switch via the REAL manual-action publisher and mutation hook (real transport, real TanStack lifecycle), then can be unmounted. */
function ManualSwitchTrigger(props: {
  readonly userMessageId: string;
  readonly turnId: string;
  readonly target: ChatRunSettings;
}): ReactElement {
  const publish = usePublishConfirmedManualFallbackAction({
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    hostId: HOST_ID,
  });
  const client = useHostClientForHostId(HOST_ID);
  const { mutate } = useFallbackRunManualRung(client, CHAT_ID, publish);
  return (
    <button
      type="button"
      onClick={() =>
        mutate({
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          rung: "switch",
          target: props.target,
          userMessageId: props.userMessageId,
          turnId: props.turnId,
        })
      }
    >
      Confirm switch
    </button>
  );
}

interface ChatRenderState {
  messages: ReadonlyArray<ChatMessageModel>;
  baselineEpoch: number;
  hydrationSequence: number;
  coldRewrittenMessageIds: ReadonlySet<string>;
  visible: boolean;
  // `null` everywhere except the T4 real-windowed-hydration case, which
  // passes the harness's actual `state.transcriptWindow` instead.
  transcriptWindow: TranscriptWindow | null;
  // `HOST_ID` everywhere except the parent rebase reset control below, which
  // sets this `null` to disable the fallback child (`ChatMessages`'s own
  // `handle !== null && props.hostId !== null` gate) without touching any
  // other prop.
  hostId: string | null;
}

/**
 * Real host RPCs (`chat.fallback.runManualRung`, and any other mutation the
 * tree issues) go through `useHostScopedMutationForClient`'s real
 * `useQueryClient()` call, so every rendered tree - `ChatMessages` and any
 * `ManualSwitchTrigger` - needs a `QueryClientProvider` ancestor. Two trees
 * that must observe the SAME mutation lifecycle (the unmount-survival tests)
 * are given the SAME `QueryClient` instance explicitly; everything else gets
 * its own fresh one.
 */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function chatScene(
  state: ChatRenderState,
  queryClient: QueryClient,
): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <div
        data-chat-keyboard-scroll-scope
        data-active="true"
        data-group-id="pane-int"
        style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}
      >
        <ChatMessages
          taskTitle="Fallback integration chat"
          taskId={CHAT_ID}
          epicId={EPIC_ID}
          hostId={state.hostId}
          messages={state.messages}
          transcriptWindow={state.transcriptWindow}
          onVisibleOrdinalRangeChange={() => undefined}
          baselineEpoch={state.baselineEpoch}
          hydrationSequence={state.hydrationSequence}
          coldRewrittenMessageIds={state.coldRewrittenMessageIds}
          backgroundItems={undefined}
          getMessageActions={() => null}
          nextStepActions={null}
          instanceId="instance-fallback-int"
          visible={state.visible}
          systemOverlayActive={false}
          scrollRequest={null}
          composerOverlayHeight={80}
        />
      </div>
    </QueryClientProvider>
  );
}

function renderChat(
  baselineEpoch: number,
  queryClient: QueryClient | undefined,
) {
  const client = queryClient ?? createTestQueryClient();
  const state: ChatRenderState = {
    messages: [],
    baselineEpoch,
    hydrationSequence: 0,
    coldRewrittenMessageIds: new Set(),
    visible: true,
    transcriptWindow: null,
    hostId: HOST_ID,
  };
  const result = render(chatScene(state, client));
  return {
    ...result,
    queryClient: client,
    rerenderWith: (patch: Partial<ChatRenderState>) => {
      Object.assign(state, patch);
      result.rerender(chatScene(state, client));
    },
  };
}

/** Renders `ManualSwitchTrigger` under the given `QueryClient` - pass the SAME instance as the corresponding `renderChat` call when the two must share one mutation lifecycle. */
function renderTrigger(
  props: {
    readonly userMessageId: string;
    readonly turnId: string;
    readonly target: ChatRunSettings;
  },
  queryClient: QueryClient,
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ManualSwitchTrigger {...props} />
    </QueryClientProvider>,
  );
}

// The ChatMessages fallback/completion announcer's own region
// (chat-messages.tsx:1244) - `role="status"` + `aria-atomic="true"`
// distinguish it from OTHER `[aria-live="polite"]` regions rendered inside
// the same tree (queued-message-surface's resend status, image-generation's
// progress span, the fallback destination menu's own `role="status"`
// region without `aria-atomic`, etc.) so this selector cannot be
// accidentally satisfied by an unrelated row's live region.
const LIVE_REGION_SELECTOR =
  '[role="status"][aria-live="polite"][aria-atomic="true"]';

function liveRegion(): Element {
  const region = document.querySelector(LIVE_REGION_SELECTOR);
  if (region === null) {
    throw new Error("chat-messages fallback/completion live region not found");
  }
  return region;
}

function liveRegionText(): string {
  return liveRegion().textContent;
}

function liveRegionSpan(): Element | null {
  return document.querySelector(`${LIVE_REGION_SELECTOR} span`);
}

/** Waits for the announcer's deferred (`queueMicrotask`) commit inside `act`. */
async function flushAnnouncer(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Captures the live region's committed text at EACH DOM mutation while
 * `action` runs, rather than reading one point-in-time snapshot afterward.
 * `useChatAnnouncementQueue`'s layout effect purges a consumed entry from
 * its pending queue the instant its own commit lands
 * (`stores/chats/chat-announcements.ts` ~709-716), so an
 * already-spoken announcement's text is gone from a LATER read even though
 * it genuinely committed once - two transitions dispatched in one `act` are
 * not guaranteed to land in one React commit (a rerender's commit and a
 * zustand store publish are independent triggers), so this proves each
 * sentence was actually rendered at some point in the trace, without
 * assuming or requiring they coalesce into a single joined string.
 */
async function captureLiveRegionCommits(
  action: () => void,
): Promise<readonly string[]> {
  const region = liveRegion();
  const commits: string[] = [];
  // Reused by BOTH the async callback and the `takeRecords()` flush below,
  // so no record is ever processed by a different path than the other.
  const collect = (records: readonly MutationRecord[]): void => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element && node.tagName === "SPAN") {
          commits.push(node.textContent);
        }
      }
    }
  };
  const observer = new MutationObserver(collect);
  // Direct `childList` on the region itself, NOT `subtree`/`characterData`:
  // the region's single keyed child span (chat-messages.tsx:1246,
  // `<span key={announcement.sequence}>`) is REPLACED wholesale on every
  // announcement, so each insertion is its own `addedNodes` entry on its
  // own `MutationRecord` - reading `region.textContent` once per callback
  // instead would collapse several batched records (and the announcements
  // some of them exposed) into one point-in-time snapshot, silently
  // losing an earlier span whose removal record was already batched into
  // the SAME callback invocation as a later insertion.
  observer.observe(region, { childList: true });
  try {
    await act(async () => {
      action();
      // Several microtask turns: one for each `queueMicrotask` the
      // announcer queue schedules, plus slack for the MutationObserver's
      // own microtask-queued callback to run and record each commit.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Flush any records the callback was never invoked for, through the
    // SAME collector - `takeRecords()` returns pending records without
    // ever calling back on its own.
    collect(observer.takeRecords());
  } finally {
    observer.disconnect();
  }
  return commits;
}

/**
 * Exact LITERAL occurrence count of `sentence` summed across every
 * collected span text, not a per-span presence filter. A `text.includes`
 * filter followed by `.length === 1` only counts how many SPANS contain the
 * sentence at least once - a single span holding the real queue's
 * pending-entries join (`pending.current.map(...).join(" ")`,
 * chat-announcements.ts ~704) with the sentence appearing TWICE inside it
 * would still pass that check. Splitting on the sentence and subtracting 1
 * counts every actual occurrence, within one span and across spans alike.
 */
function countSentenceOccurrences(
  texts: readonly string[],
  sentence: string,
): number {
  return texts.reduce(
    (total, text) => total + (text.split(sentence).length - 1),
    0,
  );
}

// Off-tail scroll simulation, adapted from `chat-messages.test.tsx`
// (`getScrollNode`/`fireScrollTopAndFlush`/`enterFreeScrollingAwayFromEnd`,
// ~419-510) - own identifiers, not a copy. `installLegendListViewportMetrics`
// (called in `beforeEach` below) stubs the real `@legendapp/list/react`
// geometry (`scrollHeight`/`clientHeight`/`scrollTop` etc.) globally, so
// these drive the SAME real virtualized scroll container `ChatMessages`
// renders - no LegendList mock of our own is needed.
const LEGEND_LIST_HEADER_PX = 40;

function scrollNode(): HTMLElement {
  const node = screen.getByTestId("chat-messages-scroll");
  if (!(node instanceof HTMLElement)) {
    throw new Error("chat-messages-scroll is not an HTMLElement");
  }
  return node;
}

/** Sets `scrollTop` and fires `scroll`, then yields one animation frame so
 * LegendList's own (batched) scroll processing runs before anything else
 * reads its derived state. */
async function fireScrollTopAndFlush(scrollTop: number): Promise<void> {
  const node = scrollNode();
  await act(async () => {
    node.scrollTop = scrollTop;
    fireEvent.scroll(node);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/** Enter free-scrolling away from the tail so the "New Reply"/jump pill's
 * containing surface is visible (`resolveScrollToEndPillState`'s
 * `visible` gate) - the ONLY automatic path after departing the strict
 * end. */
async function enterFreeScrollingAwayFromEnd(): Promise<void> {
  const node = scrollNode();
  setLegendListScrollContainerScrollHeightOverride(
    Math.max(node.scrollHeight, LEGEND_LIST_HEADER_PX + 40 * 90 + 40),
  );
  fireEvent.wheel(node, { deltaY: -80 });
  await fireScrollTopAndFlush(0);
  await waitFor(() => {
    expect(scrollNode().dataset.scrollMode).toBe("free-scrolling");
  });
}

function queryScrollToEndPill(): HTMLButtonElement | null {
  return screen.queryByRole<HTMLButtonElement>("button", {
    name: "Scroll to end",
  });
}

/** True only when the pill is showing its "New Reply" label - production's
 * `resolveScrollToEndPillState` renders that label text only in the
 * `"new-reply"` state (chat-scroll-to-end-pill-state.ts), never in
 * `"plain"`/`"streaming"`. */
function isNewReplyPillVisible(): boolean {
  const pill = queryScrollToEndPill();
  if (pill === null) return false;
  return /new reply/i.test(pill.textContent);
}

describe("ChatMessages fallback announcer (real store, real observer, real identity formatters)", () => {
  beforeEach(() => {
    installLegendListViewportMetrics();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    useSettingsStore.setState({
      chatTurnMinimapSide: "right",
      quoteReplyEnabled: false,
    });
    runManualRungState.handler = () => Promise.resolve({ outcome: "applied" });
    runManualRungState.callCount.current = 0;
    disposeAllChatSessions();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    // The registry is a process-wide singleton (`getChatSessionRegistry`) -
    // release this test's warm session so the NEXT test's `registerHarness`
    // factory actually runs instead of silently returning a stale handle.
    disposeAllChatSessions();
  });

  it("speaks hold -> choosing -> switching -> a host notice -> a return offer, once per semantic transition, before any scroll or focus theft", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const harness = createHarness();
    registerHarness(harness);

    const focusProbe = document.createElement("textarea");
    focusProbe.setAttribute("data-testid", "fake-composer");
    document.body.appendChild(focusProbe);
    focusProbe.focus();
    expect(document.activeElement).toBe(focusProbe);

    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    const chat = renderChat(baselineEpoch, undefined);
    expect(liveRegionText()).toBe("");

    // HOLD, with an impendingAction TARGET but a still-null committed
    // targetTuple - the destination must still resolve, naming the
    // provider/resolved model/effort/account via `impendingAction.target`.
    const holdPlan = impendingAction({
      planId: "plan-1",
      rung: "tier",
      target: TARGET_TUPLE,
      resumesAt: null,
      pending: null,
    });
    setTurnState(
      harness,
      pendingFallback({
        state: "hold",
        traversalId: "trav-1",
        revision: 1,
        deadline: now + 12_000,
        targetTuple: null,
        impendingAction: holdPlan,
        queuedItemsMoving: 2,
      }),
      undefined,
      undefined,
    );
    await flushAnnouncer();
    const holdText = liveRegionText();
    expect(holdText).toContain(`The chat will switch to ${TARGET_IDENTITY}.`);
    expect(holdText).toContain(FRESH_SESSION_HELPER);
    expect(holdText).toContain(
      "2 queued messages will run on the new settings too.",
    );
    expect(holdText).toContain("You have 12 seconds to cancel.");
    // No focus theft: the announcer is a live region, not a focus target.
    expect(document.activeElement).toBe(focusProbe);

    // CHOOSING.
    setTurnState(
      harness,
      pendingFallback({
        state: "choosing",
        traversalId: "trav-1",
        revision: 2,
        deadline: null,
        targetTuple: null,
        impendingAction: holdPlan,
        queuedItemsMoving: 2,
      }),
      undefined,
      undefined,
    );
    await flushAnnouncer();
    expect(liveRegionText()).toContain("Fallback countdown paused.");

    // SWITCHING - now committed via `targetTuple`.
    setTurnState(
      harness,
      pendingFallback({
        state: "switching",
        traversalId: "trav-1",
        revision: 3,
        deadline: null,
        targetTuple: TARGET_TUPLE,
        impendingAction: null,
        queuedItemsMoving: 2,
      }),
      undefined,
      undefined,
    );
    await flushAnnouncer();
    expect(liveRegionText()).toBe(`Switching this chat to ${TARGET_IDENTITY}.`);

    // Traversal settles; a host-authored `fallback_applied` notice lands on
    // a message that is NEW to `props.messages` (this fixture never seeds
    // an assistant row earlier) - a live-path row appearing for the first
    // time already carrying `completedAt` is ALSO a legitimate generic
    // completion (chat-announcements.ts ~272-293: on the live,
    // non-hydrating path, `prior === undefined` still yields `kind =
    // candidate` - "a row arriving on the LIVE path... will get it
    // anyway"), so this exact commit can legitimately fire BOTH the
    // fallback notice AND "...finished responding.". Trace every actual
    // committed span rather than reading only the final text, so the two
    // are not conflated into a false failure.
    setTurnState(harness, undefined, undefined, undefined);
    const noticeMessage = assistantNoticeMessage({
      id: "notice-applied",
      segment: providerNoticeSegment({
        id: "seg-applied",
        noticeKind: "fallback_applied",
        title: "Switched providers",
        details: [{ label: "To", value: TARGET_IDENTITY }],
      }),
    });
    const noticeCommits = await captureLiveRegionCommits(() => {
      chat.rerenderWith({ messages: [noticeMessage] });
    });
    // Falsification: a notice that never actually commits (dropped by the
    // observer, superseded before it ever renders) would leave this at 0 -
    // the real assertion this test exists to make, independent of whatever
    // ELSE also committed in the same trace (a real generic completion is
    // allowed, not required to be absent). Counting literal occurrences
    // (not span presence) also catches the real queue joining several
    // pending entries into ONE span and duplicating the sentence inside it,
    // either within a single batch or across separate commits.
    expect(
      countSentenceOccurrences(
        noticeCommits,
        `Switched providers. To: ${TARGET_IDENTITY}`,
      ),
    ).toBe(1);

    // A RETURN offer - independent channel, names the preferred identity.
    setTurnState(
      harness,
      undefined,
      pendingReturn({
        traversalId: "trav-2",
        revision: 1,
        queuedItemsMoving: 1,
      }),
      undefined,
    );
    await flushAnnouncer();
    const returnText = liveRegionText();
    expect(returnText).toContain(PREFERRED_IDENTITY);
    expect(returnText).toContain("is available again");
    expect(returnText).toContain("and moves 1 queued message back");

    // Falsification: drop the `impendingAction.target` fallback in F5's
    // `pendingFallbackDestinationTuple` identity helper and the HOLD
    // assertion above goes red - a hold with `targetTuple: null` would then
    // have no destination to name at all.
    expect(document.activeElement).toBe(focusProbe);
    document.body.removeChild(focusProbe);
  });

  it("hold -> choosing -> switching dispatched synchronously in one commit all remain in the announced batch, IN ORDER", async () => {
    const harness = createHarness();
    registerHarness(harness);
    const now = Date.now();
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    renderChat(baselineEpoch, undefined);

    const plan = impendingAction({
      planId: "plan-batch",
      rung: "tier",
      target: TARGET_TUPLE,
      resumesAt: null,
      pending: null,
    });
    // All three transitions dispatched inside ONE `act`, before React (and
    // the announcer's own microtask queue) gets a chance to commit between
    // them - the shape a real host burst can produce.
    await act(async () => {
      setTurnState(
        harness,
        pendingFallback({
          state: "hold",
          traversalId: "trav-batch",
          revision: 1,
          deadline: now + 12_000,
          targetTuple: null,
          impendingAction: plan,
          queuedItemsMoving: 0,
        }),
        undefined,
        undefined,
      );
      setTurnState(
        harness,
        pendingFallback({
          state: "choosing",
          traversalId: "trav-batch",
          revision: 2,
          deadline: null,
          targetTuple: null,
          impendingAction: plan,
          queuedItemsMoving: 0,
        }),
        undefined,
        undefined,
      );
      setTurnState(
        harness,
        pendingFallback({
          state: "switching",
          traversalId: "trav-batch",
          revision: 3,
          deadline: null,
          targetTuple: TARGET_TUPLE,
          impendingAction: null,
          queuedItemsMoving: 0,
        }),
        undefined,
        undefined,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const batched = liveRegionText();
    // ALL THREE sentences must survive the batch, not just the LAST one -
    // `useChatAnnouncementQueue` concatenates every pending entry
    // (`pending.current.map(e => e.text).join(' ')`), it does not
    // replace-latest.
    const holdIndex = batched.indexOf(
      `The chat will switch to ${TARGET_IDENTITY}.`,
    );
    const choosingIndex = batched.indexOf("Fallback countdown paused.");
    const switchingIndex = batched.indexOf(
      `Switching this chat to ${TARGET_IDENTITY}.`,
    );
    expect(holdIndex).toBeGreaterThanOrEqual(0);
    expect(choosingIndex).toBeGreaterThanOrEqual(0);
    expect(switchingIndex).toBeGreaterThanOrEqual(0);
    // Falsification: replace-latest the announcement queue instead of
    // appending every entry across a batch - `holdIndex`/`choosingIndex`
    // would read -1, and only the switching text would survive.
    expect(holdIndex).toBeLessThan(choosingIndex);
    expect(choosingIndex).toBeLessThan(switchingIndex);
  });

  it("a real turn completion and a real fallback transition dispatched in ONE act each commit their own announcement once - a commit trace, not a permanent history in the region", async () => {
    // The real completion deriver (`useChatAnnouncements`, chat-messages.tsx
    // ~2933) reads a transcript-position transition on the trailing
    // assistant row - `completedAt` flipping from null while `stopped` stays
    // null - exactly the precedent at
    // `chat-messages.test.tsx:1476` ("announces when the trailing assistant
    // gains a completedAt and was not stopped"), adapted here rather than a
    // hand-built `completion` prop (there isn't one on `ChatMessagesProps`;
    // `ChatMessages` derives it internally).
    //
    // `useChatAnnouncementQueue`'s layout effect (chat-announcements.ts
    // ~709-716) purges a consumed entry from `pending` the instant its own
    // commit lands, and the region renders only the LATEST committed
    // announcement (one `<span key={announcement.sequence}>`, replaced, not
    // appended) - so once the completion has actually committed, a later
    // fallback commit legitimately REPLACES the region with its own text.
    // This test does not assert both texts are simultaneously present; it
    // traces every actual DOM commit to the region and asserts each exact
    // sentence appeared exactly once somewhere in that trace.
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    const userMsg = makeMessage(0, "user");
    const assistantStreaming: ChatMessageModel = {
      ...makeMessage(1, "assistant"),
      completedAt: null,
      stopped: null,
      runState: "running",
    };
    const chat = renderChat(baselineEpoch, undefined);
    chat.rerenderWith({ messages: [userMsg, assistantStreaming] });
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");

    // Both transitions dispatched inside ONE `act`, with NO intermediate
    // flush between them - whatever React actually does with these two
    // independent triggers (one React-state rerender, one zustand store
    // publish) is what the trace below observes, rather than an assumption
    // about commit count.
    const commits = await captureLiveRegionCommits(() => {
      chat.rerenderWith({
        messages: [
          userMsg,
          {
            ...assistantStreaming,
            completedAt: 1_700_000_000_000,
            stopped: null,
            runState: null,
          },
        ],
      });
      setTurnState(
        harness,
        pendingFallback({
          state: "switching",
          traversalId: "trav-combo",
          revision: 1,
          deadline: null,
          targetTuple: TARGET_TUPLE,
          impendingAction: null,
          queuedItemsMoving: 0,
        }),
        undefined,
        undefined,
      );
    });

    // `commits` holds one entry per actually-INSERTED span node's own
    // text (see `captureLiveRegionCommits`) - not a point-in-time region
    // snapshot, so no dedup is applied here: two distinct inserted spans
    // that happen to carry the identical sentence are a genuine duplicate
    // announcement, and collapsing them would hide exactly the failure
    // this trace exists to catch. Counting LITERAL occurrences (not span
    // presence via `includes`) is what makes that true: the real queue
    // joins every still-pending entry into ONE span
    // (`pending.current.map(...).join(" ")`, chat-announcements.ts ~704),
    // so a single span containing the sentence TWICE - a duplicate
    // WITHIN one batch, not just across separate commits - must also
    // redden this, which a presence filter followed by `.length === 1`
    // cannot catch.
    //
    // Falsification: an announcer that drops a text instead of committing
    // it at all (e.g. the second `enqueue` clobbering the first's
    // still-pending entry before its own microtask ever renders) would
    // leave the corresponding count at 0 - a real positive proof a bare
    // "New Reply" pill absence check never was. Each sentence must commit
    // EXACTLY once: this is a COMMIT trace, not a permanent-history claim -
    // it does not require both sentences to appear in the SAME committed
    // text, only that each committed exactly once across the sequence,
    // however many commits React actually used.
    expect(
      countSentenceOccurrences(
        commits,
        "Fallback integration chat finished responding.",
      ),
    ).toBe(1);
    expect(
      countSentenceOccurrences(
        commits,
        `Switching this chat to ${TARGET_IDENTITY}.`,
      ),
    ).toBe(1);
    // The region itself never accumulates old announcements once a newer
    // one has committed (production is not changed to retain
    // already-spoken history) - the FINAL state is whichever committed
    // last.
    const finalText = liveRegionText();
    expect(
      finalText.includes("Fallback integration chat finished responding.") ||
        finalText.includes(`Switching this chat to ${TARGET_IDENTITY}.`),
    ).toBe(true);
  });

  it("off-tail (free-scrolling): a fallback-only transition never flips the 'New Reply' pill, but a REAL completedAt transition on the SAME mounted fixture does", async () => {
    // `resolveScrollToEndPillState` (chat-scroll-to-end-pill-state.ts)
    // reads `unseenCompletion` off `hasUnseenTurnCompletion`, a latch set
    // ONLY by the completion observer's layout effect (chat-messages.tsx
    // ~2939-2946: "the separate fallback observer never changes that
    // latch") while NOT `following-end`. This proves the prerequisite
    // instead of a vacuous following-end absence check: the pill visibly
    // stays "streaming"/hidden through a real fallback transition, then
    // visibly flips to "New Reply" on a real completion, on the exact same
    // mounted component and off-tail scroll state.
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    const userMsg = makeMessage(0, "user");
    const assistantStreaming: ChatMessageModel = {
      ...makeMessage(1, "assistant"),
      completedAt: null,
      stopped: null,
      runState: "running",
    };
    const chat = renderChat(baselineEpoch, undefined);
    chat.rerenderWith({ messages: [userMsg, assistantStreaming] });
    await flushAnnouncer();

    // Leave the strict tail so the pill's containing surface is visible at
    // all (`resolveScrollToEndPillState`'s `visible` gate is required
    // before either assertion below is even reachable).
    await enterFreeScrollingAwayFromEnd();
    // Streaming (not yet completed), off-tail: the pill shows its
    // "streaming" label, never "New Reply".
    expect(isNewReplyPillVisible()).toBe(false);

    // A real fallback-only transition, off-tail: real speech, but this
    // path never touches `hasUnseenTurnCompletion`.
    setTurnState(
      harness,
      pendingFallback({
        state: "switching",
        traversalId: "trav-off-tail",
        revision: 1,
        deadline: null,
        targetTuple: TARGET_TUPLE,
        impendingAction: null,
        queuedItemsMoving: 0,
      }),
      undefined,
      undefined,
    );
    await flushAnnouncer();
    expect(liveRegionText()).toContain(
      `Switching this chat to ${TARGET_IDENTITY}.`,
    );
    // Falsification: a pill wrongly wired to ANY announcement (rather than
    // specifically the completion observer's latch) would flip visible
    // here, on fallback speech alone with no completion at all.
    expect(isNewReplyPillVisible()).toBe(false);

    // Now a REAL completedAt transition, on the SAME mounted fixture,
    // still off-tail (still free-scrolling, not following-end) - the
    // positive control this whole test exists to prove: a genuine
    // completion DOES flip the pill, so the negative checks above are not
    // vacuous (an always-hidden pill would pass them trivially).
    chat.rerenderWith({
      messages: [
        userMsg,
        {
          ...assistantStreaming,
          completedAt: 1_700_000_000_000,
          stopped: null,
          runState: null,
        },
      ],
    });
    await flushAnnouncer();
    expect(scrollNode().dataset.scrollMode).not.toBe("following-end"); // still off-tail
    expect(isNewReplyPillVisible()).toBe(true);
  });

  it("advancing time and unrelated parent re-renders do not rewrite the live-region node/text (revision-only bumps stay silent)", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    renderChat(baselineEpoch, undefined);

    setTurnState(
      harness,
      pendingFallback({
        state: "waiting",
        traversalId: "trav-quiet",
        revision: 1,
        deadline: Date.now() + 60_000,
        targetTuple: null,
        impendingAction: null,
        queuedItemsMoving: 0,
      }),
      undefined,
      undefined,
    );
    await flushAnnouncer();
    const spoken = liveRegionText();
    const spokenNode = liveRegionSpan();
    expect(spoken).toContain(`Waiting for ${FAILED_IDENTITY}.`);

    // Time advances (the card's own countdown, not a semantic change) - no
    // store update accompanies it.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    await flushAnnouncer();
    // Falsification: key the observer/announcer's semantic dedupe on
    // wall-clock `now` instead of the traversal's semanticKey - this node
    // identity and text would then change on every tick.
    expect(liveRegionSpan()).toBe(spokenNode);
    expect(liveRegionText()).toBe(spoken);

    // A revision-only bump (e.g. siblingSwitching moved), same state/plan.
    setTurnState(
      harness,
      pendingFallback({
        state: "waiting",
        traversalId: "trav-quiet",
        revision: 2,
        deadline: Date.now() + 55_000,
        targetTuple: null,
        impendingAction: null,
        queuedItemsMoving: 0,
      }),
      undefined,
      undefined,
    );
    await flushAnnouncer();
    expect(liveRegionSpan()).toBe(spokenNode);
  });

  // The mounted initial-connect test below stacks TWO independent baseline
  // protections over one live-region assertion. The two controls here
  // isolate each one on its own, with the other never in play at all:
  it("traversal absorption (pure observer, no React queue): a fresh observer's FIRST traversal observation is absorbed as baseline, and only a genuinely NEW semantic transition afterward speaks", () => {
    const observer = createFallbackAnnouncementObserver();
    const base: FallbackAnnouncementsInput = {
      ready: true,
      baselineEpoch: 1,
      hydrationSequence: 0,
      coldRewrittenMessageIds: new Set(),
      residentMessageIds: new Set(),
      traversal: {
        traversalId: "trav-absorb",
        revision: 1,
        semanticKey: "hold",
        text: "hold text",
      },
      returnOffer: null,
      liveOutcome: null,
      notices: [],
      manualOutcome: null,
    };
    // First observation: absorbed as baseline. There is no mounted React
    // queue here at all, so nothing but this observer's own guard could
    // hide a spurious enqueue.
    expect(observer.observe(base)).toEqual([]);
    // Falsification: remove ONLY `absorb ||` from `observeTraversal`'s
    // `if (seen || absorb || prior?.semanticKey === next.semanticKey)
    // return;` (chat-announcements.ts ~623) - `seen` is false (first
    // observation of this key) and `prior` is `undefined`, so nothing
    // else would stop this from being pushed, and this assertion goes
    // red.

    const switching: FallbackTraversalAnnouncement = {
      traversalId: "trav-absorb",
      revision: 2,
      semanticKey: "switching",
      text: "switching text",
    };
    const second = observer.observe({ ...base, traversal: switching });
    // Positive control: the observer is not permanently silent - a
    // genuinely new semantic transition (higher revision AND a different
    // semanticKey) on the SAME traversal afterward still speaks exactly
    // once, with its own text.
    expect(second).toHaveLength(1);
    expect(second[0]?.text).toBe("switching text");
  });

  it("parent rebase reset (hostless ChatMessages, no fallback child): a real completion the announcer queue already holds is cleared on a baseline-only rerender by ChatLiveAnnouncements's OWN reset(), with no fallback observer involved at all", async () => {
    // No harness, no registry lease - `hostId: null` disables
    // `ChatFallbackAnnouncementSource` entirely (`handle !== null &&
    // props.hostId !== null`, chat-messages.tsx ~1235), and
    // `useExistingChatSessionHandle` returns `null` directly for a `null`
    // hostId (chat-session-registry.ts ~302: `hostId === null ? null :
    // registry.peek(...)`) rather than falling back to another key.
    expect(getChatSessionRegistry().peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();

    const chat = renderChat(0, undefined);
    chat.rerenderWith({ hostId: null });
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");

    // A real streaming-to-completed transition, the SAME technique used
    // elsewhere in this file - `props.completion` is derived purely from
    // `useChatAnnouncements({messages, baselineEpoch, ...})` in the public
    // `ChatMessages` and has no dependency on `handle`/`hostId` at all.
    const userMsg = makeMessage(0, "user");
    const assistantStreaming: ChatMessageModel = {
      ...makeMessage(1, "assistant"),
      completedAt: null,
      stopped: null,
      runState: "running",
    };
    chat.rerenderWith({ messages: [userMsg, assistantStreaming] });
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");
    chat.rerenderWith({
      messages: [
        userMsg,
        {
          ...assistantStreaming,
          completedAt: 1_700_000_000_000,
          stopped: null,
          runState: null,
        },
      ],
    });
    await flushAnnouncer();
    // Positive control: this queue genuinely holds a completion before the
    // rebase below - proving the coming silence is REBASE clearing it, not
    // an announcement that never existed.
    expect(liveRegionText()).toBe(
      "Fallback integration chat finished responding.",
    );
    expect(liveRegionSpan()).not.toBeNull();

    // ONE field changes: `baselineEpoch` only - same mounted root, same
    // completed rows, same `visible: true`, `hostId` still `null`.
    chat.rerenderWith({ baselineEpoch: 1 });
    await flushAnnouncer();
    // Falsification: delete ONLY `reset()` from `ChatLiveAnnouncements`'s
    // `observeCompletion`'s `if (rebase)` branch (chat-messages.tsx
    // ~1211-1216) - `useChatAnnouncements` absorbs the new baseline
    // internally without clearing its OWN already-emitted completion
    // value, so with no fallback child or subscription mounted at all to
    // reset the queue independently, the final span would stay the SAME
    // nonnull node with the SAME text instead of clearing.
    expect(liveRegionText()).toBe("");
    expect(liveRegionSpan()).toBeNull();
  });

  it("absorbs the initial connect, a reconnect (new epoch), and hide/show silently - no history announced", async () => {
    const harness = createHarness();
    registerHarness(harness);

    // Initial connect ALREADY carries a live hold - the mount baseline.
    const initialHold = pendingFallback({
      state: "hold",
      traversalId: "trav-initial",
      revision: 1,
      deadline: Date.now() + 10_000,
      targetTuple: null,
      impendingAction: impendingAction({
        planId: "plan-initial",
        rung: "tier",
        target: TARGET_TUPLE,
        resumesAt: null,
        pending: null,
      }),
      queuedItemsMoving: 0,
    });
    const baselineEpoch = bootstrap(harness, initialHold, undefined, undefined);
    const chat = renderChat(baselineEpoch, undefined);
    await flushAnnouncer();
    // This mounted-component assertion has TWO independent baseline
    // protections stacked over it - neither is isolated HERE, by design;
    // each has its own single-guard falsifier in the two tests directly
    // above ("traversal absorption" and "parent rebase reset"):
    //  1. `createFallbackAnnouncementObserver`'s `absorb` guard
    //     (chat-announcements.ts ~589/~623) would, on its own, already
    //     keep a fresh observer's first traversal observation silent -
    //     proven with no React queue at all by "traversal absorption"
    //     above.
    //  2. `ChatLiveAnnouncements`'s OWN mount/rebase protection
    //     (chat-messages.tsx ~1211-1216, `observeCompletion`'s `rebase`
    //     branch calling `reset()` on the shared announcement queue) would,
    //     on its own, already clear a real completion the queue held
    //     before a baseline-only rerender - proven with no fallback
    //     observer mounted at all by "parent rebase reset" above.
    // Because they are independently sufficient here, no single-guard
    // mutation against THIS mounted test can attribute the silence to
    // either one specifically; that attribution is what the two tests
    // above are for.
    expect(liveRegionText()).toBe("");

    // Hide, then show again: same epoch, no announcement either way.
    chat.rerenderWith({ visible: false });
    await flushAnnouncer();
    chat.rerenderWith({ visible: true });
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");

    // Reconnect: a genuinely new epoch, still carrying the SAME hold - still
    // absorbed as a fresh baseline, never spoken as a transition.
    //
    // The store bumps `connectionEpoch` only on a "reconnecting" or "closed"
    // transition (chat-session-store.ts ~5680), NOT "connecting" - using
    // "connecting" here would leave `reconnectEpoch` identical to
    // `baselineEpoch` and this whole scenario would silently test nothing.
    harness.callbacks().onConnectionStatus("reconnecting", null);
    const reconnectEpoch = bootstrap(
      harness,
      initialHold,
      undefined,
      undefined,
    );
    expect(reconnectEpoch).not.toBe(baselineEpoch);

    // OPEN-BEFORE-NEW-BASELINE barrier: `bootstrap` has already driven the
    // store to `connectionStatus === "open"` and `snapshotLoaded === true` on
    // the NEW `transcriptBaselineEpoch`, but the component's `baselineEpoch`
    // PROP is still the stale value - `chat.rerenderWith` hasn't run yet.
    // `ready` requires `props.baselineEpoch === state.transcriptBaselineEpoch`
    // (chat-messages.tsx's `ChatFallbackAnnouncementSource`), so this frame
    // must stay unready and silent even though "open"/"snapshotLoaded" alone
    // would say otherwise. Falsification: drop the baselineEpoch-agreement
    // conjunct from `ready` - this call would announce prematurely.
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");

    chat.rerenderWith({ baselineEpoch: reconnectEpoch });
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");

    // A genuinely NEW transition after the reconnect still speaks.
    setTurnState(
      harness,
      pendingFallback({
        state: "choosing",
        traversalId: "trav-initial",
        revision: 2,
        deadline: null,
        targetTuple: null,
        impendingAction: impendingAction({
          planId: "plan-initial",
          rung: "tier",
          target: TARGET_TUPLE,
          resumesAt: null,
          pending: null,
        }),
        queuedItemsMoving: 0,
      }),
      undefined,
      undefined,
    );
    await flushAnnouncer();
    expect(liveRegionText()).toContain("Fallback countdown paused.");
  });

  it("D71: a confirmed manual switch speaks AFTER the initiating trigger unmounts, via the mutation's real host-level onSuccess (not a per-call callback that dies with the component); the same record replayed is silent, a later sequence with identical words speaks again as a genuinely new DOM node", async () => {
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    // The trigger and the announcer must observe the SAME mutation
    // lifecycle, so they share one QueryClient - production wires both
    // under one app-wide provider the same way.
    const chat = renderChat(baselineEpoch, undefined);
    const queryClient = chat.queryClient;

    // The RPC response stays UNRESOLVED until this test says so - this is
    // what actually proves D71: a synchronous mock's callback would already
    // have fired before `unmount()` is ever called, proving nothing about
    // surviving it.
    const firstDeferred = makeDeferred<RunManualRungResponse>();
    runManualRungState.handler = () => firstDeferred.promise;

    const trigger = renderTrigger(
      { userMessageId: "user-msg-1", turnId: "turn-1", target: TARGET_TUPLE },
      queryClient,
    );
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm switch" }));
      return Promise.resolve();
    });
    await flushAnnouncer();
    // Still in flight: no record, no announcement yet.
    expect(liveRegionText()).toBe("");
    expect(
      harness.handle.store.getState().confirmedManualFallbackAction,
    ).toBeNull();

    // The popover/trigger is gone NOW, before the host has answered - the
    // sequence the publisher's own doc comment describes as the normal case
    // (the surface that sent the switch is usually gone by the time the
    // host answers).
    trigger.unmount();

    // NOW the host answers. The mutation's host-level `onSuccess` (owned by
    // the QueryClient's mutation cache, not by the unmounted component) is
    // what must still fire.
    await act(async () => {
      firstDeferred.resolve({ outcome: "applied" });
      await firstDeferred.promise;
    });
    await flushAnnouncer();
    expect(liveRegionText()).toBe(
      `Switched this chat to ${MANUAL_SWITCH_TARGET_IDENTITY}.`,
    );
    // Falsification: route this through a per-call `mutate(vars, { onSuccess })`
    // handler instead of the hook-level `onSuccess` - TanStack skips per-call
    // handlers once the observer (the unmounted component) has no listeners,
    // so this assertion goes red instead of green.
    expect(
      harness.handle.store.getState().confirmedManualFallbackAction?.rung,
    ).toBe("switch");
    const firstSpan = liveRegionSpan();

    // The SAME record (identical sequence, via the store's own dedupe on the
    // manual-outcome key) replayed by another `onTurnStateChanged` frame
    // carrying an unrelated field change must not speak again.
    const beforeReplay = liveRegionText();
    setTurnState(harness, undefined, undefined, undefined);
    await flushAnnouncer();
    expect(liveRegionText()).toBe(beforeReplay);
    expect(liveRegionSpan()).toBe(firstSpan); // no new node either

    // A SECOND confirmed switch (new sequence, textually identical words)
    // speaks again - dedupe is by record identity, not by text.
    const secondDeferred = makeDeferred<RunManualRungResponse>();
    runManualRungState.handler = () => secondDeferred.promise;
    const secondTrigger = renderTrigger(
      { userMessageId: "user-msg-2", turnId: "turn-2", target: TARGET_TUPLE },
      queryClient,
    );
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm switch" }));
      return Promise.resolve();
    });
    secondTrigger.unmount();
    await act(async () => {
      secondDeferred.resolve({ outcome: "applied" });
      await secondDeferred.promise;
    });
    await flushAnnouncer();
    // Falsification: dedupe the manual outcome by TEXT instead of by its
    // (host, epic, chat, userMessageId, turnId, sequence) key - this second,
    // textually-identical switch would stay silent and reuse the FIRST
    // node, and the queue's `key={announcement.sequence}` would never
    // remount the `<span>`, so this identity check is what a call-count
    // assertion alone cannot catch.
    expect(liveRegionText()).toBe(
      `Switched this chat to ${MANUAL_SWITCH_TARGET_IDENTITY}.`,
    );
    expect(liveRegionSpan()).not.toBe(firstSpan);
    expect(runManualRungState.callCount.current).toBeGreaterThanOrEqual(2);
  });

  it("a lower, previously-unseen manual sequence replayed after a higher one stays silent (the UI adapter's own sequence high-water mark)", async () => {
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    renderChat(baselineEpoch, undefined);

    // Advance the store's sequence past 1 with an intermediate record so a
    // LOWER, never-before-seen sequence number can exist to replay.
    harness.handle.store.getState().publishConfirmedManualFallbackAction({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "retry",
      userMessageId: "user-msg-seq-1",
      turnId: "turn-seq-1",
      target: null,
    }); // sequence 1, not a switch - never spoken
    harness.handle.store.getState().publishConfirmedManualFallbackAction({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "switch",
      userMessageId: "user-msg-seq-3",
      turnId: "turn-seq-3",
      target: TARGET_TUPLE,
    }); // sequence 2, a real switch - the high-water mark
    await flushAnnouncer();
    expect(liveRegionText()).toBe(
      `Switched this chat to ${MANUAL_SWITCH_TARGET_IDENTITY}.`,
    );
    const spokenNode = liveRegionSpan();
    expect(spokenNode).not.toBeNull();

    // A record bearing a LOWER sequence than the high-water mark, and never
    // seen before by this observer, arrives (an out-of-order replay). It
    // must stay silent even though its key is technically new.
    //
    // `publishConfirmedManualFallbackAction` always stamps
    // `previous.sequence + 1`, so this exact shape is UNREACHABLE through
    // that public action - which is precisely why the UI adapter's own
    // high-water guard exists (surviving a store/record identity change
    // that isn't itself sequence-monotonic). Writing `store.setState`
    // directly is the only way to construct the case that guard defends;
    // every other test in this file drives state exclusively through real
    // stream callbacks or the real publisher action.
    harness.handle.store.setState(() => ({
      confirmedManualFallbackAction: {
        hostId: HOST_ID,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        rung: "switch",
        userMessageId: "user-msg-seq-stale",
        turnId: "turn-seq-stale",
        target: TARGET_TUPLE,
        sequence: 1,
      },
    }));
    await flushAnnouncer();
    // Same DOM-identity check already used above for a repeated VALID
    // success (liveRegionSpan stays the SAME node across a no-op replay) -
    // here with the opposite expected result's proof still required: equal
    // TEXT alone does not catch a broken guard that re-announces this stale
    // record with identical wording, since a NEW span carrying the SAME
    // text would still pass a text-only assertion.
    expect(liveRegionText()).toBe(
      `Switched this chat to ${MANUAL_SWITCH_TARGET_IDENTITY}.`,
    );
    // Falsification: drop `manual.sequence > lastSequence` in
    // `observeManualFallbackAction` (chat-messages.tsx ~1034, called from
    // `ChatFallbackAnnouncementSource`'s own high-water guard, distinct
    // from the observer's key-based dedupe) - this stale, unseen-key
    // record would insert a NEW span with the identical text, and only
    // this node-identity check (not the text check above) would catch it.
    expect(liveRegionSpan()).toBe(spokenNode);
  });

  /** A syntactically-valid confirmed-switch record, one field overridable per axis. */
  function scopedSwitch(
    overrides: Partial<{
      readonly hostId: string;
      readonly epicId: string;
      readonly chatId: string;
    }>,
  ): Omit<ConfirmedManualFallbackAction, "sequence"> {
    const base: Omit<ConfirmedManualFallbackAction, "sequence"> = {
      hostId: HOST_ID,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "switch",
      userMessageId: "user-msg-scoped",
      turnId: "turn-scoped",
      target: TARGET_TUPLE,
    };
    return { ...base, ...overrides };
  }

  it("a switch confirmed for the WRONG HOST alone never says 'Switched'", async () => {
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    renderChat(baselineEpoch, undefined);
    harness.handle.store
      .getState()
      .publishConfirmedManualFallbackAction(
        scopedSwitch({ hostId: "some-other-host" }),
      );
    await flushAnnouncer();
    // Falsification: drop `manual.hostId !== scope.hostId` alone from
    // `observeManualFallbackAction`'s rejection guard (chat-messages.tsx
    // ~1026-1032) - this record would speak despite naming a different
    // host.
    expect(liveRegionText()).not.toContain("Switched");
  });

  it("a switch confirmed for the WRONG EPIC alone (same host/chat) never says 'Switched'", async () => {
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    renderChat(baselineEpoch, undefined);
    harness.handle.store
      .getState()
      .publishConfirmedManualFallbackAction(
        scopedSwitch({ epicId: "some-other-epic" }),
      );
    await flushAnnouncer();
    expect(liveRegionText()).not.toContain("Switched");
  });

  it("a switch confirmed for the WRONG CHAT alone (same host/epic) never says 'Switched'", async () => {
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    renderChat(baselineEpoch, undefined);
    harness.handle.store
      .getState()
      .publishConfirmedManualFallbackAction(
        scopedSwitch({ chatId: "some-other-chat" }),
      );
    await flushAnnouncer();
    expect(liveRegionText()).not.toContain("Switched");
  });

  it("a confirmed RETRY (not a switch) is recorded but never spoken as 'Switched' - including a non-null-target RETRY, which isolates the rung guard from the separate null-target guard", async () => {
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    renderChat(baselineEpoch, undefined);
    harness.handle.store.getState().publishConfirmedManualFallbackAction({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "retry",
      userMessageId: "user-msg-retry",
      turnId: "turn-retry",
      target: null,
    });
    await flushAnnouncer();
    expect(
      harness.handle.store.getState().confirmedManualFallbackAction?.rung,
    ).toBe("retry"); // the store DOES record it
    expect(liveRegionText()).not.toContain("Switched"); // the announcer does not speak it

    // A SECOND record, same rung, this time with a non-null `target` - a
    // boundary input `ConfirmedManualFallbackAction`'s type allows, not a
    // claim that the real unary publisher ever sends a target alongside a
    // non-switch rung. `observeManualFallbackAction`'s guard
    // (chat-messages.tsx ~1036) is `!newManual || manual.rung !== "switch"
    // || manual.target === null` - with `target: null` above, the rung
    // and target disjuncts are indistinguishable; only a fresh,
    // non-null-target record isolates `manual.rung !== "switch"` as the
    // one still blocking speech.
    harness.handle.store.getState().publishConfirmedManualFallbackAction({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "retry",
      userMessageId: "user-msg-retry-2",
      turnId: "turn-retry-2",
      target: TARGET_TUPLE,
    });
    await flushAnnouncer();
    const secondRecord =
      harness.handle.store.getState().confirmedManualFallbackAction;
    expect(secondRecord?.rung).toBe("retry");
    expect(secondRecord?.target).toBe(TARGET_TUPLE);
    // Falsification: drop `manual.rung !== "switch"` from the guard - with
    // a fresh sequence and a non-null target, this second record has
    // nothing else left to block it, and this speaks "Switched" instead.
    expect(liveRegionText()).not.toContain("Switched");
  });

  it("a confirmed WAIT_ONCE (not a switch) is recorded but never spoken as 'Switched' - including a non-null-target WAIT_ONCE, which isolates the rung guard from the separate null-target guard", async () => {
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    renderChat(baselineEpoch, undefined);
    harness.handle.store.getState().publishConfirmedManualFallbackAction({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "wait_once",
      userMessageId: "user-msg-wait",
      turnId: "turn-wait",
      target: null,
    });
    await flushAnnouncer();
    expect(
      harness.handle.store.getState().confirmedManualFallbackAction?.rung,
    ).toBe("wait_once");
    expect(liveRegionText()).not.toContain("Switched");

    // A SECOND record, same rung, this time with a non-null `target` - a
    // boundary input `ConfirmedManualFallbackAction`'s type allows, not a
    // claim that the real unary publisher ever sends a target alongside a
    // non-switch rung. `observeManualFallbackAction`'s guard
    // (chat-messages.tsx ~1036) is `!newManual || manual.rung !== "switch"
    // || manual.target === null` - with `target: null` above, the rung
    // and target disjuncts are indistinguishable; only a fresh,
    // non-null-target record isolates `manual.rung !== "switch"` as the
    // one still blocking speech.
    harness.handle.store.getState().publishConfirmedManualFallbackAction({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      rung: "wait_once",
      userMessageId: "user-msg-wait-2",
      turnId: "turn-wait-2",
      target: TARGET_TUPLE,
    });
    await flushAnnouncer();
    const secondRecord =
      harness.handle.store.getState().confirmedManualFallbackAction;
    expect(secondRecord?.rung).toBe("wait_once");
    expect(secondRecord?.target).toBe(TARGET_TUPLE);
    // Falsification: drop `manual.rung !== "switch"` from the guard - with
    // a fresh sequence and a non-null target, this second record has
    // nothing else left to block it, and this speaks "Switched" instead.
    expect(liveRegionText()).not.toContain("Switched");
  });

  it("a manual switch RPC still PENDING (unresolved) is neither recorded nor spoken - only a settled outcome writes the publisher record", async () => {
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    const chat = renderChat(baselineEpoch, undefined);
    const pending = makeDeferred<RunManualRungResponse>();
    runManualRungState.handler = () => pending.promise;
    const trigger = renderTrigger(
      {
        userMessageId: "user-msg-pending",
        turnId: "turn-pending",
        target: TARGET_TUPLE,
      },
      chat.queryClient,
    );
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm switch" }));
      return Promise.resolve();
    });
    await flushAnnouncer();
    expect(
      harness.handle.store.getState().confirmedManualFallbackAction,
    ).toBeNull();
    expect(liveRegionText()).toBe("");
    trigger.unmount();
    // Never resolved - deliberately left pending for the rest of the test.
  });

  it("a manual switch RPC that resolves REFUSED (no_active_traversal, not 'applied') is never recorded and never spoken", async () => {
    const harness = createHarness();
    registerHarness(harness);
    const baselineEpoch = bootstrap(harness, undefined, undefined, undefined);
    const chat = renderChat(baselineEpoch, undefined);
    runManualRungState.handler = () =>
      Promise.resolve({ outcome: "no_active_traversal" });
    const trigger = renderTrigger(
      {
        userMessageId: "user-msg-refused",
        turnId: "turn-refused",
        target: TARGET_TUPLE,
      },
      chat.queryClient,
    );
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm switch" }));
      return Promise.resolve();
    });
    trigger.unmount();
    await flushAnnouncer();
    // Falsification: drop the `data.outcome !== "applied"` early-return in
    // `useFallbackRunManualRung`'s `onSuccess` (use-fallback-actions.ts) -
    // this refusal would be recorded and spoken as if it had applied.
    expect(
      harness.handle.store.getState().confirmedManualFallbackAction,
    ).toBeNull();
    expect(liveRegionText()).toBe("");
  });

  // D224: paired epoch-condition cases sharing ONE warm-baseline builder and
  // ONE held-outcome fixture - the only thing that differs between them is
  // whether a REAL reconnect happened WHILE `ChatMessages` was literally
  // unmounted (the real store/registry lease survives the unmount; only the
  // rendered observer goes away and comes back). A shared fixture keeps a
  // positive arm's unrelated changes from masking a dead held-snapshot path.
  //
  // Exact paired sequence, per the coordinator's R3 gate:
  //   1. Establish a real store baseline with NO outcome; the registry lease
  //      is independent of the rendered component (`registerHarness` seeds
  //      it directly).
  //   2. Literally unmount `ChatMessages` in BOTH cases, retaining that same
  //      store/lease.
  //   3. Scenario input alone differs: the advanced case sends a real
  //      reconnecting->open transition WHILE unmounted; the unchanged case
  //      sends neither.
  //   4. Remount `ChatMessages` against the CACHED empty baseline and flush.
  //      Unchanged: the fresh observer's first observation absorbs no
  //      outcome (there is none yet) and sets `wasReady = true`. Advanced:
  //      `transcriptBaselineEpoch !== connectionEpoch` keeps `ready = false`.
  //   5. ONLY NOW deliver the SAME outcome-bearing held snapshot in both
  //      cases. Unchanged emits it once (an established, ready observer
  //      seeing a genuine live frame). Advanced absorbs it (a changed
  //      `baselineEpoch` input is a rebaseline regardless of `wasReady`).
  // The windowed transcript-index epoch (`snapshot.transcriptEpoch`/
  // `range.epoch`) - separate bookkeeping from `connectionEpoch`/
  // `transcriptBaselineEpoch`; the DEFERRAL branch of
  // `applyOrDeferWindowedSnapshot` never reads or writes the latter pair at
  // all (only the FOLD does), so this value is fixed throughout and is not
  // what drives either D224 arm.
  const D224_WINDOW_EPOCH = 4;

  function establishD224Baseline(): {
    readonly harness: WindowedHarness;
    readonly epoch: number;
  } {
    const harness = createWindowedHarness();
    registerHarness(harness); // real registry lease, independent of any mount
    harness.callbacks().onConnectionStatus("open", null);
    // A truly EMPTY snapshot (`rowCount: 0`, `tail.fromOrdinal: 0`) folds
    // immediately - `isTailHydrated` reads it TRUE with nothing to cover -
    // so this establishes a genuine AUTHORITATIVE baseline (the FOLD sets
    // `transcriptBaselineEpoch = connectionEpoch`) with NOTHING already
    // warm. Delivering `deferredWindowedSnapshot`'s `rowCount: 2` shape
    // afterward, at this SAME wire epoch, then genuinely defers instead of
    // being silently retained by a span this baseline already covered
    // (`applyWindowedSnapshot` keeps a same-epoch span already hydrated).
    harness
      .callbacks()
      .onWindowedSnapshot(emptyWindowedSnapshot(D224_WINDOW_EPOCH));
    const epoch = harness.handle.store.getState().transcriptBaselineEpoch;
    return { harness, epoch };
  }

  // The SAME outcome content in both cases below - only the epoch condition
  // around its delivery differs.
  function d224HeldOutcome(): LastFallbackOutcome {
    return {
      blockId: "block-d224-held",
      assistantMessageId: "m-d224-held",
      kind: "applied",
      title: "Switched providers",
      message: null,
      details: [{ label: "To", value: TARGET_IDENTITY }],
      sequence: 1,
    };
  }
  const D224_HELD_TEXT = `Switched providers. To: ${TARGET_IDENTITY}`;

  // A genuinely different block, used only by the negative case's retained
  // "still speaks live afterward" tail.
  function d224FollowUpOutcome(): LastFallbackOutcome {
    return {
      blockId: "block-d224-followup",
      assistantMessageId: "m-d224-followup",
      kind: "settled",
      title: "Fallback settled",
      message: null,
      details: [{ label: "Now on", value: TARGET_IDENTITY }],
      sequence: 7,
    };
  }
  const D224_FOLLOWUP_TEXT = `Fallback settled. Now on: ${TARGET_IDENTITY}`;

  it("D224 (unchanged epoch): a real unmount with NO reconnect while gone, remounted, then a genuinely DEFERRED (unhydrated-tail) held outcome speaks exactly once, and completing the tail afterward does not replay it", async () => {
    const { harness, epoch } = establishD224Baseline();

    // Step 2: mount once, then literally unmount - the store/registry lease
    // survives (nothing here releases it).
    const firstMount = renderChat(epoch, undefined);
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");
    firstMount.unmount();

    // Step 3: NEITHER "reconnecting" NOR "closed" while unmounted.
    expect(harness.handle.store.getState().connectionEpoch).toBe(epoch);

    // Step 4: remount against the CACHED empty baseline (a fresh
    // `ChatFallbackAnnouncementSource` instance, fresh `observerRef`,
    // `wasReady = false` again) and flush. Unlike the advanced-epoch arm
    // below, this arm never rerenders props afterward, so the render
    // result is not bound to a name.
    renderChat(epoch, undefined);
    await flushAnnouncer();
    expect(liveRegionText()).toBe(""); // the remount's own first observation
    expect(harness.handle.store.getState().connectionEpoch).toBe(
      harness.handle.store.getState().transcriptBaselineEpoch,
    ); // ready: epochs already agree, unlike the advanced case below
    // `snapshotLoaded`/`connectionStatus` already hold their ready values
    // BEFORE the held delivery below - the baseline fold (inside
    // `establishD224Baseline`) set them, and nothing since has touched
    // them.
    expect(harness.handle.store.getState().snapshotLoaded).toBe(true);
    expect(harness.handle.store.getState().connectionStatus).toBe("open");

    // Step 5: the held outcome, delivered via a genuinely DEFERRED windowed
    // snapshot (unhydrated tail) - proves the metadata seats BEFORE any row
    // does (D215/R1), not merely that a full fold can carry it. The
    // deferral branch of `applyOrDeferWindowedSnapshot` never touches
    // `transcriptBaselineEpoch` (only the fold does), so it stays exactly
    // where step 4 already observed it.
    const heldOutcome = d224HeldOutcome();
    harness
      .callbacks()
      .onWindowedSnapshot(
        deferredWindowedSnapshot(heldOutcome, D224_WINDOW_EPOCH),
      );
    expect(
      isTailHydrated(harness.handle.store.getState().transcriptWindow),
    ).toBe(false);
    expect(harness.handle.store.getState().transcriptBaselineEpoch).toBe(epoch);
    // Metadata seats immediately, BEFORE any row is hydrated (D215/R1) - not
    // merely readable after a later fold.
    expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
      heldOutcome,
    );
    // `snapshotLoaded`/`connectionStatus` are untouched by the deferral
    // branch (only `applyAuthoritativeSnapshot` and `onConnectionStatus`
    // write them, and neither runs here).
    expect(harness.handle.store.getState().snapshotLoaded).toBe(true);
    expect(harness.handle.store.getState().connectionStatus).toBe("open");
    // Speech asserted BEFORE completing any range.
    await flushAnnouncer();
    expect(liveRegionText()).toBe(D224_HELD_TEXT);
    const spokenNode = liveRegionSpan();
    // Falsification: `changedEpoch` is FALSE on this observation (the
    // remounted observer already established `epoch` as its baseline at
    // step 4, and this delivery does not change it) - so the real
    // falsifier is `applyOrDeferWindowedSnapshot`'s unhydrated branch
    // (chat-session-store.ts ~4148-4150): remove its immediate
    // `lastFallbackOutcome` write and this speech-before-tail assertion
    // goes red, since the store would have nothing to announce until
    // `completeTail` runs.

    // Only afterward, seat the tail - with REAL persisted rows, not a
    // bodyless range response - and confirm it actually hydrated.
    completeTail(harness, D224_WINDOW_EPOCH);
    expect(
      isTailHydrated(harness.handle.store.getState().transcriptWindow),
    ).toBe(true);
    expect(
      harness.handle.store.getState().messages.map((m) => m.messageId),
    ).toEqual(["m-0", "m-1"]);
    expect(harness.handle.store.getState().snapshotLoaded).toBe(true);
    expect(harness.handle.store.getState().connectionStatus).toBe("open");
    await flushAnnouncer();
    expect(liveRegionText()).toBe(D224_HELD_TEXT); // unchanged - no re-announce
    // Same live-region node, not merely equal text, in this BEFORE/AFTER
    // pair - a fresh replay that happened to render identical text would
    // still swap in a NEW `<span key={announcement.sequence}>` node.
    expect(liveRegionSpan()).toBe(spokenNode);
  });

  it("D224 (advanced epoch, cached baseline): a real reconnect WHILE unmounted, remounted against the stale cached baseline, then the SAME held outcome (delivered DEFERRED, unhydrated tail) stays silent through and past tail hydration; a genuinely NEW block afterward still speaks live", async () => {
    const { harness, epoch } = establishD224Baseline();

    // Step 2: mount once, then literally unmount.
    const firstMount = renderChat(epoch, undefined);
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");
    firstMount.unmount();

    // Step 3: a REAL reconnect while unmounted - the store's
    // `bumpConnectionEpoch` (chat-session-store.ts, the ONLY epoch writer)
    // fires on "reconnecting"/"closed", advancing `connectionEpoch` while
    // `transcriptBaselineEpoch` still reads the OLD value. No component is
    // mounted to observe any of this.
    harness.callbacks().onConnectionStatus("reconnecting", null);
    harness.callbacks().onConnectionStatus("open", null);
    expect(harness.handle.store.getState().connectionEpoch).not.toBe(epoch);
    expect(harness.handle.store.getState().transcriptBaselineEpoch).toBe(epoch);

    // Step 4: remount against the CACHED (now-stale) empty baseline - a
    // fresh observer, `wasReady = false`. `ready` requires
    // `transcriptBaselineEpoch === connectionEpoch`, which is false here, so
    // this first observation is not-ready regardless of `wasReady`.
    const chat = renderChat(epoch, undefined);
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");
    // `snapshotLoaded` (set by the baseline fold, untouched since) and
    // `connectionStatus` (re-settled "open" by step 3's reconnect) already
    // hold their post-reconnect values BEFORE the held delivery below -
    // only `transcriptBaselineEpoch !== connectionEpoch` is what keeps
    // `ready` false here.
    expect(harness.handle.store.getState().snapshotLoaded).toBe(true);
    expect(harness.handle.store.getState().connectionStatus).toBe("open");

    // Step 5: the SAME held-outcome fixture and delivery mechanism as the
    // unchanged-epoch case above - a genuinely deferred windowed snapshot.
    // The deferral branch does not touch `transcriptBaselineEpoch` either,
    // so it STAYS the pre-reconnect value, still disagreeing with
    // `connectionEpoch` - `ready` is false regardless of the deferral.
    const heldOutcome = d224HeldOutcome();
    harness
      .callbacks()
      .onWindowedSnapshot(
        deferredWindowedSnapshot(heldOutcome, D224_WINDOW_EPOCH),
      );
    expect(
      isTailHydrated(harness.handle.store.getState().transcriptWindow),
    ).toBe(false);
    expect(harness.handle.store.getState().transcriptBaselineEpoch).toBe(epoch);
    expect(harness.handle.store.getState().connectionEpoch).not.toBe(
      harness.handle.store.getState().transcriptBaselineEpoch,
    );
    // Metadata seats immediately regardless of readiness - the deferral
    // branch never gates ON `ready`, only the announcer's own subscription
    // does.
    expect(harness.handle.store.getState().lastFallbackOutcome).toBe(
      heldOutcome,
    );
    // `snapshotLoaded` stays true throughout (the earlier baseline fold set
    // it and nothing here clears it); `connectionStatus` is "open" again
    // after the reconnect completed in step 3.
    expect(harness.handle.store.getState().snapshotLoaded).toBe(true);
    expect(harness.handle.store.getState().connectionStatus).toBe("open");
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");
    const spokenNode = liveRegionSpan();
    // Falsification: remove ONLY `state.transcriptBaselineEpoch ===
    // state.connectionEpoch` from `ready` (ChatFallbackAnnouncementSource,
    // chat-messages.tsx ~985-1166) - the remounted observer would then
    // treat the held metadata as live despite the epoch mismatch, and
    // speak it before the tail is ever hydrated.

    // Only afterward, seat the tail with REAL persisted rows. This runs the
    // FULL FOLD, which finally advances `transcriptBaselineEpoch` to the
    // current `connectionEpoch` - but the component's `baselineEpoch` PROP
    // is still the stale `epoch`, so `ready` stays false (a props/state
    // epoch mismatch) rather than becoming a fresh live frame. Still no
    // replay.
    completeTail(harness, D224_WINDOW_EPOCH);
    expect(
      isTailHydrated(harness.handle.store.getState().transcriptWindow),
    ).toBe(true);
    expect(
      harness.handle.store.getState().messages.map((m) => m.messageId),
    ).toEqual(["m-0", "m-1"]);
    expect(harness.handle.store.getState().snapshotLoaded).toBe(true);
    expect(harness.handle.store.getState().connectionStatus).toBe("open");
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");
    // Same absent live-region node before/after tail hydration - confirms
    // the POST-hydration state is silent. This does not by itself rule out
    // a transient commit-and-revert in between (only a commit trace, as in
    // the completion/fallback combo test above, could catch that); it is
    // the two point-in-time reads either side of `completeTail` staying
    // consistent.
    expect(liveRegionSpan()).toBe(spokenNode);
    const newEpoch = harness.handle.store.getState().transcriptBaselineEpoch;
    expect(newEpoch).not.toBe(epoch); // sanity: the fold did catch up

    // Bring the component's props into agreement, matching what a real
    // consumer re-deriving `baselineEpoch` off the store would eventually
    // do.
    chat.rerenderWith({ baselineEpoch: newEpoch });
    await flushAnnouncer();
    // Absorbed as the re-established baseline (`changedEpoch`), never
    // spoken - G1's rule: a pre-baseline block is absorbed forever, with no
    // later replay once tail hydration catches up either.
    expect(liveRegionText()).toBe("");

    // Retained: a genuinely NEW block afterward, on the now-current epoch,
    // still speaks live - the separate liveness control, proving the
    // silence above is readiness-scoped rather than the observer having
    // gone permanently deaf.
    setTurnState(harness, undefined, undefined, d224FollowUpOutcome());
    await flushAnnouncer();
    expect(liveRegionText()).toBe(D224_FOLLOWUP_TEXT);
  });

  // R1: independent outcome metadata reaching the announcer while its
  // anchor row is unloaded, followed by a REAL eventual hydration of that
  // SAME row/block through the real `useRenderedMessages` mapper - a
  // separate scenario from D224 (which stays unchanged above). Reuses
  // `createWindowedHarness`/`emptyWindowedSnapshot`/`deferredWindowedSnapshot`
  // unmodified; only the tail response and the rendered-model wiring are
  // new.
  const R1_EVENTUAL_BLOCK_ID = "block-r1-eventual";
  const R1_EVENTUAL_TURN_ID = "turn-r1-eventual";

  function r1EventualOutcome(): LastFallbackOutcome {
    return {
      blockId: R1_EVENTUAL_BLOCK_ID,
      assistantMessageId: R1_EVENTUAL_TURN_ID,
      kind: "applied",
      title: "Switched providers",
      message: null,
      details: [{ label: "To", value: TARGET_IDENTITY }],
      sequence: 1,
    };
  }
  const R1_EVENTUAL_TEXT = `Switched providers. To: ${TARGET_IDENTITY}`;

  const R1_ASSISTANT_SENDER: AgentSender = {
    type: "agent",
    harnessId: "codex",
    agentId: "codex-agent-r1",
    displayName: "Codex",
    reply: { expectsReply: false },
    inReplyTo: null,
  };

  /** The SAME block already spoken live, now arriving as a real persisted
   * transcript row - `blockId` matches `r1EventualOutcome()` exactly, per
   * `rendered-messages.ts` (~4180: `segment.id = block.blockId`). */
  function r1EventualAssistantMessage(): Extract<
    Message,
    { role: "assistant" }
  > {
    return {
      role: "assistant",
      messageId: R1_EVENTUAL_TURN_ID,
      sender: R1_ASSISTANT_SENDER,
      blocks: [
        {
          type: "text",
          blockId: R1_EVENTUAL_BLOCK_ID,
          status: "completed",
          timestamp: 1,
          text: "Switched providers.",
          providerNotice: {
            harnessId: "codex",
            noticeKind: "fallback_applied",
            tone: "info",
            title: "Switched providers",
            message: null,
            details: [{ label: "To", value: TARGET_IDENTITY }],
            metadata: null,
          },
        },
      ],
      startedAt: 1,
      timestamp: 1,
      turnId: R1_EVENTUAL_TURN_ID,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };
  }

  const R1_DISPLAY_CONTEXT: RenderedMessagesDisplayContext = {
    resolveUserSenderLabel: () => "You",
    resolveAgentSenderDisplay: () => ({
      senderLabel: "Codex",
      providerLabel: "Codex",
      modelLabel: null,
    }),
    resolveAgentReasoningLabel: () => null,
    contentBlocksPreview: () => "",
  };

  it("R1: independent outcome metadata speaks while its assistant row is unloaded, then a real onRange hydrates that SAME row/block through the REAL rendered-messages mapper - the already-spoken announcement is retained, not replayed", async () => {
    const harness = createWindowedHarness();
    registerHarness(harness);
    harness.callbacks().onConnectionStatus("open", null);
    // A truly empty baseline folds immediately (same technique as D224).
    // `D224_WINDOW_EPOCH` is the WIRE epoch for every snapshot/range below -
    // an independent coordinate from `epoch` (`transcriptBaselineEpoch`,
    // reads 0 off this empty fold), which is used ONLY for `ChatMessages`'s
    // `baselineEpoch` prop.
    harness
      .callbacks()
      .onWindowedSnapshot(emptyWindowedSnapshot(D224_WINDOW_EPOCH));
    const epoch = harness.handle.store.getState().transcriptBaselineEpoch;

    const chat = renderChat(epoch, undefined);
    await flushAnnouncer();
    expect(liveRegionText()).toBe("");

    const outcome = r1EventualOutcome();
    // The real D215 immediate-seat path: delivered via a genuinely DEFERRED
    // windowed snapshot (unhydrated tail, rowCount: 2), never
    // `store.setState`.
    harness
      .callbacks()
      .onWindowedSnapshot(deferredWindowedSnapshot(outcome, D224_WINDOW_EPOCH));
    expect(harness.handle.store.getState().lastFallbackOutcome).toBe(outcome);
    // The outcome's anchor row is genuinely unloaded before the range
    // response below answers it.
    expect(
      harness.handle.store
        .getState()
        .messages.some((m) => m.messageId === R1_EVENTUAL_TURN_ID),
    ).toBe(false);
    await flushAnnouncer();
    expect(liveRegionText()).toBe(R1_EVENTUAL_TEXT);
    const spokenNode = liveRegionSpan();

    const hydrationBefore =
      harness.handle.store.getState().transcriptHydrationSequence;

    // Answer the ACTUAL recorded range request, completing the FULL
    // two-row window `deferredWindowedSnapshot` declared (`rowCount: 2`) -
    // a real user row plus the real persisted assistant row carrying the
    // SAME blockId as the outcome already spoken. A partial (one-row) tail
    // would leave `isTailHydrated` false and could satisfy this test's
    // later assertions for the wrong reason.
    const r1UserMessage = userMessage("m-r1-user", 0);
    harness.callbacks().onRange({
      kind: "range",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      range: {
        requestId: harness.lastRangeRequestId(),
        epoch: D224_WINDOW_EPOCH,
        fromOrdinal: 0,
        rowIds: [r1UserMessage.messageId, assistantRowId(R1_EVENTUAL_TURN_ID)],
        messages: [r1UserMessage, r1EventualAssistantMessage()],
        events: [],
        rowContext: {},
        reachedStart: true,
        reachedEnd: true,
      },
    });
    expect(
      isTailHydrated(harness.handle.store.getState().transcriptWindow),
    ).toBe(true);
    // The real hydration counter, not a hand-written one.
    expect(harness.handle.store.getState().transcriptHydrationSequence).toBe(
      hydrationBefore + 1,
    );
    expect(
      harness.handle.store
        .getState()
        .messages.some((m) => m.messageId === R1_EVENTUAL_TURN_ID),
    ).toBe(true);
    // The fixture is idle throughout - the real caller's narrowed
    // turn-status derivation, per `RenderedMessagesInput.runStatus`'s own
    // contract.
    expect(harness.handle.store.getState().runStatus).toBe("idle");

    // ONE state snapshot, read after the range response, feeds BOTH the
    // real mapper below AND the later `chat.rerenderWith` - so every
    // provenance field the component and the mapper see is mutually
    // consistent.
    const state = harness.handle.store.getState();

    // The REAL mapper, unmocked, fed a fully-typed input read directly off
    // that ONE snapshot - no new Partial override builder for this single
    // case. `ownerId` is the CHAT binding's owner (`CHAT_ID`, matching
    // `ownerKind: "chat"`), not the user id.
    const renderedInput: RenderedMessagesInput = {
      messages: state.messages,
      events: state.events,
      rowContext: state.transcriptRowContext,
      setupCardWindows:
        state.transcriptDerived === null
          ? []
          : state.transcriptDerived.setupCardWindows,
      pendingUserMessages: state.pendingUserMessages,
      liveAssistantMessage: state.liveAssistantMessage,
      activeTurn: state.activeTurn,
      pendingApprovals: state.pendingApprovals,
      pendingFileEditApprovals: state.pendingFileEditApprovals,
      pendingInterviews: state.pendingInterviews,
      runStatus: state.runStatus,
      epicId: EPIC_ID,
      ownerId: CHAT_ID,
      ownerKind: "chat",
      viewTabId: "tab-r1-eventual",
    };
    const { result: renderedResult } = renderHook(
      ({ current }: { current: RenderedMessagesInput }) =>
        useRenderedMessages(current, R1_DISPLAY_CONTEXT),
      { initialProps: { current: renderedInput } },
    );
    const renderedRow = renderedResult.current.find(
      (m) => m.id === assistantRowId(R1_EVENTUAL_TURN_ID),
    );
    expect(renderedRow).toBeDefined();
    const projectedSegment = renderedRow?.segments.find(
      (segment) => segment.kind === "provider_notice",
    );
    if (projectedSegment === undefined) {
      throw new Error("expected a projected provider_notice segment");
    }
    // Independent identity check - a mapper dropping or renaming the block
    // cannot make the no-replay assertion below pass vacuously.
    expect(projectedSegment.id).toBe(R1_EVENTUAL_BLOCK_ID);
    expect(projectedSegment.noticeKind).toBe("fallback_applied");

    // Feed the REAL rendered models (not a handcrafted model claiming to be
    // their output) and ALL FOUR real provenance fields - from the SAME
    // state snapshot the mapper input above was built from - into the SAME
    // mounted ChatMessages.
    chat.rerenderWith({
      messages: renderedResult.current,
      baselineEpoch: state.transcriptBaselineEpoch,
      hydrationSequence: state.transcriptHydrationSequence,
      coldRewrittenMessageIds: state.coldRewrittenMessageIds,
      transcriptWindow: state.transcriptWindow,
    });
    await flushAnnouncer();
    // The already-spoken announcement is RETAINED - same node, not a
    // fresh replay now that the block is resident.
    expect(liveRegionText()).toBe(R1_EVENTUAL_TEXT);
    expect(liveRegionSpan()).toBe(spokenNode);
    // This test proves the same-block hydration/projection path (the real
    // mapper's segment identity above) AND that the already-spoken
    // announcement is retained rather than replayed once the block becomes
    // resident. It does NOT, by itself, isolate the pure observer's
    // consumption-check (`consumedNotices`) from its residency gate -
    // removing `consumedNotices` here could still stay silent because the
    // hydration-residency gate (chat-announcements.ts ~640-646) can
    // independently suppress a newly-loaded body on its own. That isolation
    // is the pure `chat-announcements-fallback.test.ts` shared-key pins'
    // job (the liveOutcome/metadata-then-body and body-then-metadata
    // describe block); this test is not a substitute falsifier for that
    // guard.
  });
});
