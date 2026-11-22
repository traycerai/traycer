import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import type { HostDoorReason } from "@traycer/protocol/framework/door-reason";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
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
const HOST_TOKEN = "held-host-token";
const HOST_ID = "cleanup-real-stream-host";
const PATH = "/wt/a";
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

async function tokenSource(held: boolean): Promise<HostTokenSource> {
  const source = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () =>
      Promise.resolve({ kind: "unavailable", detail: "authn offline" }),
    signIn: (userId) => (userId === USER_A ? SIGN_IN_TOKEN : null),
    now: () => Date.now(),
  });
  if (held) {
    await source.adopt(
      USER_A,
      HOST_ID,
      { token: HOST_TOKEN, expiresAtMs: Date.now() + 3_600_000 },
      source.era(USER_A),
    );
  }
  return source;
}

/** One cleanup of `PATH` against a personal host reached over a fake socket. */
function startCleanup(source: HostTokenSource): {
  readonly outcome: { current: WorktreeCleanupOutcome | null };
} {
  const provider = newProvider();
  signIn(provider, USER_A, SIGN_IN_TOKEN);
  const target = {
    ...mockLocalHostEntry,
    hostId: HOST_ID,
    owner: { kind: "user", id: USER_A } as const,
  };
  const openStreamTransport = (): DurableStreamTransport => {
    const client = buildHostStreamClient({
      target,
      endpoint: () =>
        target.websocketUrl === null
          ? null
          : { hostId: HOST_ID, websocketUrl: target.websocketUrl },
      bearer: liveBearer(provider),
      cloudAuthorized: () => true,
      authnBaseUrl: "https://authn.test",
      auth: null,
      hostTokens: source,
      userId: USER_A,
      proactiveWakeEligible: false,
      autoStart: true,
    });
    if (client === null) throw new Error("local stream client did not build");
    return { wsStreamClient: client, close: () => client.close("test done") };
  };
  const outcome: { current: WorktreeCleanupOutcome | null } = {
    current: null,
  };
  void runWorktreeCleanup(openStreamTransport, {
    hostId: HOST_ID,
    paths: [PATH],
    source: "task_cleanup",
    stopOwnersPaths: new Set(),
  }).then((settled) => {
    outcome.current = settled;
  });
  return { outcome };
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
    const { outcome } = startCleanup(await tokenSource(true));
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
    const { outcome } = startCleanup(await tokenSource(false));
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
      const { outcome } = startCleanup(await tokenSource(true));
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
