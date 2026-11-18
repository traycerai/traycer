/**
 * A thread card drawn in the page's flow keeps a fullscreen-pinned row mounted
 * while the fold hides it. Drives the REAL `BotChatTranscript` over
 * `chatSessionWithThreadRows`, with the REAL overlay owner holding the claim.
 *
 */
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrdinalRange } from "@/stores/chats/transcript-window";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const mocks = vi.hoisted(() => ({
  handle: null as ChatSessionStoreHandle | null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => mocks.handle,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));

import {
  BotChatTranscript,
  type BotTranscriptFold,
} from "@/components/bots/bot-chat-transcript";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import {
  postRow,
  chatSessionWithThreadRows,
} from "@/components/bots/__tests__/bot-channel-rows-test-support";
import {
  createHarness,
  primeWindowWithTail,
  windowedUserMessage,
  type Harness,
  type WindowedChatIdentity,
} from "@/stores/chats/test-support/windowed-chat-session-harness";
import { TRANSCRIPT_WINDOW_MAX_BYTES } from "@/stores/chats/transcript-window";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import {
  claimFullscreen,
  releaseFullscreen,
  transcriptRowKeyOf,
  type FullscreenClaim,
} from "@/lib/sandbox/overlay-owner";

const ROW_IDS = ["m-1", "m-2", "m-3", "m-4"];
const FOLD: BotTranscriptFold = { maxRows: 2, tail: 1, onUnfold: vi.fn() };
const claims: FullscreenClaim[] = [];
const queryClient = new QueryClient();

function transcript(fold: BotTranscriptFold | null): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ChatExpansionTestProviders tileInstanceId="thread-card">
          <BotChatTranscript
            botId="bot_01ARZ3NDEKTSV4RRFFQ69G5FAV"
            chatId="thread-1"
            hostId="host-1"
            boundHostId={null}
            title="Release Bot"
            instanceId="thread-card"
            surface={null}
            resolveMember={UNRESOLVED_BOT_MEMBERS}
            showConnecting
            header={null}
            landOn={null}
            flow={{ fold, unread: null }}
          />
        </ChatExpansionTestProviders>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function mountUnfolded(): RenderResult {
  mocks.handle = chatSessionWithThreadRows(
    ROW_IDS.map((id) => postRow(id, `text of ${id}`)),
  );
  return render(transcript(null));
}

function rowIds(): string[] {
  return Array.from(
    document.querySelectorAll(
      "[data-testid='bot-chat-transcript-flow'] [data-message-id]",
    ),
  ).map((node) => node.getAttribute("data-message-id") ?? "");
}

/** Raise the row the way an expanded surface inside it does: by its own element. */
function raiseRowOf(messageId: string): FullscreenClaim {
  const row = document.querySelector(`[data-message-id="${messageId}"]`);
  expect(row).not.toBeNull();
  const claim: FullscreenClaim = {
    exit: vi.fn(),
    pinnedRowKey: transcriptRowKeyOf(row),
    surface: () =>
      document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`),
  };
  claims.push(claim);
  act(() => {
    expect(claimFullscreen(claim)).toBe(true);
  });
  return claim;
}

afterEach(() => {
  for (const claim of claims.splice(0)) releaseFullscreen(claim);
  cleanup();
  queryClient.clear();
  mocks.handle = null;
});

describe("a thread card whose fold would hide a raised row", () => {
  it("draws only the tail when nothing is raised (control)", () => {
    const view = mountUnfolded();
    view.rerender(transcript(FOLD));
    expect(rowIds()).toEqual(["m-4"]);
  });

  it("keeps the raised row mounted through the fold, and drops it on lower", () => {
    const view = mountUnfolded();
    expect(rowIds()).toEqual(ROW_IDS);
    const claim = raiseRowOf("m-1");
    view.rerender(transcript(FOLD));
    expect(rowIds()).toContain("m-1");
    expect(screen.getByText("text of m-1")).toBeTruthy();
    act(() => releaseFullscreen(claim));
    expect(rowIds()).toEqual(["m-4"]);
  });
});

const WINDOW_IDENTITY: WindowedChatIdentity = {
  hostId: "host-1",
  epicId: "epic-pin",
  chatId: "thread-1",
  ownerId: "owner-pin",
};

describe("a raised row over the real transcript window", () => {
  it("keeps its body held through a window replacement without moving read credit", () => {
    const harness = createHarness(WINDOW_IDENTITY);
    const owner = WINDOW_IDENTITY.ownerId;
    const reports: Array<OrdinalRange | null> = [];
    let releaseHydration: () => void = () => undefined;
    try {
      // 40 rows with a COMPLETE hydrated tail, ordinals 37..39: nothing in
      // the tail is a placeholder, and the folded card draws ordinal 39.
      primeWindowWithTail(harness, {
        rowCount: 40,
        tailFromOrdinal: 37,
        tailMessages: [37, 38, 39].map((ordinal) =>
          windowedUserMessage(
            owner,
            `tail-${ordinal}`,
            ordinal,
            `tail ${ordinal}`,
          ),
        ),
        tailRowIds: ["tail-37", "tail-38", "tail-39"],
        transcriptEpoch: 1,
        visible: { fromOrdinal: 39, toOrdinal: 40 },
      });
      const reportThrough =
        harness.handle.store.getState().reportVisibleTranscriptRange;
      harness.handle.store.setState({
        reportVisibleTranscriptRange: (range) => {
          reports.push(range);
          reportThrough(range);
        },
      });
      mocks.handle = harness.handle;

      // The ordinary folded card draws ordinal 39 alone: it reports exactly
      // that row and asks the host for nothing.
      const view = render(transcript(FOLD));
      expect(reports.at(-1)).toEqual({ fromOrdinal: 39, toOrdinal: 40 });
      expect(harness.rangeRequests).toEqual([]);
      const tailReport = reports.at(-1);

      // Hydrate ordinal 5 through the real hold and the real range answer
      // (the requested ordinal, with a row id equal to the message's id), then
      // let that hold go so only the raised row can keep the body.
      releaseHydration = harness.handle.store
        .getState()
        .holdTranscriptOrdinal(5);
      expect(harness.rangeRequests).toHaveLength(1);
      const [request] = harness.rangeRequests;
      expect(request).toMatchObject({ fromOrdinal: 5, toOrdinal: 5 });
      harness.callbacks().onRange({
        kind: "range",
        hasBinaryPayload: false,
        epicId: WINDOW_IDENTITY.epicId,
        chatId: WINDOW_IDENTITY.chatId,
        range: {
          requestId: request.requestId,
          epoch: 1,
          fromOrdinal: 5,
          rowIds: ["held"],
          messages: [windowedUserMessage(owner, "held", 5, "held text")],
          events: [],
          rowContext: {},
          reachedStart: false,
          reachedEnd: false,
        },
      });
      releaseHydration();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([]);

      // Unfolded, the held row is drawn among placeholders: raise it there.
      view.rerender(transcript(null));
      expect(screen.getByText("held text")).toBeTruthy();
      raiseRowOf("held");
      const reportsBeforeFold = reports.length;
      view.rerender(transcript(FOLD));

      // Folded again: the report is the tail's, exactly as before, so the
      // raised row earned no read credit.
      expect(reports.length).toBeGreaterThan(reportsBeforeFold);
      expect(reports.at(-1)).toEqual(tailReport);
      expect(screen.getByText("held text")).toBeTruthy();
      // The raised row is held by the transcript owner, not by a viewport move.
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([5]);

      // A new tail larger than the whole budget replaces the window.
      primeWindowWithTail(harness, {
        rowCount: 41,
        tailFromOrdinal: 38,
        tailMessages: [
          windowedUserMessage(owner, "tail-38", 38, "tail 38"),
          windowedUserMessage(owner, "tail-39", 39, "tail 39"),
          windowedUserMessage(
            owner,
            "huge",
            40,
            "x".repeat(TRANSCRIPT_WINDOW_MAX_BYTES + 1024),
          ),
        ],
        tailRowIds: ["tail-38", "tail-39", "huge"],
        transcriptEpoch: 1,
        visible: { fromOrdinal: 40, toOrdinal: 41 },
      });
      expect(screen.getByText("held text")).toBeTruthy();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([5]);
    } finally {
      for (const claim of claims.splice(0)) releaseFullscreen(claim);
      releaseHydration();
      cleanup();
      harness.handle.dispose();
    }
  });
});

/**
 * The real window with ordinal 5 hydrated and then raised through the fold:
 * the state the lifecycle cases below start from. The temporary hold that
 * hydrated it is released, so only the raised row holds the ordinal.
 */
function raiseHydratedRow(harness: Harness): {
  readonly view: RenderResult;
  readonly claim: FullscreenClaim;
} {
  const owner = WINDOW_IDENTITY.ownerId;
  primeWindowWithTail(harness, {
    rowCount: 40,
    tailFromOrdinal: 37,
    tailMessages: [37, 38, 39].map((ordinal) =>
      windowedUserMessage(owner, `tail-${ordinal}`, ordinal, `tail ${ordinal}`),
    ),
    tailRowIds: ["tail-37", "tail-38", "tail-39"],
    transcriptEpoch: 1,
    visible: { fromOrdinal: 39, toOrdinal: 40 },
  });
  mocks.handle = harness.handle;
  const view = render(transcript(FOLD));
  const release = harness.handle.store.getState().holdTranscriptOrdinal(5);
  const [request] = harness.rangeRequests;
  harness.callbacks().onRange({
    kind: "range",
    hasBinaryPayload: false,
    epicId: WINDOW_IDENTITY.epicId,
    chatId: WINDOW_IDENTITY.chatId,
    range: {
      requestId: request.requestId,
      epoch: 1,
      fromOrdinal: 5,
      rowIds: ["held"],
      messages: [windowedUserMessage(owner, "held", 5, "held text")],
      events: [],
      rowContext: {},
      reachedStart: false,
      reachedEnd: false,
    },
  });
  release();
  view.rerender(transcript(null));
  const claim = raiseRowOf("held");
  view.rerender(transcript(FOLD));
  expect(harness.handle.store.getState().heldReadOrdinals).toEqual([5]);
  return { view, claim };
}

describe("a raised row's hold over the real transcript owner", () => {
  let previousAuth: AuthState;

  beforeEach(() => {
    previousAuth = useAuthStore.getState();
    useAuthStore.setState({
      profile: {
        userId: "viewer-a",
        userName: "Viewer A",
        email: "a@example.com",
        avatarUrl: null,
      },
    });
  });

  afterEach(() => {
    useAuthStore.setState(previousAuth, true);
  });

  it("lowering the row lets go of the ordinal and the folded row leaves", () => {
    const harness = createHarness(WINDOW_IDENTITY);
    try {
      const { claim } = raiseHydratedRow(harness);
      expect(rowIds()).toContain("held");

      act(() => releaseFullscreen(claim));

      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([]);
      expect(rowIds()).not.toContain("held");
    } finally {
      for (const each of claims.splice(0)) releaseFullscreen(each);
      cleanup();
      harness.handle.dispose();
    }
  });

  it("a new session over the same chat holds nothing, and the old release is harmless", () => {
    const first = createHarness(WINDOW_IDENTITY);
    let second: Harness | null = null;
    try {
      raiseHydratedRow(first);

      cleanup();
      expect(first.handle.store.getState().heldReadOrdinals).toEqual([]);
      first.handle.dispose();

      second = createHarness(WINDOW_IDENTITY);
      primeWindowWithTail(second, {
        rowCount: 40,
        tailFromOrdinal: 37,
        tailMessages: [37, 38, 39].map((ordinal) =>
          windowedUserMessage(
            WINDOW_IDENTITY.ownerId,
            `tail-${ordinal}`,
            ordinal,
            `tail ${ordinal}`,
          ),
        ),
        tailRowIds: ["tail-37", "tail-38", "tail-39"],
        transcriptEpoch: 1,
        visible: { fromOrdinal: 39, toOrdinal: 40 },
      });
      mocks.handle = second.handle;
      render(transcript(FOLD));

      expect(second.handle.store.getState().heldReadOrdinals).toEqual([]);
      expect(() => {
        for (const each of claims.splice(0)) releaseFullscreen(each);
      }).not.toThrow();
    } finally {
      for (const each of claims.splice(0)) releaseFullscreen(each);
      cleanup();
      first.handle.dispose();
      second?.handle.dispose();
    }
  });

  it("a new transcript epoch lowers the raised row and lets go of the ordinal", () => {
    const harness = createHarness(WINDOW_IDENTITY);
    try {
      const { claim } = raiseHydratedRow(harness);
      expect(claim.exit).not.toHaveBeenCalled();

      // The host rebased the chat: a windowed snapshot of epoch 2, the same
      // rows under a coordinate space this card's raised row no longer names.
      act(() => {
        primeWindowWithTail(harness, {
          rowCount: 40,
          tailFromOrdinal: 37,
          tailMessages: [37, 38, 39].map((ordinal) =>
            windowedUserMessage(
              WINDOW_IDENTITY.ownerId,
              `tail-${ordinal}`,
              ordinal,
              `tail ${ordinal}`,
            ),
          ),
          tailRowIds: ["tail-37", "tail-38", "tail-39"],
          transcriptEpoch: 2,
          visible: { fromOrdinal: 39, toOrdinal: 40 },
        });
      });

      expect(claim.exit).toHaveBeenCalled();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([]);
    } finally {
      for (const each of claims.splice(0)) releaseFullscreen(each);
      cleanup();
      harness.handle.dispose();
    }
  });

  it("another account's card lowers the raised row and lets go of the ordinal", () => {
    const harness = createHarness(WINDOW_IDENTITY);
    try {
      const { claim } = raiseHydratedRow(harness);
      expect(claim.exit).not.toHaveBeenCalled();

      act(() => {
        useAuthStore.setState({
          profile: {
            userId: "viewer-b",
            userName: "Viewer B",
            email: "b@example.com",
            avatarUrl: null,
          },
        });
      });

      expect(claim.exit).toHaveBeenCalled();
      expect(harness.handle.store.getState().heldReadOrdinals).toEqual([]);
    } finally {
      for (const each of claims.splice(0)) releaseFullscreen(each);
      cleanup();
      harness.handle.dispose();
    }
  });
});
