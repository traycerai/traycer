import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import type { HostDoorReason } from "@traycer/protocol/framework/door-reason";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import {
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  openAckFrame,
  sentFramesOfKind,
  settle,
  signIn,
  USER_A,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  runWorktreeCleanup,
  type WorktreeCleanupOutcome,
} from "@/lib/epics/run-worktree-cleanup";

// The real cleanup runner over the real stream client and the real batch
// command, with a fake native socket at the boundary: what the host answers
// decides whether the worktrees are removed, and when the cleanup gives up.

const SIGN_IN_TOKEN = "sign-in-token";
const ROTATED_SIGN_IN_TOKEN = "rotated-sign-in-token";
const HOST_TOKEN = "held-host-token";
/** Each case dials its own host id: the process-wide memory of a host's answers never reaches the next case. */
const host = { id: "", count: 0 };
const PATH = "/wt/a";
/** Past the stream's first reconnect backoff. */
const BACKOFF_PASSED_MS = 5_000;
const NEVER_REACHED_HOST_REASON =
  "Couldn't reach the host to start the deletion.";

function refusal(
  reason: string,
  doorReason: HostDoorReason | null,
  retryable: boolean,
): string {
  return JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason,
      ...(doorReason === null ? {} : { doorReason }),
      retryable,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

/** What a released host says to a host-only token. */
const releasedRefusal = (): string =>
  refusal("released-host-token-refusal", null, false);

const named = (doorReason: HostDoorReason, retryable: boolean): string =>
  refusal("current-host-refusal", doorReason, retryable);

/** `unanswered`: the mint started by the first read never answers, as when authn is slow. */
async function tokenSource(
  held: boolean,
  mint: "unavailable" | "unanswered",
): Promise<HostTokenSource> {
  const source = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () =>
      mint === "unanswered"
        ? new Promise(() => undefined)
        : Promise.resolve({ kind: "unavailable", detail: "authn offline" }),
    signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
    now: () => Date.now(),
  });
  if (held) {
    await source.adopt(
      USER_A,
      host.id,
      { token: HOST_TOKEN, expiresAtMs: Date.now() + 3_600_000 },
      source.era(USER_A),
    );
  }
  return source;
}

/**
 * What refreshes the person's sign-in after a host refused it: it answers
 * `outcome` and, when it rotated, the context carries the new token.
 */
type SignInRefresh = (
  provider: DefaultRequestContextProvider,
) => StreamAuthRevalidator;

const refreshAnswering =
  (outcome: RevalidateOutcome): SignInRefresh =>
  (provider) => ({
    revalidateForReconnect: () => {
      if (outcome === "rotated")
        signIn(provider, USER_A, ROTATED_SIGN_IN_TOKEN);
      return Promise.resolve(outcome);
    },
  });

/** One cleanup of `PATH` against a personal host reached over a fake socket. */
function startCleanup(
  source: HostTokenSource,
  refresh: SignInRefresh | null,
): {
  readonly outcome: { current: WorktreeCleanupOutcome | null };
  /** How many times a session of the command reported the stream entering backoff. */
  readonly backoffEntries: () => number;
} {
  let backoffEntries = 0;
  const provider = newProvider();
  signIn(provider, USER_A, SIGN_IN_TOKEN);
  const target = {
    ...mockLocalHostEntry,
    hostId: host.id,
    owner: { kind: "user", id: USER_A } as const,
  };
  const openStreamTransport = (): DurableStreamTransport => {
    const client = buildHostStreamClient({
      target,
      endpoint: () =>
        target.websocketUrl === null
          ? null
          : { hostId: host.id, websocketUrl: target.websocketUrl },
      bearer: liveBearer(provider),
      cloudAuthorized: () => true,
      authnBaseUrl: "https://authn.test",
      auth: refresh === null ? null : refresh(provider),
      hostTokens: source,
      userId: USER_A,
      proactiveWakeEligible: false,
      autoStart: true,
    });
    if (client === null) throw new Error("local stream client did not build");
    // Each session of the command is watched for the stream entering backoff,
    // the one signal the cleanup settles on.
    const subscribe = client.subscribe.bind(client);
    vi.spyOn(client, "subscribe").mockImplementation((method, params) => {
      const session = subscribe(method, params);
      session.onBackoffEntered(() => {
        backoffEntries += 1;
      });
      return session;
    });
    return { wsStreamClient: client, close: () => client.close("test done") };
  };
  const outcome: { current: WorktreeCleanupOutcome | null } = {
    current: null,
  };
  void runWorktreeCleanup(openStreamTransport, {
    hostId: host.id,
    paths: [PATH],
    source: "task_cleanup",
    stopOwnersPaths: new Set(),
  }).then((settled) => {
    outcome.current = settled;
  });
  return { outcome, backoffEntries: () => backoffEntries };
}

