import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { StreamFrameEnvelope } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  acquireBrowserSessionsCoordinator,
  browserSessionAcrossCoordinators,
  browserSessionsCoordinatorKey,
  browserSessionsCoordinatorState,
  browserSessionsCoordinatorsForEpic,
  hasBrowserSessionsCoordinator,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  coordinatorKey,
  epicScope,
  independentScope,
  owner,
  sessionInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";

/**
 * One `openTransport` per acquire, recording the {@link FakeStreamClient} it
 * mints so a test can reach the session the coordinator opened on it - the
 * coordinator opens its transport synchronously inside `start()`, so the
 * record is available the moment `acquireBrowserSessionsCoordinator` returns.
 */
function createTransportHarness(): {
  readonly openTransport: (hostId: string) => DurableStreamTransport;
  readonly clients: FakeStreamClient[];
} {
  const clients: FakeStreamClient[] = [];
  return {
    clients,
    openTransport: () => {
      const client = new FakeStreamClient(true);
      clients.push(client);
      return { wsStreamClient: client, close: () => undefined };
    },
  };
}

function buildRuntime(
  openTransport: (hostId: string) => DurableStreamTransport,
): {
  readonly browserView: null;
  readonly userId: string;
  readonly localHostId: null;
  readonly presentation: null;
  readonly navigateNested: () => null;
  readonly openTransport: (hostId: string) => DurableStreamTransport;
} {
  return {
    browserView: null,
    userId: "user-1",
    localHostId: null,
    presentation: null,
    navigateNested: () => null,
    openTransport,
  };
}

/** The one client a single-acquire transport harness minted, or a thrown assertion. */
function soleClient(clients: readonly FakeStreamClient[]): FakeStreamClient {
  const client = clients.at(0);
  if (client === undefined) throw new Error("expected a minted stream client");
  return client;
}

/** The one session a single-transport harness opened, or a thrown assertion. */
function soleSession(client: FakeStreamClient): FakeStreamSession {
  const session = client.sessions.at(0);
  if (session === undefined) throw new Error("expected a subscribed session");
  return session;
}

function requestIdOf(frame: StreamFrameEnvelope): string {
  const requestId = frame.requestId;
  if (typeof requestId !== "string") {
    throw new Error("expected a frame with a string requestId");
  }
  return requestId;
}

function sentFrameOfKind(
  session: FakeStreamSession,
  kind: string,
): StreamFrameEnvelope {
  const frame = session.sentFrames.find((candidate) => candidate.kind === kind);
  if (frame === undefined) throw new Error(`expected a sent "${kind}" frame`);
  return frame;
}

