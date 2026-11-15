import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { BotReadCursorAdvanceRequest } from "@traycer/protocol/host/bot/schemas";
import { useBotMarkRepresentedRead } from "@/hooks/bots/use-bot-mark-represented-read";
import {
  createReadCursorHostFixture,
  firstAdvanceSettles,
  requestContextOf,
  type ReadCursorHostFixture,
} from "./bot-read-cursor-test-support";

// The banner's cross over a REAL host client and QueryClient: only the host's
// answers are scripted. A person's identity switch goes through the client's
// own `setRequestContext`, which aborts what is in flight for the outgoing
// identity; what the cross had captured for them must not then be sent under
// the next one.

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const mocks = vi.hoisted(() => ({
  fixture: null as ReadCursorHostFixture | null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.fixture?.client ?? null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));

const THREAD_ONE: BotReadCursorAdvanceRequest = {
  botId: BOT_ID,
  conversationId: "thread-1",
  messageId: "t1-r2",
  seq: 2_000,
};
const THREAD_TWO: BotReadCursorAdvanceRequest = {
  botId: BOT_ID,
  conversationId: "thread-2",
  messageId: "t2-r2",
  seq: 2_000,
};
const TARGETS = [THREAD_ONE, THREAD_TWO];

function mount(targets: readonly BotReadCursorAdvanceRequest[]) {
  const fixture = mocks.fixture;
  if (fixture === null) throw new Error("no host");
  return renderHook(
    (props: { readonly targets: readonly BotReadCursorAdvanceRequest[] }) =>
      useBotMarkRepresentedRead(props.targets),
    { wrapper: fixture.Wrapper, initialProps: { targets } },
  );
}

/** A held advance's way out. */
function holdAdvances(fixture: ReadCursorHostFixture): () => void {
  let release = (): void => undefined;
  fixture.heldAdvance.promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

/** The write's terminal state reached, with what React and the cache queued after it flushed. */
async function continuationRuns(settled: Promise<void>): Promise<void> {
  await act(async () => {
    await settled;
  });
}

/** Holds every mutation at its `onMutate`, before its function runs; the way out is returned. */
function holdMutations(fixture: ReadCursorHostFixture): () => void {
  let release = (): void => undefined;
  fixture.heldMutate.promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

/** Resolves once a mutation has reached that hold. Call it before the click. */
function mutationReachesHold(fixture: ReadCursorHostFixture): Promise<void> {
  return new Promise<void>((resolve) => {
    fixture.heldMutate.waiters.push(resolve);
  });
}

/** How many advance mutations the view started in all. */
function mutationsStarted(fixture: ReadCursorHostFixture): number {
  return fixture.queryClient.getMutationCache().getAll().length;
}

beforeEach(() => {
  mocks.fixture = createReadCursorHostFixture({ cursors: {}, latest: {} });
  mocks.fixture.spine.setRequestContext(requestContextOf("user-a"));
});

afterEach(() => {
  mocks.fixture = null;
  cleanup();
});

describe("the cross's batch and the identity that clicked it", () => {
  it("sends nothing to the second thread under the next identity when the switch aborts the first write", async () => {
    const fixture = mocks.fixture;
    if (fixture === null) throw new Error("no host");
    const release = holdAdvances(fixture);
    const { result } = mount(TARGETS);

    act(() => {
      result.current.markRead();
    });
    await waitFor(() => {
      expect(fixture.advances).toEqual([THREAD_ONE]);
    });

    // The person on this window changes while the first write is held.
    const settled = firstAdvanceSettles(fixture);
    act(() => {
      fixture.spine.setRequestContext(requestContextOf("user-b"));
    });
    await continuationRuns(settled);
    release();

    expect(fixture.advances).toEqual([THREAD_ONE]);
    expect(fixture.advanceUsers).toEqual(["user-a"]);
    expect(mutationsStarted(fixture)).toBe(1);
  });

  it("sends nothing to the second thread when the identity changes and returns while the first write is held", async () => {
    const fixture = mocks.fixture;
    if (fixture === null) throw new Error("no host");
    const release = holdAdvances(fixture);
    const { result } = mount(TARGETS);

    act(() => {
      result.current.markRead();
    });
    await waitFor(() => {
      expect(fixture.advances).toEqual([THREAD_ONE]);
    });

    const settled = firstAdvanceSettles(fixture);
    act(() => {
      fixture.spine.setRequestContext(requestContextOf("user-b"));
    });
    act(() => {
      fixture.spine.setRequestContext(requestContextOf("user-a"));
    });
    await continuationRuns(settled);
    release();

    expect(fixture.advances).toEqual([THREAD_ONE]);
    expect(fixture.advanceUsers).toEqual(["user-a"]);
    expect(mutationsStarted(fixture)).toBe(1);
  });

  it("still sends the second thread when only the same person's bearer is rotated while the first write is held", async () => {
    const fixture = mocks.fixture;
    if (fixture === null) throw new Error("no host");
    const release = holdAdvances(fixture);
    const { result } = mount(TARGETS);

    act(() => {
      result.current.markRead();
    });
    await waitFor(() => {
      expect(fixture.advances).toEqual([THREAD_ONE]);
    });

    act(() => {
      fixture.spine.notifyBearerRotated();
    });
    release();
    fixture.heldAdvance.promise = null;
    await waitFor(() => {
      expect(fixture.advances).toEqual([THREAD_ONE, THREAD_TWO]);
    });

    expect(fixture.advanceUsers).toEqual(["user-a", "user-a"]);
    await waitFor(() => {
      expect(result.current.failed).toBe(false);
      expect(result.current.pending).toBe(false);
    });
  });

  it("sends nothing more to the old host client once the view is given another one", async () => {
    const fixture = mocks.fixture;
    if (fixture === null) throw new Error("no host");
    const release = holdAdvances(fixture);
    const { result, rerender } = mount(TARGETS);

    act(() => {
      result.current.markRead();
    });
    await waitFor(() => {
      expect(fixture.advances).toEqual([THREAD_ONE]);
    });

    const replacement = createReadCursorHostFixture({
      cursors: {},
      latest: {},
    });
    replacement.spine.setRequestContext(requestContextOf("user-a"));
    mocks.fixture = replacement;
    rerender({ targets: TARGETS });
    const settled = firstAdvanceSettles(fixture);
    release();
    await continuationRuns(settled);

    expect(fixture.advances).toEqual([THREAD_ONE]);
    expect(replacement.advances).toEqual([]);
    expect(mutationsStarted(fixture)).toBe(1);
  });

  describe("a click retired before its first write is sent", () => {
    /** Clicks, holds the first mutation before its function runs, retires, releases. */
    async function retireBeforeDispatch(
      retire: (fixture: ReadCursorHostFixture, unmount: () => void) => void,
    ): Promise<ReadCursorHostFixture> {
      const fixture = mocks.fixture;
      if (fixture === null) throw new Error("no host");
      const release = holdMutations(fixture);
      const reached = mutationReachesHold(fixture);
      const { result, unmount } = mount(TARGETS);

      act(() => {
        result.current.markRead();
      });
      await reached;
      expect(fixture.advances).toEqual([]);

      const settled = firstAdvanceSettles(fixture);
      act(() => {
        retire(fixture, unmount);
      });
      release();
      await continuationRuns(settled);
      return fixture;
    }

    it("sends no write when the identity changes", async () => {
      const fixture = await retireBeforeDispatch((host) => {
        host.spine.setRequestContext(requestContextOf("user-b"));
      });

      expect(fixture.advances).toEqual([]);
      expect(fixture.advanceUsers).toEqual([]);
      expect(mutationsStarted(fixture)).toBe(1);
    });

    it("sends no write when the identity changes and returns", async () => {
      const fixture = await retireBeforeDispatch((host) => {
        host.spine.setRequestContext(requestContextOf("user-b"));
        host.spine.setRequestContext(requestContextOf("user-a"));
      });

      expect(fixture.advances).toEqual([]);
      expect(fixture.advanceUsers).toEqual([]);
      expect(mutationsStarted(fixture)).toBe(1);
    });

    it("sends no write when the view unmounts", async () => {
      const fixture = await retireBeforeDispatch((_host, unmount) => {
        unmount();
      });

      expect(fixture.advances).toEqual([]);
      expect(fixture.advanceUsers).toEqual([]);
      expect(mutationsStarted(fixture)).toBe(1);
    });
  });

  it("does not bring a failed batch back after the identity changes and returns", async () => {
    const fixture = mocks.fixture;
    if (fixture === null) throw new Error("no host");
    fixture.refuseAdvances.value = true;
    const { result, rerender } = mount(TARGETS);

    act(() => {
      result.current.markRead();
    });
    await waitFor(() => {
      expect(result.current.failed).toBe(true);
    });
    expect(fixture.advances).toEqual([THREAD_ONE, THREAD_TWO]);

    act(() => {
      fixture.spine.setRequestContext(requestContextOf("user-b"));
    });
    act(() => {
      fixture.spine.setRequestContext(requestContextOf("user-a"));
    });
    // Back as the first person, whose view now counts nothing unread.
    fixture.refuseAdvances.value = false;
    rerender({ targets: [] });

    expect(result.current.failed).toBe(false);
    act(() => {
      result.current.markRead();
    });

    expect(fixture.advances).toEqual([THREAD_ONE, THREAD_TWO]);
    expect(mutationsStarted(fixture)).toBe(2);
  });

  it("sends nothing more once the view that clicked it has unmounted", async () => {
    const fixture = mocks.fixture;
    if (fixture === null) throw new Error("no host");
    const release = holdAdvances(fixture);
    const { result, unmount } = mount(TARGETS);

    act(() => {
      result.current.markRead();
    });
    await waitFor(() => {
      expect(fixture.advances).toEqual([THREAD_ONE]);
    });

    unmount();
    const settled = firstAdvanceSettles(fixture);
    release();
    await continuationRuns(settled);

    expect(fixture.advances).toEqual([THREAD_ONE]);
    expect(mutationsStarted(fixture)).toBe(1);
  });
});
