import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type {
  BotReadCursorReadResponse,
  BotReadPosition,
} from "@traycer/protocol/host/bot/schemas";
import { isReadCursorReadOf } from "@/hooks/bots/use-bot-read-cursor";
import { useAdvanceWhilePresented } from "@/hooks/bots/use-bot-read-while-presented";
import { useBotReadCursorQuery } from "@/hooks/bots/use-bot-read-cursor";
import { channelBold } from "@/lib/bots/bot-read-cursor";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createReadCursorHostFixture,
  firstAdvanceSettles,
  removeNativeAbortAny,
  requestContextOf,
  type ReadCursorHostFixture,
} from "./bot-read-cursor-test-support";

// The natural read of the channel's observed prefix, over a REAL host client
// and QueryClient: only the host's answers are scripted. A read the person
// earned completes when they leave the view; one whose requester is no longer
// the person who earned it, or whose client was replaced, is never sent.

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHANNEL = "channel-1";
const OLD: BotReadPosition = { messageId: "m-old", seq: 1_000 };
const NEW: BotReadPosition = { messageId: "m-new", seq: 2_000 };
const TARGET = { botId: BOT_ID, conversationId: CHANNEL, ...NEW };

/** The window reads as `userId`: the request context moves first, as the app's auth service does, then the store. */
function signInAs(fixture: ReadCursorHostFixture, userId: string): void {
  act(() => {
    fixture.spine.setRequestContext(requestContextOf(userId));
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId, username: userId },
    });
  });
}

/** The cursor the viewer's cached read holds for the channel; `null` while it holds none. */
function cachedCursor(queryClient: QueryClient): BotReadPosition | null {
  const entry = queryClient
    .getQueryCache()
    .findAll({
      predicate: (query) => isReadCursorReadOf(query.queryKey, BOT_ID),
    })
    .at(0);
  if (entry === undefined) return null;
  const read = queryClient.getQueryData<BotReadCursorReadResponse>(
    entry.queryKey,
  );
  if (read === undefined || !Object.hasOwn(read.cursors, CHANNEL)) return null;
  return read.cursors[CHANNEL];
}

/** Resolves when the channel's cached read holds `position`: an event of the query cache, or at once when it already does. */
function cacheHolds(
  queryClient: QueryClient,
  position: BotReadPosition,
): Promise<void> {
  const holds = (): boolean => {
    const cursor = cachedCursor(queryClient);
    return (
      cursor !== null &&
      cursor.messageId === position.messageId &&
      cursor.seq === position.seq
    );
  };
  return new Promise<void>((resolve) => {
    if (holds()) {
      resolve();
      return;
    }
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (!holds()) return;
      unsubscribe();
      resolve();
    });
  });
}

interface Props {
  readonly fixture: ReadCursorHostFixture;
  readonly target: BotReadPosition | null;
}

type StrictModeWrapper = (props: { readonly children: ReactNode }) => ReactNode;

function mount(
  fixture: ReadCursorHostFixture,
  wrapper: StrictModeWrapper | undefined,
  target: BotReadPosition | null,
) {
  const initialProps: Props = { fixture, target };
  return renderHook(
    (props: Props) => {
      useBotReadCursorQuery(props.fixture.client, BOT_ID, true);
      useAdvanceWhilePresented({
        client: props.fixture.client,
        botId: BOT_ID,
        conversationId: CHANNEL,
        target: props.target,
      });
    },
    {
      wrapper: wrapper ?? fixture.Wrapper,
      initialProps,
    },
  );
}
/** The channel's cached read holds `OLD`, with no target yet. */
async function mountWithCachedRead(
  fixture: ReadCursorHostFixture,
  wrapper: StrictModeWrapper | undefined,
) {
  signInAs(fixture, "user-a");
  const cached = cacheHolds(fixture.queryClient, OLD);
  const view = mount(fixture, wrapper, null);
  await act(async () => {
    await cached;
  });
  return view;
}

