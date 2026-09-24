import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { z } from "zod";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  chatSubscribeWindowedServerFrameSchema,
  type ChatSubscribeWindowedServerFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  createChatSessionStore,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
} from "@/stores/chats/rendered-messages";
import diag4Fixture from "./fixtures/windowed-late-peer-reserve-diag4-frames.json";
import diag5ProdFixture from "./fixtures/windowed-late-peer-reserve-diag5-prod-frames.json";
import diag5HeldFixture from "./fixtures/windowed-late-peer-reserve-diag5-held-frames.json";
import diag5RaceFixture from "./fixtures/windowed-late-peer-reserve-diag5-race-frames.json";
import { isTailHydrated } from "@/stores/chats/transcript-window";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * Replay of the frames a late windowed peer (schema 1.13) received from a
 * live ChatSessionManager, through the real chat session store. Harness only
 * so far: the fixtures (diag4 / diag5) and the assertions land with them.
 */

const EPIC_ID = "epic-windowed-emit";
const CHAT_ID = "chat-windowed-emit";
const OWNER_ID = "owner-1";

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
  contentBlocksPreview: () => "",
};

const dumpedFrameSchema = z.object({
  i: z.number(),
  restoresX: z.boolean().optional(),
  envelope: z.unknown(),
});
export const dumpedFramesSchema = z.array(dumpedFrameSchema);

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly resnapshotCount: () => number;
  callbacks(): ChatStreamCallbacks;
}