async function socketAt(count: number): Promise<FakeNativeWebSocket> {
  await settle();
  await vi.waitFor(() =>
    expect(FakeNativeWebSocket.instances).toHaveLength(count),
  );
  return FakeNativeWebSocket.instances[count - 1];
}

async function openTokenOf(socket: FakeNativeWebSocket): Promise<unknown> {
  socket.fireOpen();
  await vi.waitFor(() =>
    expect(sentFramesOfKind(socket, "open")).toHaveLength(1),
  );
  return sentFramesOfKind(socket, "open")[0].token;
}

/** The host answers the open and settles the one target. */
async function hostDeletes(socket: FakeNativeWebSocket): Promise<void> {
  socket.fireMessage(openAckFrame([], null));
  await vi.waitFor(() =>
    expect(sentFramesOfKind(socket, "subscribe")).toHaveLength(1),
  );
  socket.fireMessage(
    JSON.stringify({
      kind: "target.complete",
      worktreePath: PATH,
      deleted: true,
      hasBinaryPayload: false,
    }),
  );
  socket.fireMessage(
    JSON.stringify({
      kind: "command.complete",
      requestedCount: 1,
      deletedCount: 1,
      failedCount: 0,
      hasBinaryPayload: false,
    }),
  );
}

beforeEach(() => {
  host.count += 1;
  host.id = `cleanup-real-stream-host-${host.count}`;
  processReleasedHosts.forgetAll();
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeNativeWebSocket);
  FakeNativeWebSocket.instances.length = 0;
});

