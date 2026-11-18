/**
 * A transcript asked to land on a message it has not hydrated asks the host
 * where the row is. Drives the REAL `BotChatTranscript` into the REAL
 * `ChatMessages` over the REAL `useChatLocateRowAnswer`: only the
 * `chat.locateRow` answer is scripted, beneath the hook, so how the hook
 * classifies a miss, an unsupported host and a failure is what is exercised.
 * A landing that reports a miss says so once the host has no row for it;
 * every other landing waits quietly as it always has.
 */
import { StrictMode, useEffect, type ReactNode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  matchQuery,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import type { StoreApi, UseBoundStore } from "zustand";
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
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
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

/** A message the transcript has not hydrated: the second of the conversation's two. */
const TARGET = "other-1";
const WINDOW_EPOCH = 0;
const FOUND_ROW: ChatLocateRowResponse = {
  found: true,
  ordinal: 5,
  epoch: WINDOW_EPOCH,
};
const ABSENT_ROW: ChatLocateRowResponse = { found: false };

let requestTranscriptOrdinal: Mock<(ordinal: number | null) => void>;
let store: UseBoundStore<StoreApi<LandingState>>;
let landing: MissLanding | null = null;
let paneVisible = true;
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

function mountTranscript(): { readonly rerender: () => void } {
  store = createLandingStore([resolvedUserMessage()], requestTranscriptOrdinal);
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
      <QueryClientProvider client={queryClient}>
        <PaneVisibilityContext.Provider value={paneVisible}>
          <BotTestRunnerHost>
            <BotChatTranscript
              botId={BOT_ID}
              chatId={CHAT_ID}
              hostId="host-1"
              title="Release Bot"
              instanceId="bot-thread:test"
              surface={THREAD_SURFACE}
              resolveMember={UNRESOLVED_BOT_MEMBERS}
              showConnecting
              header={null}
              landOn={landing}
              flow={null}
              sendBinding={null}
            />
          </BotTestRunnerHost>
        </PaneVisibilityContext.Provider>
      </QueryClientProvider>
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

describe("a landing that reports a miss, while its locate is held", () => {
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
