/**
 * A transcript asked to land on a message it has not hydrated asks the host
 * where the row is. Drives the REAL `BotChatTranscript` into the REAL
 * `ChatMessages` over the REAL `useChatLocateRowAnswer`: only the
 * `chat.locateRow` answer is scripted, beneath the hook, so how the hook
 * classifies a miss, an unsupported host and a failure is what is exercised.
 * A landing that reports a miss says so once the host has no row for it;
 * every other landing waits quietly as it always has. The same harness holds
 * what a pending jump does when the reader moves the list, when its row does
 * not arrive within the bound, and when its landing is withdrawn as the row
 * arrives.
 */
import {
  StrictMode,
  useContext,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  matchQuery,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";
import type { ChatLocateRowResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { BotReadCursorReadResponse } from "@traycer/protocol/host/bot/schemas";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  BOT_ID,
  CHAT_ID,
  createLandingStore,
  otherUserMessage,
  resolvedUserMessage,
  type LandingState,
} from "@/components/bots/__tests__/bot-chat-transcript-landing-support";

const mocks = vi.hoisted(() => ({
  handle: null as ChatSessionStoreHandle | null,
  /** What `chat.locateRow` answers, per ask. */
  locate: null as (() => Promise<ChatLocateRowResponse>) | null,
  asked: 0,
  /** The first part of every `chat.locateRow` query key, which scopes what the helpers wait on. */
  locateRowKey: "locate-row",
  /** The params of each `chat.locateRow` read, in the order they were asked. */
  locateParams: [] as object[],
  /** Renders of the hook's host that have committed, whichever read they carry. */
  commits: 0,
  /** What the unread boundary reads of the bot's read cursors; `undefined` where the host keeps none. */
  readCursors: undefined as BotReadCursorReadResponse | undefined,
  /** Run by a passive effect the reading component declares after the unread boundary's own. */
  atEffects: null as (() => void) | null,
  /** The commit count when the transcript first rendered with a settled `chat.locateRow` read (success or error, nothing in flight). */
  settledAt: null as number | null,
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
vi.mock("@/hooks/bots/use-bot-read-cursor", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/bots/use-bot-read-cursor")
  >()),
  useBotReadCursors: () =>
    mocks.readCursors === undefined ? null : { data: mocks.readCursors },
}));
// The reading component calls this hook after the unread boundary's: its
// effect, added here, runs after the boundary's in the same flush.
vi.mock(
  "@/hooks/bots/use-bot-mark-represented-read",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/bots/use-bot-mark-represented-read")
      >();
    const { useEffect: useProbeEffect } = await import("react");
    return {
      ...actual,
      useBotMarkRepresentedRead: (
        ...args: Parameters<typeof actual.useBotMarkRepresentedRead>
      ) => {
        const result = actual.useBotMarkRepresentedRead(...args);
        useProbeEffect(() => {
          mocks.atEffects?.();
        });
        return result;
      },
    };
  },
);
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
/** The part of `useHostQuery`'s arguments the scripted query reads. */
interface LocateQueryArgs {
  readonly method: string;
  readonly params: object;
  readonly cacheKeyIdentity: ReadonlyArray<unknown> | undefined;
  readonly options: { readonly enabled: boolean | undefined } | null;
}

// The RPC layer beneath `useChatLocateRowAnswer`: the query is the real
// TanStack one, answering from the script a case holds.
vi.mock("@/hooks/host/use-host-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/host/use-host-query")>();
  return {
    ...actual,
    useHostQuery: (args: LocateQueryArgs) => {
      const result = useQuery(
        queryOptions<ChatLocateRowResponse, HostRpcError>({
          queryKey: [
            mocks.locateRowKey,
            args.method,
            JSON.stringify(args.params),
            args.cacheKeyIdentity ?? null,
          ],
          queryFn: () => {
            mocks.asked += 1;
            mocks.locateParams.push(args.params);
            if (mocks.locate === null) throw new Error("no locate scripted");
            return mocks.locate();
          },
          // Only `chat.locateRow` is scripted; any other read stays idle.
          enabled:
            args.method === "chat.locateRow" && (args.options?.enabled ?? true),
          staleTime: 0,
          gcTime: 0,
          retry: false,
        }),
      );
      // The transcript acts on a settled read while it renders, and may end its
      // jump there, so the settled state is recorded as rendered; the commit
      // count is taken after commit.
      if (
        args.method === "chat.locateRow" &&
        result.status !== "pending" &&
        result.fetchStatus === "idle" &&
        mocks.settledAt === null
      ) {
        mocks.settledAt = mocks.commits;
      }
      useEffect(() => {
        mocks.commits += 1;
      });
      return result;
    },
  };
});
import {
  BotChatTranscript,
  type BotTranscriptLanding,
  type BotTranscriptSurface,
} from "@/components/bots/bot-chat-transcript";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { ChatBotRepliesContext } from "@/components/chat/chat-bot-presentation-context";
import { TRANSCRIPT_JUMP_TTL_MS } from "@/components/epic-canvas/renderers/chat-tile-jump-logic";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";

