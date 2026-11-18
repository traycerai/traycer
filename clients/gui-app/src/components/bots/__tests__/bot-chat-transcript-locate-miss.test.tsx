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
            "locate-row",
            args.method,
            JSON.stringify(args.params),
            args.cacheKeyIdentity ?? null,
          ],
          queryFn: () => {
            mocks.asked += 1;
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

let requestTranscriptOrdinal: Mock<(ordinal: number | null) => void>;
let store: UseBoundStore<StoreApi<LandingState>>;
let landing: MissLanding | null = null;
let paneVisible = true;
let queryClient = new QueryClient();
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

function flashing(messageId: string): boolean {
  const row = document.querySelector<HTMLElement>(
    `[data-message-id="${messageId}"]`,
  );
  return row !== null && row.dataset.navigationHighlighted === "true";
}

/**
 * The host's read has ended and no other is in flight: the locate read is the
 * only one this client ever runs.
 */
async function readEnded(): Promise<void> {
  await waitFor(() => {
    expect(locateReadsEnded).toBeGreaterThan(0);
    expect(queryClient.isFetching()).toBe(0);
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
      expect(ordinalsRequested()).toEqual([]);

      carryTheRow();
      await settleLegendList();

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

    await waitFor(() => {
      expect(flashing("ask-1")).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("a landing that reports a miss, while its locate is held", () => {
  function holdLocate(): { readonly release: () => void } {
    let release: () => void = () => undefined;
    const held = new Promise<ChatLocateRowResponse>((resolve) => {
      release = () => resolve({ found: true, ordinal: 5, epoch: WINDOW_EPOCH });
    });
    mocks.locate = () => held;
    return { release };
  }

  async function landAndHold(): Promise<{
    readonly view: { readonly rerender: () => void };
    readonly release: () => void;
  }> {
    const held = holdLocate();
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
    const held = holdLocate();
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

  it.each([
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
  ])(
    "requests no ordinal, lands nothing and says nothing when the host answers after %s",
    async (_name, depart) => {
      const held = await landAndHold();

      depart(held.view);
      held.release();
      await answeredAfterDeparture(held.view);
      carryTheRow();
      await settleLegendList();

      expect(ordinalsRequested()).toEqual([]);
      expect(flashing(TARGET)).toBe(false);
      expect(toast.error).not.toHaveBeenCalled();
    },
  );
});
