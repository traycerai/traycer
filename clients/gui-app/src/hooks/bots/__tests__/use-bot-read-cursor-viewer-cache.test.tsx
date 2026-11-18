import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient, UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  BotReadCursorAdvanceRequest,
  BotReadCursorReadResponse,
  BotReadPosition,
} from "@traycer/protocol/host/bot/schemas";
import {
  isReadCursorReadOf,
  useBotReadCursorAdvanceMutation,
  useBotReadCursorQuery,
} from "@/hooks/bots/use-bot-read-cursor";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createReadCursorHostFixture,
  firstAdvanceSettles,
  requestContextOf,
  type ReadCursorHostFixture,
} from "./bot-read-cursor-test-support";

// The person's read cursors are cached per viewer. An advance that finishes
// after the window has moved to another account must not write its cursor
// into the other account's cache (or back into the one it left), and one that
// finishes for the viewer who sent it writes only that viewer's. The viewer is
// the real auth store's, the identity the real host client sends under, and
// the caches are the ones the real read hook filled.

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHANNEL = "channel-1";
const OLD: BotReadPosition = { messageId: "m-old", seq: 1_000 };
const NEW: BotReadPosition = { messageId: "m-new", seq: 2_000 };
const ADVANCE = { botId: BOT_ID, conversationId: CHANNEL, ...NEW };

const mocks = vi.hoisted(() => ({
  fixture: null as ReadCursorHostFixture | null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.fixture?.client ?? null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));

/** Who the window reads as: the request context moves first, as the app's auth service does, then the store. */
function signInAs(fixture: ReadCursorHostFixture, userId: string): void {
  act(() => {
    fixture.spine.setRequestContext(requestContextOf(userId));
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId, username: userId },
    });
  });
}

/** The cursor `viewer`'s cached read holds for the channel; `null` while it holds no read. */
function cachedCursor(
  queryClient: QueryClient,
  viewer: string,
): BotReadPosition | null {
  const entry = queryClient
    .getQueryCache()
    .findAll({
      predicate: (query) =>
        isReadCursorReadOf(query.queryKey, BOT_ID) &&
        query.queryKey.at(-1) === viewer,
    })
    .at(0);
  if (entry === undefined) return null;
  const read = queryClient.getQueryData<BotReadCursorReadResponse>(
    entry.queryKey,
  );
  return read !== undefined && Object.hasOwn(read.cursors, CHANNEL)
    ? read.cursors[CHANNEL]
    : null;
}

function mount(fixture: ReadCursorHostFixture) {
  return renderHook(
    () => ({
      read: useBotReadCursorQuery(fixture.client, BOT_ID, true),
      advance: useBotReadCursorAdvanceMutation(fixture.client),
    }),
    { wrapper: fixture.Wrapper },
  );
}

/** What the mounted hooks hand the case. */
interface Mounted {
  readonly current: {
    readonly read: UseQueryResult<BotReadCursorReadResponse, HostRpcError>;
    readonly advance: {
      readonly mutate: (variables: BotReadCursorAdvanceRequest) => void;
    };
  };
}

/** A is read, then B is, then the window is A's again: both viewers hold a cached read of the old cursor. */
async function seedBothViewers(
  fixture: ReadCursorHostFixture,
  result: Mounted,
): Promise<void> {
  signInAs(fixture, "user-a");
  await waitFor(() => {
    expect(cachedCursor(fixture.queryClient, "user-a")).toEqual(OLD);
  });
  signInAs(fixture, "user-b");
  await waitFor(() => {
    expect(cachedCursor(fixture.queryClient, "user-b")).toEqual(OLD);
  });
  signInAs(fixture, "user-a");
  await waitFor(() => {
    expect(result.current.read.data?.cursors[CHANNEL]).toEqual(OLD);
  });
}

/** A's advance has reached the host and is held at `hold`; the window then becomes B's, whose read is asked again and stays asked. */
async function switchToBWhileHeld(
  fixture: ReadCursorHostFixture,
  result: Mounted,
  hold: Promise<void>,
): Promise<void> {
  act(() => {
    result.current.advance.mutate(ADVANCE);
  });
  await hold;
  fixture.heldRead.promise = new Promise(() => undefined);
  signInAs(fixture, "user-b");
}

beforeEach(() => {
  mocks.fixture = createReadCursorHostFixture({
    cursors: { [CHANNEL]: OLD },
    latest: { [CHANNEL]: NEW },
  });
});

afterEach(() => {
  mocks.fixture = null;
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  vi.restoreAllMocks();
});

describe("an advance that finishes after the window changes account", () => {
  it("writes no cursor into either account's cache when its success waits in the mutation cache's own success step", async () => {
    const fixture = mocks.fixture;
    if (fixture === null) throw new Error("no host");
    const { result } = mount(fixture);
    await seedBothViewers(fixture, result);
    const lifetimeBefore = currentBotLifetime();
    let release = (): void => undefined;
    fixture.heldSuccess.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      fixture.heldSuccess.waiters.push(resolve);
    });

    await switchToBWhileHeld(fixture, result, reached);
    const settled = firstAdvanceSettles(fixture);
    release();
    await act(async () => {
      await settled;
    });

    expect(currentBotLifetime()).toBe(lifetimeBefore + 1);
    expect(cachedCursor(fixture.queryClient, "user-b")).toEqual(OLD);
    expect(cachedCursor(fixture.queryClient, "user-a")).toEqual(OLD);
  });

  it("writes no cursor into either account's cache when its success waits right after the cache's own cancellation", async () => {
    const fixture = mocks.fixture;
    if (fixture === null) throw new Error("no host");
    const { result } = mount(fixture);
    await seedBothViewers(fixture, result);
    const lifetimeBefore = currentBotLifetime();
    // The real cancellation runs and is awaited; the case then parks exactly
    // where the hook goes on to write.
    const cancelQueries = fixture.queryClient.cancelQueries.bind(
      fixture.queryClient,
    );
    let release = (): void => undefined;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedPark = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      reachedPark = resolve;
    });
    vi.spyOn(fixture.queryClient, "cancelQueries").mockImplementation(
      async (filters, options) => {
        await cancelQueries(filters, options);
        reachedPark();
        await parked;
      },
    );

    await switchToBWhileHeld(fixture, result, reached);
    const settled = firstAdvanceSettles(fixture);
    release();
    await act(async () => {
      await settled;
    });

    expect(currentBotLifetime()).toBe(lifetimeBefore + 1);
    expect(cachedCursor(fixture.queryClient, "user-b")).toEqual(OLD);
    expect(cachedCursor(fixture.queryClient, "user-a")).toEqual(OLD);
  });

  it("writes only the sending account's cache when it finishes with the window still theirs, keeping the other account's read", async () => {
    const fixture = mocks.fixture;
    if (fixture === null) throw new Error("no host");
    const lifetimeStart = currentBotLifetime();
    const { result } = mount(fixture);
    await seedBothViewers(fixture, result);
    // Signed out to A, A to B, B to A: three moves.
    expect(currentBotLifetime()).toBe(lifetimeStart + 3);

    const settled = firstAdvanceSettles(fixture);
    act(() => {
      result.current.advance.mutate(ADVANCE);
    });
    await act(async () => {
      await settled;
    });

    expect(cachedCursor(fixture.queryClient, "user-a")).toEqual(NEW);
    expect(cachedCursor(fixture.queryClient, "user-b")).toEqual(OLD);
  });
});