/** A landing that says whether the host's having no row for it is reported. */
interface MissLanding extends BotTranscriptLanding {
  readonly reportsMiss: boolean;
}

const THREAD_SURFACE: BotTranscriptSurface = {
  kind: "thread",
  chooseOption: vi.fn(),
  reply: null,
  answerQuestion: null,
  answerQuestions: null,
  questionBox: "post-1",
  failedRequest: () => null,
  openTurn: null,
  sessionChatId: null,
  opening: { messageId: "post-1", conversationId: "channel-1", show: vi.fn() },
};

/** The channel's own surface, whose unread banner is the control that navigates to the unread boundary. */
const CHANNEL_SURFACE: BotTranscriptSurface = {
  kind: "channel",
  threadLine: () => null,
  openThread: null,
  openAnnouncementThread: null,
  threadAnchorKinds: [],
  chooseOption: null,
  reply: null,
  answerQuestion: null,
  answerQuestions: null,
  questionBox: null,
  failedRequest: () => null,
  openTurn: null,
  sessionChatId: null,
  intro: { botTitle: "Release Bot", directive: null },
  history: null,
};

/** A message the transcript has not hydrated: the second of the conversation's two. */
const TARGET = "other-1";
const WINDOW_EPOCH = 0;
const FOUND_ORDINAL = 5;
const FOUND_ROW: ChatLocateRowResponse = {
  found: true,
  ordinal: FOUND_ORDINAL,
  epoch: WINDOW_EPOCH,
};
const ABSENT_ROW: ChatLocateRowResponse = { found: false };

let requestTranscriptOrdinal: Mock<(ordinal: number | null) => void>;
/** What the transcript reads of a session that is open: the landing store's state, and no fatal close. */
type ReadingState = LandingState & Pick<ChatSessionState, "fatalClose">;
let store: UseBoundStore<StoreApi<ReadingState>>;
let landing: MissLanding | null = null;
let paneVisible = true;
let surfaceUnderTest: BotTranscriptSurface = THREAD_SURFACE;
/** What the next mount draws above the list, inside the transcript's own replies context. */
let listHeader: ReactNode = null;
let queryClient = new QueryClient();
/** Every `chat.locateRow` query, whatever its params: what the helpers wait on. */
const locateReads = queryOptions({ queryKey: [mocks.locateRowKey] });
/** Reads of the locate entry that have ended, in success or in error. */
let locateReadsEnded = 0;

function landingOf(
  messageId: string,
  input: { readonly reportsMiss: boolean; readonly sendPostId: string | null },
): MissLanding {
  return { messageId, visit: 1, ...input };
}

/**
 * Runs `atCommit` in the layout phase of every commit of the tree it wraps,
 * after the transcript's own layout effects and after every layout cleanup of
 * that commit, and before any passive cleanup: the place a timer due "now"
 * is put to fall inside a commit. A real timer cannot fire inside a commit;
 * in a browser the same gap is a commit that is not sync-lane, whose passive
 * effects wait for a later task.
 */
let atCommit: (() => void) | null = null;
function AtCommit(props: { readonly children: ReactNode }): ReactNode {
  useLayoutEffect(() => {
    atCommit?.();
  });
  return props.children;
}

/** Fires `deadline` once, in the passive flush of the next commit of the reading component, after the unread boundary's effect. */
function atTheNextEffects(deadline: () => void): void {
  mocks.atEffects = () => {
    mocks.atEffects = null;
    deadline();
  };
}

