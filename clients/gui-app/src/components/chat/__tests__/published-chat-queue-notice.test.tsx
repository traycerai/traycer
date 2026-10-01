/**
 * A read-only transcript - a published chat, or the replica of an unpublished
 * one (`published-chat-tile.tsx`, both built by
 * `createPublishedChatSessionHandle`) - DRAWS the queue-paused notice and keeps
 * the routing refusal notice hidden.
 *
 * The chain under test is the one `ChatTileSessionView` runs: the handle's
 * store answers `queuePauseReasonProtocolSupported`, the view hands that
 * answer to `TranscriptQueuePauseReasonSupportContext` (the same `useStore`
 * selector, below), and the assistant body and chat find read it. The view
 * itself is not rendered here: its session wiring needs a host runtime this
 * suite does not stand up, so the wiring is mirrored one-for-one.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { QUEUE_PAUSED_AFTER_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessageAt } from "@/components/chat/__tests__/chat-message-fixtures";
import { AssistantMessageBody } from "@/components/chat/chat-message-assistant-body";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import {
  buildChatFindRows,
  chatFindSegmentUnitId,
} from "@/components/chat/chat-find";
import { TranscriptQueuePauseReasonSupportContext } from "@/components/chat/use-transcript-queue-pause-reason-support";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  convertReplicaChat,
  createPublishedChatSessionHandle,
  type PublishedChatSessionHandle,
} from "@/lib/chats/published-chat-session";
import type { MessageSegment } from "@/stores/composer/chat-store";

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));
// The settled-card path reaches these; this suite has no live host or
// QueryClientProvider (same doubles as the hidden-notices body test).
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/chat/fallback/fallback-identity")
      >();
    return {
      ...actual,
      useFallbackModelLabels: () => (_harnessId: string, model: string) =>
        model,
    };
  },
);

const TILE_INSTANCE_ID = "published-queue-notice-tile";
const HOST_ID = "tab-host-published-queue-notice";
const CHAT_ID = "chat-published-queue-notice";

const QUEUE_NOTICE_MESSAGE =
  "1 queued message was held because this turn ended with an error, and it was not sent. Resume the queue to send it.";

const QUEUE_NOTICE: MessageSegment = {
  id: "queue-paused:published",
  kind: "error",
  message: QUEUE_NOTICE_MESSAGE,
  recoverable: true,
  code: QUEUE_PAUSED_AFTER_ERROR_CODE,
  failure: null,
};

const CANCELLATION_TITLE =
  "Fallback ended - no further providers will be tried for this turn";

const REFUSAL_NOTICE: MessageSegment = {
  id: "fallback-settled:published",
  kind: "provider_notice",
  status: "completed",
  noticeKind: "fallback_settled",
  tone: "info",
  title: CANCELLATION_TITLE,
  message: "What was tried is recorded below.",
  details: [{ label: "Code", value: "FALLBACK_CANCELLED" }],
  receipt: null,
  parentId: null,
};

function publishedHandle(): PublishedChatSessionHandle {
  return createPublishedChatSessionHandle({
    epicId: "epic-1",
    chatId: CHAT_ID,
    ownerUserId: "owner-1",
    title: "Published chat",
    createdAt: 1,
    updatedAt: 2,
    conversion: { messages: [], events: [], unreadableCount: 0 },
  });
}

/** The replica branch's handle: the same factory over a replica conversion. */
function replicaHandle(): PublishedChatSessionHandle {
  return createPublishedChatSessionHandle({
    epicId: "epic-1",
    chatId: CHAT_ID,
    ownerUserId: "owner-1",
    title: "Replica chat",
    createdAt: 1,
    updatedAt: 2,
    conversion: convertReplicaChat([], []),
  });
}

/** `ChatTileSessionView`'s own wiring of the answer into the transcript. */
function SessionTranscript(props: {
  readonly handle: PublishedChatSessionHandle;
  readonly children: ReactNode;
}) {
  const support = useStore(
    props.handle.store,
    (state) => state.queuePauseReasonProtocolSupported,
  );
  return (
    <TranscriptQueuePauseReasonSupportContext value={support}>
      {props.children}
    </TranscriptQueuePauseReasonSupportContext>
  );
}

function renderBody(
  handle: PublishedChatSessionHandle,
  segments: ReadonlyArray<MessageSegment>,
) {
  return render(
    <TooltipProvider delayDuration={0}>
      <TabHostProvider hostId={HOST_ID}>
        <ChatTranscriptProvider value={{ chatId: CHAT_ID, hostId: HOST_ID }}>
          <ChatExpansionTestProviders tileInstanceId={TILE_INSTANCE_ID}>
            <SessionTranscript handle={handle}>
              <AssistantMessageBody
                segments={segments}
                backgroundToolBlockIds={new Set()}
                runState={null}
                messageId="assistant:published-queue-notice"
                turnId="turn-published-queue-notice"
                manualRungAnchorId={null}
                elapsedStartedAt={0}
                turnHasOnlyAutonomousResumeSegments={false}
                showCompletionFooter={false}
                pausedDurationMs={0}
                pausedSinceMs={null}
                completedAt={null}
                stopped={null}
                meta={null}
                nextStepActions={null}
                forkAction={null}
                interviewDeliveryRetry={null}
                routingSettledNoticeId={null}
              />
            </SessionTranscript>
          </ChatExpansionTestProviders>
        </ChatTranscriptProvider>
      </TabHostProvider>
    </TooltipProvider>,
  );
}

/** Chat find's units for one assistant row, under the handle's answer. */
function findUnitsFor(
  handle: PublishedChatSessionHandle,
  segments: ReadonlyArray<MessageSegment>,
) {
  const model = {
    ...makeMessageAt(0, "assistant", 5),
    runState: null,
    segments,
  };
  return buildChatFindRows([model], TILE_INSTANCE_ID, new Set(), {
    hideReasoning: false,
    queuePauseReasonProtocolSupported:
      handle.store.getState().queuePauseReasonProtocolSupported,
  }).flatMap((row) => row.units);
}

describe.each([
  { branch: "published", handle: publishedHandle },
  { branch: "replica", handle: replicaHandle },
])("a $branch read-only transcript", ({ handle }) => {
  afterEach(() => {
    cleanup();
  });

  it("draws the queue-paused notice, and find counts it (P-1 / P-1r)", () => {
    const session = handle();
    // The read-only view's rule, not a protocol line: it drops no queue text.
    expect(session.store.getState().queuePauseReasonProtocolSupported).toBe(
      false,
    );

    renderBody(session, [QUEUE_NOTICE]);
    expect(screen.getByText(QUEUE_NOTICE_MESSAGE)).not.toBeNull();

    const units = findUnitsFor(session, [QUEUE_NOTICE]);
    expect(
      units.filter((unit) => unit.text.includes("queued message was held")),
    ).toHaveLength(1);
    expect(units.map((unit) => unit.unitId)).toContain(
      chatFindSegmentUnitId(QUEUE_NOTICE.id),
    );
  });

  it("keeps the refusal notice hidden, from the body and from find (P-2 / P-2r)", () => {
    const session = handle();

    renderBody(session, [REFUSAL_NOTICE]);
    expect(screen.queryByText(CANCELLATION_TITLE)).toBeNull();

    expect(findUnitsFor(session, [REFUSAL_NOTICE])).toHaveLength(0);
  });
});