describe("browser sessions coordinator registry", () => {
  const releasers: Array<() => void> = [];
  afterEach(() => {
    for (const release of releasers.splice(0)) release();
  });

  function acquire(args: {
    readonly scope: HostResourceScope;
    readonly openTransport: (hostId: string) => DurableStreamTransport;
  }): { readonly key: string; readonly release: () => void } {
    const key = coordinatorKey(args.scope);
    const release = acquireBrowserSessionsCoordinator({
      key,
      consumerId: Symbol("consumer"),
      scope: args.scope,
      owner: owner(),
      runtime: buildRuntime(args.openTransport),
      createIfMissing: true,
    });
    releasers.push(release);
    return { key, release };
  }

  it("shares one stream between two consumers acquiring the same key, and keeps it alive until the last releases", () => {
    const harness = createTransportHarness();
    const scope = epicScope("epic-1");
    const first = acquire({ scope, openTransport: harness.openTransport });
    const second = acquire({ scope, openTransport: harness.openTransport });

    expect(first.key).toBe(second.key);
    // A second consumer on the same key joins the existing coordinator - it
    // never opens a transport of its own.
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.subscribes).toHaveLength(1);

    const session = soleSession(soleClient(harness.clients));
    first.release();
    expect(session.closed).toBe(false);
    expect(hasBrowserSessionsCoordinator(first.key)).toBe(true);

    second.release();
    expect(session.closed).toBe(true);
    expect(hasBrowserSessionsCoordinator(first.key)).toBe(false);
  });

  it("keys two scopes on the same host and identity into two coordinators, independent of scope field order", () => {
    const sameOwner = owner();
    const epicKey = browserSessionsCoordinatorKey(
      epicScope("epic-1"),
      sameOwner,
    );
    const independentKey = browserSessionsCoordinatorKey(
      independentScope(),
      sameOwner,
    );
    expect(epicKey).not.toBe(independentKey);

    // Same scope, written with `epicId` before `kind` - the key must not
    // depend on which order the literal's fields were assigned in.
    const reordered: HostResourceScope = { epicId: "epic-1", kind: "epic" };
    expect(browserSessionsCoordinatorKey(reordered, sameOwner)).toBe(epicKey);

    const harness = createTransportHarness();
    acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    acquire({
      scope: independentScope(),
      openTransport: harness.openTransport,
    });
    expect(harness.clients).toHaveLength(2);

    const epicCoordinators = browserSessionsCoordinatorsForEpic("epic-1");
    expect(epicCoordinators.map((entry) => entry.key)).toEqual([epicKey]);
  });

  it("does not resolve a chip's session id against an independent coordinator", () => {
    const harness = createTransportHarness();
    const independent = acquire({
      scope: independentScope(),
      openTransport: harness.openTransport,
    });
    soleSession(soleClient(harness.clients)).emit(
      {
        kind: "snapshot",
        hasBinaryPayload: false,
        sessions: [
          sessionInfo({
            sessionId: "start-page-session",
            scope: independentScope(),
          }),
        ],
      },
      null,
    );
    // The inventory really is there - the lookup below is refusing it on
    // SCOPE, not failing to see it.
    expect(
      browserSessionsCoordinatorState(independent.key)?.items.map(
        (item) => item.sessionId,
      ),
    ).toEqual(["start-page-session"]);

    // A composer chip carries a session id and no host or scope. A Start Page
    // session belongs to the device, not to any task, so an epic surface must
    // not resolve one.
    expect(browserSessionAcrossCoordinators("start-page-session")).toBeNull();

    // The same scan still answers for an epic coordinator, so the narrow is
    // not simply breaking the lookup.
    const epic = acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    const epicClient = harness.clients.at(1);
    if (epicClient === undefined) throw new Error("expected a second client");
    soleSession(epicClient).emit(
      {
        kind: "snapshot",
        hasBinaryPayload: false,
        sessions: [sessionInfo({ sessionId: "task-session" })],
      },
      null,
    );
    expect(browserSessionsCoordinatorState(epic.key)).not.toBeNull();
    expect(browserSessionAcrossCoordinators("task-session")?.sessionId).toBe(
      "task-session",
    );
  });

  it("resolves attachTab from its own actionAck, leaving an interleaved closeTab pending", async () => {
    const harness = createTransportHarness();
    const { key } = acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    const session = soleSession(soleClient(harness.clients));
    const state = browserSessionsCoordinatorState(key);
    if (state === null) throw new Error("expected coordinator state");
    expect(state.lifecycle).toBe("live");

    const attachPromise = state.attachTab("tab-1");
    const closePromise = state.closeTab("session-1", "tab-2");
    let closeSettled = false;
    void closePromise.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );

    const attachRequestId = requestIdOf(sentFrameOfKind(session, "attachTab"));
    const closeRequestId = requestIdOf(sentFrameOfKind(session, "closeTab"));
    expect(attachRequestId).not.toBe(closeRequestId);

    session.emit(
      {
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId: attachRequestId,
        ok: true,
        reason: null,
      },
      null,
    );

    await expect(attachPromise).resolves.toBeUndefined();
    // The close's ack has not arrived yet - the attach's ack must not have
    // resolved or rejected it.
    expect(closeSettled).toBe(false);

    session.emit(
      {
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId: closeRequestId,
        ok: true,
        reason: null,
      },
      null,
    );
    await expect(closePromise).resolves.toBeUndefined();
  });

  it("rejects attachTab with the host's reason on a refused actionAck", async () => {
    const harness = createTransportHarness();
    const { key } = acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    const session = soleSession(soleClient(harness.clients));
    const state = browserSessionsCoordinatorState(key);
    if (state === null) throw new Error("expected coordinator state");

    const attachPromise = state.attachTab("tab-1");
    const requestId = requestIdOf(sentFrameOfKind(session, "attachTab"));
    session.emit(
      {
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId,
        ok: false,
        reason: "tab is bound in another window",
      },
      null,
    );

    await expect(attachPromise).rejects.toThrow(
      "tab is bound in another window",
    );
  });

  it("times out attachTab when no ack arrives, and leaves no pending entry behind", async () => {
    vi.useFakeTimers();
    try {
      const harness = createTransportHarness();
      const { key } = acquire({
        scope: epicScope("epic-1"),
        openTransport: harness.openTransport,
      });
      const session = soleSession(soleClient(harness.clients));
      const state = browserSessionsCoordinatorState(key);
      if (state === null) throw new Error("expected coordinator state");

      const attachPromise = state.attachTab("tab-1");
      const timedOut = expect(attachPromise).rejects.toThrow(
        "Browser sessions request timed out.",
      );
      // Comfortably past ATTACH_TAB_TIMEOUT_MS (10s) without pinning its
      // exact value here.
      await vi.advanceTimersByTimeAsync(60_000);
      await timedOut;

      // No leak: a late ack for the timed-out request id is simply dropped,
      // never crashes, and never resolves an already-settled promise. A
      // second, distinct attachTab call still gets its own live request.
      const staleRequestId = requestIdOf(sentFrameOfKind(session, "attachTab"));
      expect(() =>
        session.emit(
          {
            kind: "actionAck",
            hasBinaryPayload: false,
            requestId: staleRequestId,
            ok: true,
            reason: null,
          },
          null,
        ),
      ).not.toThrow();

      const secondAttach = state.attachTab("tab-2");
      const secondFrame = session.sentFrames
        .filter((frame) => frame.kind === "attachTab")
        .at(-1);
      if (secondFrame === undefined) {
        throw new Error("expected a second attachTab frame");
      }
      session.emit(
        {
          kind: "actionAck",
          hasBinaryPayload: false,
          requestId: requestIdOf(secondFrame),
          ok: true,
          reason: null,
        },
        null,
      );
      await expect(secondAttach).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