afterEach(async () => {
  for (const socket of FakeNativeWebSocket.instances)
    socket.fireClose(1006, "test teardown");
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("worktree cleanup against a host that takes the person's sign-in", () => {
  it("removes the worktrees of a released personal host once its sign-in is admitted on the immediate redial", async () => {
    const { outcome } = startCleanup(
      await tokenSource(true, "unavailable"),
      null,
    );
    const first = await socketAt(1);
    expect(await openTokenOf(first)).toBe(HOST_TOKEN);
    first.fireMessage(releasedRefusal());
    const second = await socketAt(2);
    expect(await openTokenOf(second)).toBe(SIGN_IN_TOKEN);
    await hostDeletes(second);
    await vi.waitFor(() =>
      expect(outcome.current).toEqual({
        removed: [PATH],
        failed: [],
        uncertain: [],
      }),
    );
  });

  it("removes the worktrees of a current personal host with no token once its invitation's sign-in is admitted", async () => {
    const { outcome } = startCleanup(
      await tokenSource(false, "unavailable"),
      null,
    );
    const probe = await socketAt(1);
    expect(await openTokenOf(probe)).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireMessage(named("owner_sign_in", false));
    const invited = await socketAt(2);
    expect(await openTokenOf(invited)).toBe(SIGN_IN_TOKEN);
    await hostDeletes(invited);
    await vi.waitFor(() =>
      expect(outcome.current).toEqual({
        removed: [PATH],
        failed: [],
        uncertain: [],
      }),
    );
  });
});

describe("worktree cleanup settles only on the stream's backoff or a terminal end", () => {
  it("removes the worktrees of a released personal host with no held host-only token once the sign-in handed over after the placeholder is admitted", async () => {
    const { outcome, backoffEntries } = startCleanup(
      await tokenSource(false, "unavailable"),
      null,
    );
    const placeholder = await socketAt(1);
    expect(await openTokenOf(placeholder)).toBe(NO_HOST_TOKEN_PROBE);
    placeholder.fireMessage(releasedRefusal());
    const handedOver = await socketAt(2);
    expect(await openTokenOf(handedOver)).toBe(SIGN_IN_TOKEN);
    await hostDeletes(handedOver);
    await vi.waitFor(() =>
      expect(outcome.current).toEqual({
        removed: [PATH],
        failed: [],
        uncertain: [],
      }),
    );
    // The cold dial and the handover each follow at once: the stream never
    // enters backoff.
    expect(backoffEntries()).toBe(0);
  });

  it("removes the worktrees once the sign-in a released host refused bare was refreshed and the stream redialed at once", async () => {
    const { outcome, backoffEntries } = startCleanup(
      await tokenSource(true, "unavailable"),
      refreshAnswering("rotated"),
    );
    const first = await socketAt(1);
    expect(await openTokenOf(first)).toBe(HOST_TOKEN);
    first.fireMessage(releasedRefusal());
    const expired = await socketAt(2);
    expect(await openTokenOf(expired)).toBe(SIGN_IN_TOKEN);
    expired.fireMessage(releasedRefusal());
    // After a refresh that made progress the stream redials through its
    // ordinary short backoff, with no further status.
    await vi.advanceTimersByTimeAsync(BACKOFF_PASSED_MS);
    const refreshed = await socketAt(3);
    expect(await openTokenOf(refreshed)).toBe(ROTATED_SIGN_IN_TOKEN);
    await hostDeletes(refreshed);
    await vi.waitFor(() =>
      expect(outcome.current).toEqual({
        removed: [PATH],
        failed: [],
        uncertain: [],
      }),
    );
    // The refresh's timed redial is the recovery's own: it does not fire the
    // backoff signal, so the deletion went ahead.
    expect(backoffEntries()).toBe(0);
  });

  it("reports the paths as not reached once the refresh of the sign-in a released host refused bare does not reach authn and the stream goes to backoff", async () => {
    const { outcome, backoffEntries } = startCleanup(
      await tokenSource(true, "unavailable"),
      refreshAnswering("network-error"),
    );
    const first = await socketAt(1);
    expect(await openTokenOf(first)).toBe(HOST_TOKEN);
    first.fireMessage(releasedRefusal());
    const expired = await socketAt(2);
    expect(await openTokenOf(expired)).toBe(SIGN_IN_TOKEN);
    expired.fireMessage(releasedRefusal());
    await settle();
    await vi.waitFor(() =>
      expect(outcome.current).toEqual({
        removed: [],
        failed: [{ worktreePath: PATH, reason: NEVER_REACHED_HOST_REASON }],
        uncertain: [],
      }),
    );
    // The refresh ended in backoff: the one signal the cleanup fails on.
    expect(backoffEntries()).toBe(1);
  });

  it("removes the worktrees of a released personal host whose mint never answers: the placeholder is written at once and the sign-in handed over after it is admitted", async () => {
    const { outcome, backoffEntries } = startCleanup(
      await tokenSource(false, "unanswered"),
      null,
    );
    const placeholder = await socketAt(1);
    expect(await openTokenOf(placeholder)).toBe(NO_HOST_TOKEN_PROBE);
    placeholder.fireMessage(releasedRefusal());
    const handedOver = await socketAt(2);
    expect(await openTokenOf(handedOver)).toBe(SIGN_IN_TOKEN);
    await hostDeletes(handedOver);
    await vi.waitFor(() =>
      expect(outcome.current).toEqual({
        removed: [PATH],
        failed: [],
        uncertain: [],
      }),
    );
    // The cold dial and the handover each follow at once: the stream never
    // enters backoff.
    expect(backoffEntries()).toBe(0);
  });
});

describe("worktree cleanup when the stream drops on its backoff before the request", () => {
  it.each([
    {
      name: "a retryable refusal of the open",
      drop: (socket: FakeNativeWebSocket) => {
        socket.fireMessage(named("keys_unavailable", true));
      },
    },
    {
      name: "the host closing the socket",
      drop: (socket: FakeNativeWebSocket) => {
        socket.fireClose(1006, "abnormal");
      },
    },
  ])(
    "reports the paths as not reached at once after $name, with no wait armed",
    async ({ drop }) => {
      const { outcome } = startCleanup(
        await tokenSource(true, "unavailable"),
        null,
      );
      const socket = await socketAt(1);
      expect(await openTokenOf(socket)).toBe(HOST_TOKEN);
      drop(socket);
      await settle();
      expect(outcome.current).toEqual({
        removed: [],
        failed: [{ worktreePath: PATH, reason: NEVER_REACHED_HOST_REASON }],
        uncertain: [],
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