export function createHarness(): Harness {
  let resnapshots = 0;
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: () => {},
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => {
          resnapshots += 1;
        },
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    resnapshotCount: () => resnapshots,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

/**
 * Parses one envelope exactly as `handleWindowedFrame` does and routes it to
 * the callback the real client would call. A frame that fails to parse THROWS:
 * the fixture is never hand-edited to fit.
 */
export function dispatchEnvelope(
  cb: ChatStreamCallbacks,
  index: number,
  envelope: unknown,
): void {
  const parsed = chatSubscribeWindowedServerFrameSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error(
      `frame #${index} failed chatSubscribeWindowedServerFrameSchema: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  const frame: ChatSubscribeWindowedServerFrame = parsed.data;
  switch (frame.kind) {
    case "snapshot":
      return cb.onWindowedSnapshot(frame);
    case "skeletonChunk":
      return cb.onSkeletonChunk(frame);
    case "indexChanged":
      return cb.onIndexChanged(frame);
    case "range":
      return cb.onRange(frame);
    case "accumulatedChanges":
      return cb.onAccumulatedChanges(frame);
    case "actionAck":
      return cb.onActionAck(frame);
    case "messageAccepted":
      return cb.onMessageAccepted(frame);
    case "messageDeliveryChanged":
      return cb.onMessageDeliveryChanged(frame);
    case "queueChanged":
      return cb.onQueueChanged(frame);
    case "turnStateChanged":
      return cb.onTurnStateChanged(frame);
    case "blockDelta":
      return cb.onBlockDelta(frame);
    case "approvalRequested":
      return cb.onApprovalRequested(frame);
    case "approvalResolved":
      return cb.onApprovalResolved(frame);
    case "fileEditApprovalRequested":
      return cb.onFileEditApprovalRequested(frame);
    case "fileEditApprovalResolved":
      return cb.onFileEditApprovalResolved(frame);
    case "interviewRequested":
      return cb.onInterviewRequested(frame);
    case "interviewAnswered":
      return cb.onInterviewAnswered(frame);
    case "interviewErrored":
      return cb.onInterviewErrored(frame);
    case "eventAppended":
      return cb.onEventAppended(frame);
    case "restoreStarted":
      return cb.onRestoreStarted(frame);
    case "restoreProgress":
      return cb.onRestoreProgress(frame);
    case "restoreCompleted":
      return cb.onRestoreCompleted(frame);
    case "errorNotice":
      return cb.onErrorNotice(frame);
    case "worktreeStateChanged":
      return cb.onWorktreeStateChanged(frame);
    case "managedCommandsChanged":
      return cb.onManagedCommandsChanged(frame);
    case "portForwardsChanged":
      return cb.onPortForwardsChanged(frame);
    case "heldUpdatesChanged":
      return cb.onHeldUpdatesChanged(frame);
    case "pong":
      return undefined;
    default: {
      const _exhaustive: never = frame;
      void _exhaustive;
      return undefined;
    }
  }
}

/**
 * The UI's rendered rows for the current store state: the same
 * `useRenderedMessages` projection the transcript reads, fed from state.
 * Returns the JSON of every rendered ASSISTANT row (a turn may render as
 * several slices), i.e. what is drawn.
 */
export function renderedBodyOf(state: ChatSessionState): string {
  const { result } = renderHook(() =>
    useRenderedMessages(
      {
        messages: state.messages,
        events: state.events,
        rowContext: state.transcriptRowContext,
        setupCardWindows: state.transcriptDerived?.setupCardWindows ?? [],
        pendingUserMessages: state.pendingUserMessages,
        withdrawnMessageId: null,
        liveAssistantMessage: state.liveAssistantMessage,
        activeTurn: state.activeTurn,
        pendingApprovals: state.pendingApprovals,
        runStatus: state.runStatus,
        epicId: EPIC_ID,
        ownerId: CHAT_ID,
        ownerKind: "chat",
        viewTabId: "tab-1",
      },
      displayContext,
    ),
  );
  return JSON.stringify(
    result.current
      .filter((row) => row.role === "assistant")
      .map((row) => ({ content: row.content, segments: row.segments })),
  );
}

const X = "tool-1:approval";

interface Observed {
  readonly rendered: string;
  readonly live: string | null;
  readonly liveHasX: boolean;
  readonly liveBlocksVersion: number | null;
  readonly activeTurnId: string | null;
  readonly pendingApprovalCount: number;
}

function observe(handle: ChatSessionStoreHandle): Observed {
  const state = handle.store.getState();
  const live = state.liveAssistantMessage;
  const liveJson = live === null ? null : JSON.stringify(live.blocks);
  return {
    rendered: renderedBodyOf(state),
    live: liveJson,
    liveHasX: liveJson !== null && liveJson.includes(X),
    liveBlocksVersion: live === null ? null : live.blocksVersion,
    activeTurnId: state.activeTurn === null ? null : state.activeTurn.turnId,
    pendingApprovalCount: state.pendingApprovals.length,
  };
}

describe("late windowed peer re-serve (diag4: approval block X)", () => {
  it("keeps the approval block through the re-serve, the updated echo and the turn's end", () => {
    const frames = dumpedFramesSchema.parse(diag4Fixture);
    const harness = createHarness();
    const seen = new Map<number, Observed>();
    const approvalsByFrame = new Map<
      number,
      { ids: string[]; tailHydrated: boolean }
    >();
    try {
      const cb = harness.callbacks();
      for (const frame of frames) {
        dispatchEnvelope(cb, frame.i, frame.envelope);
        seen.set(frame.i, observe(harness.handle));
        const st = harness.handle.store.getState();
        approvalsByFrame.set(frame.i, {
          ids: st.pendingApprovals.map((a) => a.approvalId),
          tailHydrated: isTailHydrated(st.transcriptWindow),
        });
      }
      const at = (i: number): Observed => {
        const o = seen.get(i);
        if (o === undefined) throw new Error(`no observation for #${i}`);
        return o;
      };
      expect(at(1).rendered, "#1: opening lacks X").not.toContain(X);
      expect(at(4).rendered, "#4: re-serve snapshot shows X").toContain(X);
      expect(at(5).rendered, "#5: updated echo keeps X").toContain(X);
      expect(at(4).activeTurnId, "#4: activeTurn is turn-1").toBe("turn-1");
      expect(at(6).pendingApprovalCount, "#6: approval resolved").toBe(0);
      const firstHydrated = frames
        .map((f) => f.i)
        .find((i) => approvalsByFrame.get(i)?.tailHydrated === true);
      expect(firstHydrated, "a frame hydrates the tail").toBeDefined();
      if (firstHydrated !== undefined) {
        for (let i = firstHydrated; i <= 5; i += 1) {
          expect(
            approvalsByFrame.get(i)?.ids,
            `#${i}: pendingApprovals holds X from the first hydrated frame (#${firstHydrated}) through #5`,
          ).toContain(X);
        }
      }
      expect(at(19).rendered, "#19: X present at the end").toContain(X);
    } finally {
      harness.handle.dispose();
    }
  });
});

const streamingDumpSchema = z.object({
  variant: z.string(),
  hostTextFinal: z.string(),
  frames: dumpedFramesSchema,
});

function textOfBlocks(
  blocks: ReadonlyArray<{ readonly blockId: string }>,
): string {
  const found = blocks.find((block) => block.blockId === "text-1");
  if (found === undefined) return "";
  const asJson = JSON.parse(JSON.stringify(found)) as { text?: string };
  return asJson.text ?? "";
}

interface StreamObserved {
  readonly rendered: string;
  readonly liveText: string | null;
  readonly liveVersion: number | null;
  readonly recordText: string | null;
  readonly recordVersion: number | null;
}