/** Fires `deadline` once, in the layout phase of the next commit. */
function atTheNextCommit(deadline: () => void): void {
  atCommit = () => {
    atCommit = null;
    deadline();
  };
}

function mountTranscript(): { readonly rerender: () => void } {
  store = create<ReadingState>()(() => ({
    ...createLandingStore(
      [resolvedUserMessage()],
      requestTranscriptOrdinal,
    ).getState(),
    fatalClose: null,
  }));
  mocks.handle = { store } as ChatSessionStoreHandle;
  queryClient = new QueryClient();
  queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      matchQuery(locateReads, event.query) &&
      (event.action.type === "success" || event.action.type === "error")
    ) {
      locateReadsEnded += 1;
    }
  });
  const tree = (): ReactNode => (
    <StrictMode>
      <AtCommit>
        <QueryClientProvider client={queryClient}>
          <PaneVisibilityContext.Provider value={paneVisible}>
            <BotTestRunnerHost>
              <BotChatTranscript
                botId={BOT_ID}
                chatId={CHAT_ID}
                hostId="host-1"
                boundHostId={null}
                title="Release Bot"
                instanceId="bot-thread:test"
                surface={surfaceUnderTest}
                resolveMember={UNRESOLVED_BOT_MEMBERS}
                showConnecting
                header={listHeader}
                landOn={landing}
                flow={null}
              />
            </BotTestRunnerHost>
          </PaneVisibilityContext.Provider>
        </QueryClientProvider>
      </AtCommit>
    </StrictMode>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

/** The transcript now carries the row the landing names. */
function carryTheRow(): void {
  act(() => {
    store.setState({
      messages: [resolvedUserMessage(), otherUserMessage()],
    });
  });
}

function ordinalsRequested(): ReadonlyArray<number> {
  return requestTranscriptOrdinal.mock.calls.flatMap(([ordinal]) =>
    ordinal === null ? [] : [ordinal],
  );
}

function isRendered(messageId: string): boolean {
  return document.querySelector(`[data-message-id="${messageId}"]`) !== null;
}

function flashing(messageId: string): boolean {
  const row = document.querySelector<HTMLElement>(
    `[data-message-id="${messageId}"]`,
  );
  return row !== null && row.dataset.navigationHighlighted === "true";
}

/**
 * A locate read has ended and none is in flight. Only locate queries are
 * counted, so any other read on the client neither satisfies nor delays this.
 */
async function readEnded(): Promise<void> {
  await waitFor(() => {
    expect(locateReadsEnded).toBeGreaterThan(0);
    expect(queryClient.isFetching(locateReads)).toBe(0);
  });
}

/**
 * The host has answered and the transcript has acted on that settled answer:
 * the read has ended, the transcript rendered with its success or its error,
 * and a commit followed that render.
 */
async function answered(): Promise<void> {
  await readEnded();
  await waitFor(() => {
    expect(mocks.settledAt).not.toBeNull();
  });
  const settledAt = mocks.settledAt ?? 0;
  await waitFor(() => {
    expect(mocks.commits).toBeGreaterThan(settledAt);
  });
  await settleLegendList();
}

/**
 * The host has answered a read the landing had already left (the query may be
 * disabled or gone from the cache by now): the read has ended, and a render
 * committed after it, so nothing the answer could cause is still pending.
 */
async function answeredAfterDeparture(view: {
  readonly rerender: () => void;
}): Promise<void> {
  await readEnded();
  const before = mocks.commits;
  act(() => {
    view.rerender();
  });
  await waitFor(() => {
    expect(mocks.commits).toBeGreaterThan(before);
  });
  await settleLegendList();
}

function unsupportedHost(): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "the host does not locate rows",
    requestId: "request-1",
    method: "chat.locateRow",
    fatalDetails: null,
  });
}

function failedHost(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "the host did not answer",
    requestId: "request-1",
    method: "chat.locateRow",
    fatalDetails: null,
  });
}