/** The mutation cache's `onMutate` holds the first advance; `release` lets it go. */
function holdFirstAdvanceBeforeDispatch(fixture: ReadCursorHostFixture): {
  readonly arrived: Promise<void>;
  readonly release: () => void;
} {
  let release = (): void => undefined;
  fixture.heldMutate.promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    fixture.heldMutate.waiters.push(resolve);
  });
  return { arrived, release };
}

let fixture: ReadCursorHostFixture;
beforeEach(() => {
  fixture = createReadCursorHostFixture({
    cursors: { [CHANNEL]: OLD },
    latest: { [CHANNEL]: NEW },
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("a natural read when the person leaves the view", () => {
  it("is sent and written to the cache when the view unmounts while its dispatch is held", async () => {
    const { rerender, unmount } = await mountWithCachedRead(fixture, undefined);
    const hold = holdFirstAdvanceBeforeDispatch(fixture);
    rerender({ fixture, target: NEW });
    await hold.arrived;

    unmount();
    const settled = firstAdvanceSettles(fixture);
    hold.release();
    await act(async () => {
      await settled;
    });

    expect(fixture.advances).toEqual([TARGET]);
    expect(cachedCursor(fixture.queryClient)).toEqual(NEW);

    // The person comes back: the channel reads as read, not bold.
    const back = renderHook(
      () => useBotReadCursorQuery(fixture.client, BOT_ID, true),
      { wrapper: fixture.Wrapper },
    );
    const returned = back.result.current.data;
    if (returned === undefined) throw new Error("no read");
    expect(channelBold(returned, CHANNEL, undefined)).toBe(false);
  });

  it("writes its cursor to the cache when the view unmounts while its success is held", async () => {
    const { rerender, unmount } = await mountWithCachedRead(fixture, undefined);
    let release = (): void => undefined;
    fixture.heldSuccess.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      fixture.heldSuccess.waiters.push(resolve);
    });
    rerender({ fixture, target: NEW });
    await arrived;

    unmount();
    const settled = firstAdvanceSettles(fixture);
    release();
    await act(async () => {
      await settled;
    });

    expect(fixture.advances).toEqual([TARGET]);
    expect(cachedCursor(fixture.queryClient)).toEqual(NEW);
  });

  it("is sent and settles exactly once when the view mounts already qualified under StrictMode", async () => {
    const strict: StrictModeWrapper = ({ children }) => (
      <StrictMode>
        <fixture.Wrapper>{children}</fixture.Wrapper>
      </StrictMode>
    );
    signInAs(fixture, "user-a");
    // Armed before the render: the mount's setup, cleanup and setup all run inside it.
    const settled = firstAdvanceSettles(fixture);
    mount(fixture, strict, NEW);
    await act(async () => {
      await settled;
    });

    expect(fixture.advances).toEqual([TARGET]);
    const mutations = fixture.queryClient.getMutationCache().getAll();
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.state.status).toBe("success");
  });
});

describe("a natural read whose requester or client is retired before it is sent", () => {
  it("is not sent under the next identity when the requester's context changes before the store's does", async () => {
    const { rerender } = await mountWithCachedRead(fixture, undefined);
    const hold = holdFirstAdvanceBeforeDispatch(fixture);
    rerender({ fixture, target: NEW });
    await hold.arrived;

    // The app's auth service moves the request context first; the store follows later.
    act(() => {
      fixture.spine.setRequestContext(requestContextOf("user-b"));
    });
    const settled = firstAdvanceSettles(fixture);
    hold.release();
    await act(async () => {
      await settled;
    });

    expect(fixture.advances).toEqual([]);
    expect(cachedCursor(fixture.queryClient)).toEqual(OLD);
  });

  it("is not sent when the store's account changes before it is", async () => {
    const { rerender } = await mountWithCachedRead(fixture, undefined);
    const hold = holdFirstAdvanceBeforeDispatch(fixture);
    rerender({ fixture, target: NEW });
    await hold.arrived;

    signInAs(fixture, "user-b");
    const settled = firstAdvanceSettles(fixture);
    hold.release();
    await act(async () => {
      await settled;
    });

    expect(fixture.advances).toEqual([]);
  });

  it("is not sent to the old client once the view is given another", async () => {
    const { rerender } = await mountWithCachedRead(fixture, undefined);
    const hold = holdFirstAdvanceBeforeDispatch(fixture);
    rerender({ fixture, target: NEW });
    await hold.arrived;

    const replacement = createReadCursorHostFixture({
      cursors: { [CHANNEL]: OLD },
      latest: { [CHANNEL]: NEW },
    });
    replacement.spine.setRequestContext(requestContextOf("user-a"));
    rerender({ fixture: replacement, target: NEW });
    const settled = firstAdvanceSettles(fixture);
    hold.release();
    await act(async () => {
      await settled;
    });

    expect(fixture.advances).toEqual([]);
    expect(replacement.advances).toEqual([]);
  });

  it("is not sent when the view is given another client and then the original again", async () => {
    const { rerender } = await mountWithCachedRead(fixture, undefined);
    const hold = holdFirstAdvanceBeforeDispatch(fixture);
    rerender({ fixture, target: NEW });
    await hold.arrived;

    const replacement = createReadCursorHostFixture({
      cursors: { [CHANNEL]: OLD },
      latest: { [CHANNEL]: NEW },
    });
    replacement.spine.setRequestContext(requestContextOf("user-a"));
    rerender({ fixture: replacement, target: NEW });
    rerender({ fixture, target: NEW });
    const settled = firstAdvanceSettles(fixture);
    hold.release();
    await act(async () => {
      await settled;
    });

    expect(fixture.advances).toEqual([]);
    expect(replacement.advances).toEqual([]);
  });

  it("writes no cursor to the cache when the requester's context changes after it was sent, before its success is written", async () => {
    const { rerender } = await mountWithCachedRead(fixture, undefined);
    let release = (): void => undefined;
    fixture.heldSuccess.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      fixture.heldSuccess.waiters.push(resolve);
    });
    rerender({ fixture, target: NEW });
    await arrived;

    act(() => {
      fixture.spine.setRequestContext(requestContextOf("user-b"));
    });
    const settled = firstAdvanceSettles(fixture);
    release();
    await act(async () => {
      await settled;
    });

    expect(fixture.advances).toEqual([TARGET]);
    expect(fixture.advanceUsers).toEqual(["user-a"]);
    expect(cachedCursor(fixture.queryClient)).toEqual(OLD);
  });
});

describe("a natural read on a WebView without AbortSignal.any", () => {
  let restoreAbortAny = (): void => undefined;
  beforeEach(() => {
    restoreAbortAny = removeNativeAbortAny();
  });
  afterEach(() => {
    restoreAbortAny();
  });

  it("is sent and written to the cache", async () => {
    const { rerender } = await mountWithCachedRead(fixture, undefined);
    const settled = firstAdvanceSettles(fixture);
    rerender({ fixture, target: NEW });
    await act(async () => {
      await settled;
    });

    expect(fixture.advances).toEqual([TARGET]);
    expect(cachedCursor(fixture.queryClient)).toEqual(NEW);
  });

  it("is not sent under the next identity when the requester's context changes before its dispatch", async () => {
    const { rerender } = await mountWithCachedRead(fixture, undefined);
    const hold = holdFirstAdvanceBeforeDispatch(fixture);
    rerender({ fixture, target: NEW });
    await hold.arrived;

    act(() => {
      fixture.spine.setRequestContext(requestContextOf("user-b"));
    });
    const settled = firstAdvanceSettles(fixture);
    hold.release();
    await act(async () => {
      await settled;
    });

    expect(fixture.advances).toEqual([]);
  });
});