function observeStreaming(handle: ChatSessionStoreHandle): StreamObserved {
  const state = handle.store.getState();
  const live = state.liveAssistantMessage;
  const record = state.messages.find(
    (message) => message.role === "assistant" && message.turnId === "turn-1",
  );
  const { result } = renderHook(() =>
    useRenderedMessages(
      {
        messages: state.messages,
        events: state.events,
        rowContext: state.transcriptRowContext,
        setupCardWindows: state.transcriptDerived?.setupCardWindows ?? [],
        pendingUserMessages: state.pendingUserMessages,
        withdrawnMessageId: null,
        liveAssistantMessage: live,
        activeTurn: state.activeTurn,
        pendingApprovals: state.pendingApprovals,
        runStatus: state.runStatus,
        epicId: EPIC_ID,
        ownerId: CHAT_ID,
        ownerKind: "chat",
        viewTabId: "tab-1",
      },
      displayContext,
    ),
  );
  const rendered = result.current
    .filter((row) => row.role === "assistant")
    .flatMap((row) => row.segments)
    .map((segment) => (segment.kind === "text" ? segment.markdown : ""))
    .join("");
  const recordVersion =
    record !== undefined && record.role === "assistant"
      ? (record.blocksVersion ?? null)
      : null;
  return {
    rendered,
    liveText: live === null ? null : textOfBlocks(live.blocks),
    liveVersion: live === null ? null : live.blocksVersion,
    recordText:
      record !== undefined && record.role === "assistant"
        ? textOfBlocks(record.blocks)
        : null,
    recordVersion,
  };
}

interface StreamingCase {
  readonly name: string;
  readonly fixture: unknown;
  readonly holeAfter: number;
  readonly missingPrefix: string;
  readonly reserveAt: number;
  readonly servedText: string;
  readonly servedVersion: number;
  readonly echoes: ReadonlyArray<number>;
  readonly foldedAt: number;
}

const STREAMING_CASES: ReadonlyArray<StreamingCase> = [
  {
    name: "PROD (stream paused across the attach)",
    fixture: diag5ProdFixture,
    holeAfter: 3,
    missingPrefix: "alpha bravo charlie ",
    reserveAt: 4,
    servedText: "alpha bravo charlie ",
    servedVersion: 3,
    echoes: [5],
    foldedAt: 8,
  },
  {
    name: "HELD (attach pass held while two deltas stream)",
    fixture: diag5HeldFixture,
    holeAfter: 3,
    missingPrefix: "alpha bravo charlie ",
    reserveAt: 6,
    servedText: "alpha bravo charlie delta echo ",
    servedVersion: 5,
    echoes: [7, 8],
    foldedAt: 9,
  },
  {
    name: "RACE (stream resumes in the attach's tick)",
    fixture: diag5RaceFixture,
    holeAfter: 4,
    missingPrefix: "alpha bravo charlie delta ",
    reserveAt: 5,
    servedText: "alpha bravo charlie delta echo ",
    servedVersion: 5,
    echoes: [6, 7],
    foldedAt: 8,
  },
];

describe("late windowed peer re-serve (diag5: streaming text)", () => {
  for (const c of STREAMING_CASES) {
    it(`${c.name}: the re-serve heals the hole and later deltas fold once`, () => {
      const dump = streamingDumpSchema.parse(c.fixture);
      const harness = createHarness();
      const seen = new Map<number, StreamObserved>();
      try {
        const cb = harness.callbacks();
        for (const frame of dump.frames) {
          dispatchEnvelope(cb, frame.i, frame.envelope);
          const o = observeStreaming(harness.handle);
          seen.set(frame.i, o);
        }
        const at = (i: number): StreamObserved => {
          const o = seen.get(i);
          if (o === undefined) throw new Error(`no observation for #${i}`);
          return o;
        };
        const before = at(c.reserveAt - 1);
        const after = at(c.reserveAt);
        const held = Math.max(
          before.liveVersion ?? -1,
          before.recordVersion ?? -1,
        );
        expect(
          at(c.holeAfter).rendered,
          `#${c.holeAfter}: the hole is present`,
        ).not.toContain(c.missingPrefix);
        expect(
          after.rendered,
          `#${c.reserveAt}: rendered text equals the served text-1`,
        ).toBe(c.servedText);
        expect(
          held,
          `#${c.reserveAt}: held blocksVersion < served ${c.servedVersion}`,
        ).toBeLessThan(c.servedVersion);
        for (const i of c.echoes) {
          expect(
            at(i).rendered,
            `#${i}: updated echo leaves the text unchanged`,
          ).toBe(c.servedText);
        }
        expect(
          at(c.foldedAt).rendered,
          `#${c.foldedAt}: later delta folds without duplication`,
        ).toBe(dump.hostTextFinal);
        const last = dump.frames[dump.frames.length - 1];
        expect(at(last.i).rendered, "final state equals host text").toBe(
          dump.hostTextFinal,
        );
      } finally {
        harness.handle.dispose();
      }
    });
  }
});