beforeEach(() => {
  installLegendListTestClock();
  vi.clearAllMocks();
  installLegendListViewportMetrics();
  landing = null;
  paneVisible = true;
  listHeader = null;
  atCommit = null;
  mocks.atEffects = null;
  surfaceUnderTest = THREAD_SURFACE;
  mocks.readCursors = undefined;
  mocks.asked = 0;
  mocks.locateParams = [];
  mocks.commits = 0;
  mocks.settledAt = null;
  mocks.locate = null;
  locateReadsEnded = 0;
  requestTranscriptOrdinal = vi.fn<(ordinal: number | null) => void>();
  const toastError = vi.spyOn(toast, "error").mockReturnValue("toast");
  onTestFinished(() => toastError.mockRestore());
});

afterEach(() => {
  cleanup();
  mocks.handle = null;
});

describe("a landing that reports a miss, on a message the transcript has not hydrated", () => {
  it.each([
    [
      "answers that it has no such row",
      () => Promise.resolve({ found: false } as const),
    ],
    ["fails with an ordinary error", () => Promise.reject(failedHost())],
  ])(
    "says so once, requests no ordinal and lands nothing when the host %s, even once the row renders",
    async (_name, script) => {
      mocks.locate = script;
      const view = mountTranscript();
      await settleLegendList();
      landing = landingOf(TARGET, { reportsMiss: true, sendPostId: null });
      view.rerender();
      await answered();

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledTimes(1);
      });
      expect(mocks.locateParams).toEqual([
        expect.objectContaining({
          chatId: CHAT_ID,
          target: { kind: "message", messageId: TARGET },
        }),
      ]);
      expect(ordinalsRequested()).toEqual([]);

      carryTheRow();
      await settleLegendList();
      await waitFor(() => {
        expect(isRendered(TARGET)).toBe(true);
      });

      expect(flashing(TARGET)).toBe(false);
      expect(ordinalsRequested()).toEqual([]);
      expect(toast.error).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps waiting, quietly, when the host does not locate rows, and lands on the exact row once the transcript carries it", async () => {
    mocks.locate = () => Promise.reject(unsupportedHost());
    const view = mountTranscript();
    await settleLegendList();
    landing = landingOf(TARGET, { reportsMiss: true, sendPostId: null });
    view.rerender();
    await answered();

    expect(toast.error).not.toHaveBeenCalled();
    expect(ordinalsRequested()).toEqual([]);

    carryTheRow();
    await settleLegendList();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("requests the host's ordinal when it is numbered in the window's epoch, then lands on the exact row once it hydrates", async () => {
    mocks.locate = () =>
      Promise.resolve({ found: true, ordinal: 5, epoch: WINDOW_EPOCH });
    const view = mountTranscript();
    await settleLegendList();
    landing = landingOf(TARGET, { reportsMiss: true, sendPostId: null });
    view.rerender();
    await answered();

    expect(mocks.locateParams).toEqual([
      expect.objectContaining({
        chatId: CHAT_ID,
        target: { kind: "message", messageId: TARGET },
      }),
    ]);
    expect(ordinalsRequested()).toEqual([5]);
    expect(toast.error).not.toHaveBeenCalled();

    carryTheRow();
    await settleLegendList();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("requests nothing and says nothing for an ordinal numbered in another epoch", async () => {
    mocks.locate = () =>
      Promise.resolve({ found: true, ordinal: 5, epoch: WINDOW_EPOCH + 1 });
    const view = mountTranscript();
    await settleLegendList();
    landing = landingOf(TARGET, { reportsMiss: true, sendPostId: null });
    view.rerender();
    await answered();

    expect(ordinalsRequested()).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("a landing that does not report a miss", () => {
  it("says nothing when the host has no such row, as it always has", async () => {
    mocks.locate = () => Promise.resolve({ found: false });
    const view = mountTranscript();
    await settleLegendList();
    landing = landingOf(TARGET, { reportsMiss: false, sendPostId: null });
    view.rerender();
    await answered();

    expect(toast.error).not.toHaveBeenCalled();
    expect(ordinalsRequested()).toEqual([]);
  });

  it("falls back to the message when the card of the send that wrote a post is missing, saying nothing", async () => {
    mocks.locate = () => Promise.resolve({ found: false });
    const view = mountTranscript();
    await settleLegendList();
    landing = landingOf("ask-1", {
      reportsMiss: false,
      sendPostId: "post-without-a-card",
    });
    view.rerender();
    await answered();

    // The card of the send is asked for first, by the post that wrote it.
    expect(mocks.locateParams[0]).toEqual(
      expect.objectContaining({
        chatId: CHAT_ID,
        target: { kind: "receipt", messageId: "post-without-a-card" },
      }),
    );
    await waitFor(() => {
      expect(flashing("ask-1")).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});

/** The host's answer is held until `release`, however the transcript has moved meanwhile. */
function holdLocate(response: ChatLocateRowResponse): {
  readonly release: () => void;
} {
  let release: () => void = () => undefined;
  const held = new Promise<ChatLocateRowResponse>((resolve) => {
    release = () => resolve(response);
  });
  mocks.locate = () => held;
  return { release };
}

describe("a landing that reports a miss, while its locate is held", () => {
  async function landAndHold(response: ChatLocateRowResponse): Promise<{
    readonly view: { readonly rerender: () => void };
    readonly release: () => void;
  }> {
    const held = holdLocate(response);
    const view = mountTranscript();
    await settleLegendList();
    landing = landingOf(TARGET, { reportsMiss: true, sendPostId: null });
    view.rerender();
    await waitFor(() => {
      expect(mocks.asked).toBeGreaterThan(0);
    });
    return { view, release: held.release };
  }

  it("waits for the pane to show when the landing arrives while it is hidden, then requests the ordinal and lands on the exact row", async () => {
    paneVisible = false;
    const held = holdLocate(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    landing = landingOf(TARGET, { reportsMiss: true, sendPostId: null });
    view.rerender();
    await waitFor(() => {
      expect(mocks.asked).toBeGreaterThan(0);
    });

    paneVisible = true;
    view.rerender();
    held.release();
    await waitFor(() => {
      expect(ordinalsRequested()).toEqual([5]);
    });

    carryTheRow();
    await settleLegendList();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  /** The pane shows again, with no new landing, and the transcript has rendered with it. */
  async function paneShownAgain(view: {
    readonly rerender: () => void;
  }): Promise<void> {
    paneVisible = true;
    const before = mocks.commits;
    act(() => {
      view.rerender();
    });
    await waitFor(() => {
      expect(mocks.commits).toBeGreaterThan(before);
    });
    await settleLegendList();
  }

  const DEPARTURES = [
    [
      "the landing is withdrawn",
      (view: { readonly rerender: () => void }) => {
        landing = null;
        view.rerender();
      },
    ],
    [
      "the pane leaves view",
      (view: { readonly rerender: () => void }) => {
        paneVisible = false;
        view.rerender();
      },
    ],
  ] as const;

  it.each(DEPARTURES)(
    "requests no ordinal and lands nothing when the host answers a found row after %s",
    async (_name, depart) => {
      const held = await landAndHold(FOUND_ROW);

      depart(held.view);
      held.release();
      await answeredAfterDeparture(held.view);
      carryTheRow();
      await paneShownAgain(held.view);
      await waitFor(() => {
        expect(isRendered(TARGET)).toBe(true);
      });

      expect(ordinalsRequested()).toEqual([]);
      expect(flashing(TARGET)).toBe(false);
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it.each(DEPARTURES)(
    "says nothing, now or when the pane shows again, when the host answers that it has no such row after %s",
    async (_name, depart) => {
      const held = await landAndHold(ABSENT_ROW);

      depart(held.view);
      held.release();
      await answeredAfterDeparture(held.view);
      expect(toast.error).not.toHaveBeenCalled();

      await paneShownAgain(held.view);
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("waits for the pane when the host answers that it has no such row while the pane has not yet shown, then says so once when it shows", async () => {
    paneVisible = false;
    const held = holdLocate(ABSENT_ROW);
    const view = mountTranscript();
    await settleLegendList();
    landing = landingOf(TARGET, { reportsMiss: true, sendPostId: null });
    view.rerender();
    await waitFor(() => {
      expect(mocks.asked).toBeGreaterThan(0);
    });

    held.release();
    await answeredAfterDeparture(view);
    expect(toast.error).not.toHaveBeenCalled();

    await paneShownAgain(view);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * The "in reply to" line of a reply opens its message through the list's own
 * replies context; this stands in for the line, whose own button stays
 * disabled until the message it names is in the session, which is exactly
 * when there is nothing to wait for.
 */
function InReplyToOpener(): ReactNode {
  const replies = useContext(ChatBotRepliesContext);
  return (
    <button
      type="button"
      data-testid="open-in-reply"
      onClick={() => {
        if (replies !== null && replies.open !== null) replies.open(TARGET);
      }}
    >
      in reply to
    </button>
  );
}

/** When the jump under test was asked (or, for a hidden pane, when the pane showed it): the clock the bound is measured from. */
let jumpAskedAt = 0;

function askNotification(view: { readonly rerender: () => void }): void {
  landing = landingOf(TARGET, { reportsMiss: true, sendPostId: null });
  jumpAskedAt = Date.now();
  view.rerender();
}

function askInReplyTo(): void {
  jumpAskedAt = Date.now();
  act(() => {
    fireEvent.click(screen.getByTestId("open-in-reply"));
  });
}

/** Moves the fake clock to `ageMs` after the jump was asked, flushing what falls due. */
async function advanceToJumpAge(ageMs: number): Promise<void> {
  const remaining = ageMs - (Date.now() - jumpAskedAt);
  if (remaining < 0) throw new Error("the clock is already past that age");
  await vi.advanceTimersByTimeAsync(remaining);
}

/** The reader moves the list: a press on the scroller itself, which the list reads as the scrollbar. */
function readerMovesTheList(): void {
  act(() => {
    fireEvent.pointerDown(screen.getByTestId("chat-messages-scroll"));
  });
}

/** The row the jump names reaches the store, and the list has drawn it. */
async function rowArrives(): Promise<void> {
  carryTheRow();
  await settleLegendList();
  await waitFor(() => {
    expect(isRendered(TARGET)).toBe(true);
  });
}

/** The ordinal the store was last asked to hold; `null` once it was released. */
function lastOrdinalRequested(): number | null | undefined {
  return requestTranscriptOrdinal.mock.calls.at(-1)?.[0];
}

describe("a pending jump the reader moves away from", () => {
  it("is dropped by a notification's jump, and the row arriving afterwards is not scrolled to or said anything of", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();
    expect(lastOrdinalRequested()).toBe(FOUND_ORDINAL);

    readerMovesTheList();
    expect(lastOrdinalRequested()).toBeNull();
    await rowArrives();

    expect(flashing(TARGET)).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('is dropped by an "in reply to" open, and the row arriving afterwards is not scrolled to', async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    listHeader = <InReplyToOpener />;
    mountTranscript();
    await settleLegendList();
    askInReplyTo();
    await answered();
    expect(lastOrdinalRequested()).toBe(FOUND_ORDINAL);

    readerMovesTheList();
    expect(lastOrdinalRequested()).toBeNull();
    await rowArrives();

    expect(flashing(TARGET)).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("is kept by a press on a message, and lands when its row arrives", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();

    const row = document.querySelector<HTMLElement>(
      `[data-message-id="${resolvedUserMessage().messageId}"]`,
    );
    if (row === null) throw new Error("the transcript drew no message");
    act(() => {
      fireEvent.pointerDown(row);
    });
    await rowArrives();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
  });

  it("is not dropped by a movement that came before it was asked", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    readerMovesTheList();
    askNotification(view);
    await answered();
    await rowArrives();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
  });

  it("is followed by a new landing on the same message, which lands", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();
    readerMovesTheList();

    landing = {
      ...landingOf(TARGET, { reportsMiss: true, sendPostId: null }),
      visit: 2,
    };
    view.rerender();
    await waitFor(() => {
      expect(ordinalsRequested()).toEqual([FOUND_ORDINAL, FOUND_ORDINAL]);
    });
    await rowArrives();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
  });

  it("says nothing when the host answers that it has no such row after the notification's jump was dropped", async () => {
    const held = holdLocate(ABSENT_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await waitFor(() => {
      expect(mocks.asked).toBeGreaterThan(0);
    });

    readerMovesTheList();
    held.release();
    await answeredAfterDeparture(view);

    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("a pending jump that waits for its row beyond the bound", () => {
  it("is given up by a notification's jump at the bound, saying so once, and the row arriving afterwards is not scrolled to", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();

    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS - 1);
    expect(toast.error).not.toHaveBeenCalled();
    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS);
    expect(toast.error).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(lastOrdinalRequested()).toBeNull();
    });
    await rowArrives();

    expect(flashing(TARGET)).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('is given up by an "in reply to" open at the bound, silently, and the row arriving afterwards is not scrolled to', async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    listHeader = <InReplyToOpener />;
    mountTranscript();
    await settleLegendList();
    askInReplyTo();
    await answered();

    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS);
    await waitFor(() => {
      expect(lastOrdinalRequested()).toBeNull();
    });
    await rowArrives();

    expect(flashing(TARGET)).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("lands when the row arrives a moment before the bound, saying nothing", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();

    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS - 1);
    await rowArrives();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not count the time its pane is hidden: it keeps waiting, and says so once the bound has passed with the pane in view", async () => {
    paneVisible = false;
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();

    await vi.advanceTimersByTimeAsync(TRANSCRIPT_JUMP_TTL_MS * 2);
    expect(toast.error).not.toHaveBeenCalled();
    expect(lastOrdinalRequested()).toBe(FOUND_ORDINAL);

    paneVisible = true;
    jumpAskedAt = Date.now();
    act(() => {
      view.rerender();
    });
    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS - 1);
    expect(toast.error).not.toHaveBeenCalled();
    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("lands when its row arrives after its pane was hidden for longer than the bound and shown again", async () => {
    paneVisible = false;
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_JUMP_TTL_MS * 2);

    paneVisible = true;
    act(() => {
      view.rerender();
    });
    await rowArrives();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("is given up at the bound by a notification's jump whose locate never answers, saying so once", async () => {
    mocks.locate = () => new Promise<ChatLocateRowResponse>(() => undefined);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await waitFor(() => {
      expect(mocks.asked).toBeGreaterThan(0);
    });

    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS - 1);
    expect(toast.error).not.toHaveBeenCalled();
    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

/**
 * Not shown here: a deadline that falls while a render that ends the jump has
 * started and not committed; nothing outside React can see an uncommitted
 * render. The ends that commit are shown below: the hiding commit with a
 * deadline in its layout phase, and the two ends made in an event, with a
 * deadline in the same dispatch ahead of their commit. A deadline placed in a
 * landing's commit would show neither guard alone: the layout-phase cancel
 * and the ref that commit writes each stop it. The cancellation itself is
 * guarded by the hide cases.
 */

/** After a landing, nothing is said and the store is asked for nothing when the bound's time passes. */
describe("a pending jump that landed before its bound", () => {
  it("says nothing and asks the store for nothing when the bound's time passes", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();
    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS - 1_000);
    await rowArrives();
    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
    await waitFor(() => {
      expect(lastOrdinalRequested()).toBeNull();
    });
    const asks = requestTranscriptOrdinal.mock.calls.length;

    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS + 1_000);

    expect(toast.error).not.toHaveBeenCalled();
    expect(requestTranscriptOrdinal.mock.calls).toHaveLength(asks);
  });
});

describe('an "in reply to" open that was tried in view, and whose pane then leaves it', () => {
  /** Tried in view; the pane then hidden for longer than the bound, and shown again. */
  async function triedThenHiddenThenShown(): Promise<void> {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    listHeader = <InReplyToOpener />;
    const view = mountTranscript();
    await settleLegendList();
    askInReplyTo();
    await answered();

    paneVisible = false;
    act(() => {
      view.rerender();
    });
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_JUMP_TTL_MS * 2);

    paneVisible = true;
    jumpAskedAt = Date.now();
    act(() => {
      view.rerender();
    });
  }

  it("lands when its row arrives after the pane was hidden for longer than the bound and shown again", async () => {
    await triedThenHiddenThenShown();
    await rowArrives();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("has the whole bound once the pane shows again, then ends silently and does not scroll to a late row", async () => {
    await triedThenHiddenThenShown();

    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS - 1);
    expect(lastOrdinalRequested()).toBe(FOUND_ORDINAL);
    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS);
    await waitFor(() => {
      expect(lastOrdinalRequested()).toBeNull();
    });
    await rowArrives();

    expect(flashing(TARGET)).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('an "in reply to" open whose deadline falls inside the commit that hides its pane', () => {
  it("is not ended: it lands when the pane shows again and its row arrives", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    listHeader = <InReplyToOpener />;
    const view = mountTranscript();
    await settleLegendList();
    askInReplyTo();
    await answered();
    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS - 1);

    paneVisible = false;
    atTheNextCommit(() => vi.advanceTimersByTime(1));
    act(() => {
      view.rerender();
    });
    paneVisible = true;
    act(() => {
      view.rerender();
    });
    await rowArrives();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});

/**
 * A jump the reader ends in an event is ended before the render that shows it
 * has committed. A listener on `document` runs after the list's and React's
 * own handlers of the same dispatch and before the commit, so a deadline
 * fired there falls between the end and its commit. It stands in for a wheel,
 * whose render comes a task later.
 */
describe("a pending jump whose deadline falls between an end made in an event and its commit", () => {
  function deadlineAfter(eventType: string): void {
    const fire = (): void => {
      vi.advanceTimersByTime(1);
    };
    document.addEventListener(eventType, fire);
    onTestFinished(() => document.removeEventListener(eventType, fire));
  }

  it("is not said of when the reader's move ended a notification's jump", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();
    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS - 1);

    deadlineAfter("pointerdown");
    readerMovesTheList();
    await rowArrives();

    expect(toast.error).not.toHaveBeenCalled();
    expect(flashing(TARGET)).toBe(false);
  });

  it('does not end the jump a second "in reply to" open replaced it with', async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    listHeader = <InReplyToOpener />;
    mountTranscript();
    await settleLegendList();
    askInReplyTo();
    await answered();
    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS - 1);

    deadlineAfter("click");
    act(() => {
      fireEvent.click(screen.getByTestId("open-in-reply"));
    });
    await rowArrives();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("a notification's pending jump, and a navigation to the unread boundary", () => {
  /** The channel opened with the bot's newest row unread, a notification's jump located and waiting for its row. */
  async function jumpWaitingInAnUnreadChannel(): Promise<void> {
    surfaceUnderTest = CHANNEL_SURFACE;
    mocks.readCursors = {
      cursors: {},
      latest: { [CHAT_ID]: { messageId: "ask-1", seq: 1_000 } },
    };
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();
    expect(lastOrdinalRequested()).toBe(FOUND_ORDINAL);
    await advanceToJumpAge(TRANSCRIPT_JUMP_TTL_MS - 1);
  }

  function pressUnreadBanner(): void {
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Unread messages" }));
    });
  }

  it("ends the jump: the row arriving afterwards is not scrolled to", async () => {
    await jumpWaitingInAnUnreadChannel();

    pressUnreadBanner();
    await waitFor(() => {
      expect(lastOrdinalRequested()).toBeNull();
    });
    await rowArrives();

    expect(flashing(TARGET)).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("is not said of when the bound falls due between the navigation's write and its commit", async () => {
    await jumpWaitingInAnUnreadChannel();

    atTheNextEffects(() => vi.advanceTimersByTime(1));
    pressUnreadBanner();
    await waitFor(() => {
      expect(lastOrdinalRequested()).toBeNull();
    });
    await rowArrives();

    expect(toast.error).not.toHaveBeenCalled();
    expect(flashing(TARGET)).toBe(false);
  });
});

describe("a landing that reports its miss, withdrawn as its row arrives", () => {
  it("is not scrolled to", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    const view = mountTranscript();
    await settleLegendList();
    askNotification(view);
    await answered();

    act(() => {
      landing = null;
      view.rerender();
      store.setState({
        messages: [resolvedUserMessage(), otherUserMessage()],
      });
    });
    await settleLegendList();
    await waitFor(() => {
      expect(isRendered(TARGET)).toBe(true);
    });

    expect(flashing(TARGET)).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('an "in reply to" open, with no landing asked of the transcript', () => {
  it("lands when its row arrives", async () => {
    mocks.locate = () => Promise.resolve(FOUND_ROW);
    listHeader = <InReplyToOpener />;
    mountTranscript();
    await settleLegendList();
    askInReplyTo();
    await answered();
    await rowArrives();

    await waitFor(() => {
      expect(flashing(TARGET)).toBe(true);
    });
  });
});
