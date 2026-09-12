import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { StreamFrameEnvelope } from "@traycer-clients/shared/host-transport/i-stream-session";
import { BROWSER_SESSIONS_WINDOW_CAP_MESSAGE } from "@traycer-clients/shared/platform/browser-view";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  acquireBrowserSessionsCoordinator,
  browserSessionAcrossCoordinators,
  browserSessionsCoordinatorKey,
  browserSessionsCoordinatorEntries,
  browserSessionsCoordinatorState,
  browserSessionsCoordinatorsForEpic,
  hasBrowserSessionsCoordinator,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  consumeIndependentPageOpenedTab,
  resetIndependentPageOpensForTests,
} from "@/lib/browser-view/sessions/independent-page-open-registry";
import {
  handoffTokenFor,
  resetHandoffTokensForTests,
} from "@/lib/browser-view/sessions/screencast-handoff-tokens";
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

/**
 * Like {@link createTransportHarness}, but its sessions are never born
 * connected - an UNDIALABLE device. The auto-opening harness cannot express
 * one: every retry it serves succeeds on subscribe, so a coordinator can never
 * be observed failing an attempt, which is the whole state the release sweep's
 * bound is about.
 */
function createDownTransportHarness(): {
  readonly openTransport: (hostId: string) => DurableStreamTransport;
  readonly clients: FakeStreamClient[];
} {
  const clients: FakeStreamClient[] = [];
  return {
    clients,
    openTransport: () => {
      const client = new FakeStreamClient(false);
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
    resetIndependentPageOpensForTests();
    resetHandoffTokensForTests();
  });

  function acquire(args: {
    readonly scope: HostResourceScope;
    readonly openTransport: (hostId: string) => DurableStreamTransport;
  }): { readonly key: string; readonly release: () => void } {
    const key = coordinatorKey(args.scope, {});
    const release = acquireBrowserSessionsCoordinator({
      key,
      consumerId: Symbol("consumer"),
      scope: args.scope,
      owner: owner({}),
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

  // The Start Page panel's shape: its authority arm holds `{independent,
  // <device>}` unconditionally, and EVERY browser tile it renders provides the
  // same scope again. Three consumers, one device, one stream - otherwise each
  // tile would open its own inventory push and count the 8-tab cap on its own.
  it("shares one independent stream across a panel arm and its browser tiles", () => {
    const harness = createTransportHarness();
    const scope = independentScope();
    const arm = acquire({ scope, openTransport: harness.openTransport });
    const tileOne = acquire({ scope, openTransport: harness.openTransport });
    const tileTwo = acquire({ scope, openTransport: harness.openTransport });

    expect(tileOne.key).toBe(arm.key);
    expect(tileTwo.key).toBe(arm.key);
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.subscribes).toHaveLength(1);

    const session = soleSession(soleClient(harness.clients));
    // Closing tabs must not take the stream down with them: the arm is what
    // keeps the chord and the chooser's count answerable with no tab open.
    tileOne.release();
    tileTwo.release();
    expect(session.closed).toBe(false);
    expect(hasBrowserSessionsCoordinator(arm.key)).toBe(true);

    arm.release();
    expect(session.closed).toBe(true);
    expect(hasBrowserSessionsCoordinator(arm.key)).toBe(false);
  });

  // An independent stream has no canvas, so its `tabOpened` used to be dropped
  // on a claim about the host that the contract does not make. The Start Page
  // is that scope's surface, and the panel's reconciler is what can reach it -
  // so the frame leaves an identity for it to consume.
  it("records a page-opened independent tab for the Start Page to adopt", () => {
    const harness = createTransportHarness();
    acquire({
      scope: independentScope(),
      openTransport: harness.openTransport,
    });
    const session = soleSession(soleClient(harness.clients));
    session.emitStatus("open");
    // jsdom answers `false` for the whole run; the record is what this window
    // saw AS THE FRAME LANDED, so it is pinned here rather than left to the
    // environment.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);

    session.emit(
      {
        kind: "tabOpened",
        hasBinaryPayload: false,
        sessionId: "device-session",
        tabId: "popup-tab",
        source: "page",
        openerTabId: "opener-tab",
      },
      null,
    );
    hasFocus.mockRestore();

    // With the opener the device named and this window's focus at the time:
    // the reconciler decides from where that tab is on screen, and from which
    // window held focus, whether this window's reader raised the popup.
    expect(
      consumeIndependentPageOpenedTab({
        hostId: "host-1",
        sessionId: "device-session",
        tabId: "popup-tab",
      }),
    ).toEqual({ openerTabId: "opener-tab", raisedWhileFocused: true });
    // Consumed exactly once: a second window adopting the same row later must
    // not have its selection yanked as well.
    expect(
      consumeIndependentPageOpenedTab({
        hostId: "host-1",
        sessionId: "device-session",
        tabId: "popup-tab",
      }),
    ).toBeNull();
  });

  // Agents are epic-scoped on the host, so an agent-sourced frame on an
  // independent stream is not a gesture anyone at this keyboard made.
  it("does not record an agent-opened independent tab", () => {
    const harness = createTransportHarness();
    acquire({
      scope: independentScope(),
      openTransport: harness.openTransport,
    });
    const session = soleSession(soleClient(harness.clients));
    session.emitStatus("open");

    session.emit(
      {
        kind: "tabOpened",
        hasBinaryPayload: false,
        sessionId: "device-session",
        tabId: "agent-tab",
        source: "agent",
        openerTabId: null,
      },
      null,
    );

    expect(
      consumeIndependentPageOpenedTab({
        hostId: "host-1",
        sessionId: "device-session",
        tabId: "agent-tab",
      }),
    ).toBeNull();
  });

  // The desktop refuses a stream over its per-window cap with a terminal
  // `failed`, and the refused coordinator stays mounted under its key with
  // nothing revisiting it. The one edge this renderer sees a slot free on is a
  // coordinator releasing its stream, so that is when the failed are re-asked.
  it("re-asks a failed coordinator when another coordinator releases its stream", () => {
    const harness = createTransportHarness();
    const first = acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    const refused = acquire({
      scope: epicScope("epic-2"),
      openTransport: harness.openTransport,
    });
    expect(harness.clients).toHaveLength(2);
    const firstSession = soleSession(soleClient(harness.clients));
    firstSession.emitStatus("open");
    const refusedClient = harness.clients.at(1);
    if (refusedClient === undefined) {
      throw new Error("expected a second client");
    }
    soleSession(refusedClient).emitFatal("This window has too many streams.");
    expect(browserSessionsCoordinatorState(refused.key)?.lifecycle).toBe(
      "failed",
    );

    first.release();

    // Re-asked exactly once, on a fresh transport - which this harness opens
    // on subscribe, so the coordinator is live again rather than failed.
    expect(harness.clients).toHaveLength(3);
    expect(browserSessionsCoordinatorState(refused.key)?.lifecycle).toBe(
      "live",
    );
    // A coordinator that is not failed is left alone by the same edge.
    const bystander = acquire({
      scope: epicScope("epic-3"),
      openTransport: harness.openTransport,
    });
    bystander.release();
    expect(harness.clients).toHaveLength(4);
  });

  // The OTHER edge main frees a slot on, and the one nothing in this renderer
  // used to watch. A stream main had already ADMITTED - it recorded its
  // identity, so it was counting against the window - can fail while resolving
  // the directory, and main drops it from its registry there. That hands a
  // place back with no consumer having been released, so a coordinator the cap
  // refused stayed failed until some unrelated provider happened to unmount.
  it("re-asks a cap-refused coordinator when an admitted stream fails to open", () => {
    const harness = createTransportHarness();
    const refused = acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    soleSession(soleClient(harness.clients)).emitFatal(
      BROWSER_SESSIONS_WINDOW_CAP_MESSAGE,
    );
    expect(browserSessionsCoordinatorState(refused.key)?.lifecycle).toBe(
      "failed",
    );

    const admitted = acquire({
      scope: epicScope("epic-2"),
      openTransport: harness.openTransport,
    });
    expect(harness.clients).toHaveLength(2);
    const admittedClient = harness.clients.at(1);
    if (admittedClient === undefined) {
      throw new Error("expected a second client");
    }
    // Not the cap message: main admitted this stream and is dropping it, so
    // the window is one stream lighter than it was.
    soleSession(admittedClient).emitFatal("This host is not in the directory.");
    expect(browserSessionsCoordinatorState(admitted.key)?.lifecycle).toBe(
      "failed",
    );

    expect(harness.clients).toHaveLength(3);
    expect(browserSessionsCoordinatorState(refused.key)?.lifecycle).toBe(
      "live",
    );
  });

  // The refusal itself frees nothing - main answers it before it creates a
  // stream - so it must sweep nothing. Two coordinators the cap turned away
  // would otherwise refuse each other in a loop the renderer never leaves.
  it("does not re-ask on a cap refusal, and re-asks only what the cap refused", () => {
    const harness = createTransportHarness();
    const first = acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    const second = acquire({
      scope: epicScope("epic-2"),
      openTransport: harness.openTransport,
    });
    soleSession(soleClient(harness.clients)).emitFatal(
      BROWSER_SESSIONS_WINDOW_CAP_MESSAGE,
    );
    const secondClient = harness.clients.at(1);
    if (secondClient === undefined) throw new Error("expected a second client");
    soleSession(secondClient).emitFatal(BROWSER_SESSIONS_WINDOW_CAP_MESSAGE);

    // Neither refusal opened anything: no third transport was minted.
    expect(harness.clients).toHaveLength(2);
    expect(browserSessionsCoordinatorState(first.key)?.lifecycle).toBe(
      "failed",
    );
    expect(browserSessionsCoordinatorState(second.key)?.lifecycle).toBe(
      "failed",
    );

    // And a stream that failed for a reason of its own is not re-asked by the
    // freeing edge either - only the cap-refused are, which is what bounds
    // the chain: two undialable hosts would each free a place the other's
    // failure swept on, forever.
    const undialable = acquire({
      scope: epicScope("epic-3"),
      openTransport: harness.openTransport,
    });
    const undialableClient = harness.clients.at(2);
    if (undialableClient === undefined) {
      throw new Error("expected a third client");
    }
    soleSession(undialableClient).emitFatal("This host cannot be dialed.");
    // Two retries, for the two cap-refused coordinators, and none for the
    // undialable one that just failed.
    expect(harness.clients).toHaveLength(5);
    expect(browserSessionsCoordinatorState(undialable.key)?.lifecycle).toBe(
      "failed",
    );
  });

  // The release edge cannot bound itself any more. The always-mounted
  // tombstone recovery bridge rotates devices through its slots, and a device
  // YIELDS by failing to answer - which is also what leaves its coordinator
  // failed - so a release arrives with no UI gesture behind it. A `failed`
  // lifecycle also changes what consumers render, so a retry that fails again
  // can unmount the consumer holding an acquisition, and that cleanup is
  // another release. Either way the sweep fed itself, and unbounded nested
  // updates surface as React #185, which takes the window to the crash card.
  it("re-asks a failed coordinator at most once per failure episode", () => {
    const live = createTransportHarness();
    const down = createDownTransportHarness();
    const undialable = acquire({
      scope: epicScope("epic-1"),
      openTransport: down.openTransport,
    });
    soleSession(soleClient(down.clients)).emitFatal(
      "This host cannot be dialed.",
    );
    expect(browserSessionsCoordinatorState(undialable.key)?.lifecycle).toBe(
      "failed",
    );
    expect(down.clients).toHaveLength(1);

    // One release: the sweep re-asks it, on a fresh transport, and that
    // attempt fails too.
    const firstBystander = acquire({
      scope: epicScope("epic-2"),
      openTransport: live.openTransport,
    });
    firstBystander.release();
    expect(down.clients).toHaveLength(2);
    const retried = down.clients.at(1);
    if (retried === undefined) throw new Error("expected a retry transport");
    soleSession(retried).emitFatal("This host cannot be dialed.");
    expect(browserSessionsCoordinatorState(undialable.key)?.lifecycle).toBe(
      "failed",
    );

    // A second release finds nothing has moved this coordinator since its
    // re-ask, so it is left alone. Without the bound every release re-asked
    // it, and each re-ask could produce the next release.
    const secondBystander = acquire({
      scope: epicScope("epic-3"),
      openTransport: live.openTransport,
    });
    secondBystander.release();
    expect(down.clients).toHaveLength(2);
    expect(browserSessionsCoordinatorState(undialable.key)?.lifecycle).toBe(
      "failed",
    );
  });

  // The bound is per EPISODE, not for the life of the coordinator: a device
  // that comes back and later drops again is a new outage and earns a fresh
  // re-ask. Reaching `live` is what re-arms it - and deliberately not merely
  // leaving `failed`, since a retry publishes `connecting` on its way out and
  // arming on that would hand the flag back once per attempt.
  it("re-arms the release sweep once the stream actually opens", () => {
    const live = createTransportHarness();
    const down = createDownTransportHarness();
    const flaky = acquire({
      scope: epicScope("epic-1"),
      openTransport: down.openTransport,
    });
    soleSession(soleClient(down.clients)).emitFatal(
      "This host cannot be dialed.",
    );

    const firstBystander = acquire({
      scope: epicScope("epic-2"),
      openTransport: live.openTransport,
    });
    firstBystander.release();
    expect(down.clients).toHaveLength(2);
    const retried = down.clients.at(1);
    if (retried === undefined) throw new Error("expected a retry transport");

    // This attempt OPENS, then drops later - a second, genuine outage.
    soleSession(retried).emitStatus("open");
    expect(browserSessionsCoordinatorState(flaky.key)?.lifecycle).toBe("live");
    soleSession(retried).emitFatal("This host cannot be dialed.");
    expect(browserSessionsCoordinatorState(flaky.key)?.lifecycle).toBe(
      "failed",
    );

    const secondBystander = acquire({
      scope: epicScope("epic-3"),
      openTransport: live.openTransport,
    });
    secondBystander.release();
    expect(down.clients).toHaveLength(3);
  });

  it("keys two scopes on the same host and identity into two coordinators, independent of scope field order", () => {
    const sameOwner = owner({});
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

  /**
   * The cross-epic reader Home lists browsers through. Its two properties are
   * the ones a per-epic reader cannot be asked about: which scopes it admits,
   * and whether an entry survives the last release.
   */
  describe("browserSessionsCoordinatorEntries", () => {
    it("enumerates every epic-scoped coordinator with the epic it belongs to", () => {
      const harness = createTransportHarness();
      const first = acquire({
        scope: epicScope("epic-1"),
        openTransport: harness.openTransport,
      });
      const second = acquire({
        scope: epicScope("epic-2"),
        openTransport: harness.openTransport,
      });

      expect(
        browserSessionsCoordinatorEntries()
          .map((entry) => [entry.epicId, entry.key])
          .sort(),
      ).toEqual(
        [
          ["epic-1", first.key],
          ["epic-2", second.key],
        ].sort(),
      );
    });

    it("skips an independent coordinator, which belongs to no task", () => {
      const harness = createTransportHarness();
      acquire({
        scope: independentScope(),
        openTransport: harness.openTransport,
      });
      const epic = acquire({
        scope: epicScope("epic-1"),
        openTransport: harness.openTransport,
      });

      // A Start Page browser session belongs to the device rather than to any
      // task, so it has no task to be listed under on a cross-task page.
      expect(
        browserSessionsCoordinatorEntries().map((entry) => entry.key),
      ).toEqual([epic.key]);
    });

    it("drops an entry once its last consumer releases", () => {
      const harness = createTransportHarness();
      const scope = epicScope("epic-1");
      const canvas = acquire({ scope, openTransport: harness.openTransport });
      const tile = acquire({ scope, openTransport: harness.openTransport });
      expect(browserSessionsCoordinatorEntries()).toHaveLength(1);

      // A reader of this list holds no consumer of its own, so it cannot keep
      // one alive - which is what makes Home's rows honestly window-local.
      canvas.release();
      expect(browserSessionsCoordinatorEntries()).toHaveLength(1);

      tile.release();
      expect(browserSessionsCoordinatorEntries()).toEqual([]);
    });

    it("reports the coordinator's live state rather than a copy", () => {
      const harness = createTransportHarness();
      acquire({
        scope: epicScope("epic-1"),
        openTransport: harness.openTransport,
      });
      expect(
        browserSessionsCoordinatorEntries().map(
          (entry) => entry.state.inventoryReady,
        ),
      ).toEqual([false]);

      soleSession(soleClient(harness.clients)).emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessions: [sessionInfo({ sessionId: "session-1" })],
        },
        null,
      );

      expect(
        browserSessionsCoordinatorEntries().map((entry) => [
          entry.state.inventoryReady,
          entry.state.items.map((item) => item.sessionId),
        ]),
      ).toEqual([[true, ["session-1"]]]);
    });
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

  // The unit a per-connection ANSWER is valid for. A reader that latches one -
  // the tile does, for the `@1` "cannot place a tab in a window" refusal - has
  // to be able to tell that the connection it was given on is gone, and
  // `lifecycle` cannot say so because it returns to the same `"live"` string.
  it("bumps the connection generation once per established connection", () => {
    const harness = createTransportHarness();
    const { key } = acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    const session = soleSession(soleClient(harness.clients));
    const generation = (): number => {
      const state = browserSessionsCoordinatorState(key);
      if (state === null) throw new Error("expected coordinator state");
      return state.connectionGeneration;
    };

    const first = generation();
    expect(first).toBeGreaterThan(0);

    // Idempotent while the same connection stays up: a repeated `open` is not
    // a new connection and must not invent one.
    session.emitStatus("open");
    expect(generation()).toBe(first);

    // A drop on its own is not a connection either - only coming back up is.
    session.emitStatus("reconnecting");
    expect(generation()).toBe(first);
    session.emitStatus("open");
    expect(generation()).toBe(first + 1);

    // And a same-version reconnect counts, which is the whole reason this is a
    // counter rather than the negotiated `SchemaVersion`: a host restarted at
    // its old build has forgotten every refusal it ever issued.
    session.emitStatus("reconnecting");
    session.emitStatus("open");
    expect(generation()).toBe(first + 2);
  });

  // The coordinator is not the unit a generation identifies - the CONNECTION
  // is - and a coordinator is disposed and rebuilt under the same key while
  // its consumers stay mounted holding its answers. `use-browser-sessions`
  // drops `owner` the moment the host's authenticated directory identity does,
  // which a local host restarting is; the acquire effect's cleanup then
  // releases the last consumer and disposes the instance. A counter living on
  // the instance restarts there, and the replacement's first connection lands
  // on the number the previous instance's first connection already handed out.
  it("never reuses a generation across a disposed coordinator and its replacement", () => {
    const harness = createTransportHarness();
    const scope = epicScope("epic-1");
    const generationOf = (key: string): number => {
      const state = browserSessionsCoordinatorState(key);
      if (state === null) throw new Error("expected coordinator state");
      return state.connectionGeneration;
    };

    const first = acquire({ scope, openTransport: harness.openTransport });
    const disposedGenerations = [generationOf(first.key)];
    soleSession(soleClient(harness.clients)).emitStatus("reconnecting");
    soleSession(soleClient(harness.clients)).emitStatus("open");
    disposedGenerations.push(generationOf(first.key));

    // The last consumer leaving is what disposes it.
    first.release();
    expect(hasBrowserSessionsCoordinator(first.key)).toBe(false);

    const second = acquire({ scope, openTransport: harness.openTransport });
    expect(second.key).toBe(first.key);
    const replacementGeneration = generationOf(second.key);

    // Relative, never absolute: the counter is module-scoped, so its values
    // carry across every test in this file.
    expect(disposedGenerations).not.toContain(replacementGeneration);
    expect(replacementGeneration).toBeGreaterThan(
      Math.max(...disposedGenerations),
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

  it("sends one moveTab frame carrying the tab id", async () => {
    const harness = createTransportHarness();
    const { key } = acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    const session = soleSession(soleClient(harness.clients));
    const state = browserSessionsCoordinatorState(key);
    if (state === null) throw new Error("expected coordinator state");

    const movePromise = state.moveTab("tab-1");
    const moveFrames = session.sentFrames.filter(
      (frame) => frame.kind === "moveTab",
    );
    expect(moveFrames).toHaveLength(1);
    expect(moveFrames[0]).toMatchObject({ kind: "moveTab", tabId: "tab-1" });

    // Settling it here is also the demux case (design D8): without
    // `pendingMoves` wired into `handleActionAck`'s array, a `moveTab` ack is
    // matched against no map, this promise never resolves, and the tile's
    // button sits on "Moving…" until the coordinator's own 10s timeout.
    const requestId = requestIdOf(sentFrameOfKind(session, "moveTab"));
    session.emit(
      {
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId,
        ok: true,
        reason: null,
      },
      null,
    );
    await expect(movePromise).resolves.toBeUndefined();
  });

  it("rejects moveTab with the host's reason on a refused actionAck", async () => {
    const harness = createTransportHarness();
    const { key } = acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    const session = soleSession(soleClient(harness.clients));
    const state = browserSessionsCoordinatorState(key);
    if (state === null) throw new Error("expected coordinator state");

    const movePromise = state.moveTab("tab-1");
    const requestId = requestIdOf(sentFrameOfKind(session, "moveTab"));
    session.emit(
      {
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId,
        ok: false,
        reason: "This browser tab is being driven by an agent.",
      },
      null,
    );

    await expect(movePromise).rejects.toThrow(
      "This browser tab is being driven by an agent.",
    );
  });

  it("rejects an outstanding moveTab when the stream stops being live", async () => {
    const harness = createTransportHarness();
    const { key } = acquire({
      scope: epicScope("epic-1"),
      openTransport: harness.openTransport,
    });
    const session = soleSession(soleClient(harness.clients));
    const state = browserSessionsCoordinatorState(key);
    if (state === null) throw new Error("expected coordinator state");

    const movePromise = state.moveTab("tab-1");
    expect(sentFrameOfKind(session, "moveTab")).toBeDefined();

    session.emitStatus("closed");

    await expect(movePromise).rejects.toThrow(
      "Browser sessions stream closed.",
    );
  });

  /**
   * The open's answer and the screencast that watches its tab travel on
   * different streams, so the token crosses between them through the
   * handoff-token registry. It has to be there BEFORE the open resolves - the
   * tile mounts in response to that resolution - and it must be gone once the
   * session is, so a later tab reusing nothing of it never presents it.
   */
  it("records the handoff token an open is answered with, for this client's screencast of that tab", async () => {
    const harness = createTransportHarness();
    const { key } = acquire({
      scope: independentScope(),
      openTransport: harness.openTransport,
    });
    const session = soleSession(soleClient(harness.clients));
    const state = browserSessionsCoordinatorState(key);
    if (state === null) throw new Error("expected coordinator state");
    const tab = { hostId: "host-1", sessionId: "session-1", tabId: "tab-1" };

    let openedWith: string | null | undefined;
    const openPromise = state
      .openTab(null, "https://example.com")
      .then((opened) => {
        // Observed inside the resolution: the token is already recorded by
        // the time any caller learns the tab exists.
        openedWith = handoffTokenFor(tab);
        return opened;
      });
    const requestId = requestIdOf(sentFrameOfKind(session, "openTab"));
    session.emit(
      {
        kind: "openTabResult",
        hasBinaryPayload: false,
        requestId,
        result: {
          ok: true,
          sessionId: "session-1",
          tabId: "tab-1",
          handoffToken: "handoff-1",
        },
      },
      null,
    );
    await expect(openPromise).resolves.toEqual({
      sessionId: "session-1",
      tabId: "tab-1",
      handoffToken: "handoff-1",
    });
    expect(openedWith).toBe("handoff-1");
    // Another tab of the same session is a bystander's view.
    expect(handoffTokenFor({ ...tab, tabId: "tab-2" })).toBeNull();

    session.emit(
      {
        kind: "sessionClosed",
        hasBinaryPayload: false,
        sessionId: "session-1",
        reason: "completed",
      },
      null,
    );
    expect(handoffTokenFor(tab)).toBeNull();
  });

  it("records nothing for an open that owed no placement", async () => {
    const harness = createTransportHarness();
    const { key } = acquire({
      scope: independentScope(),
      openTransport: harness.openTransport,
    });
    const session = soleSession(soleClient(harness.clients));
    const state = browserSessionsCoordinatorState(key);
    if (state === null) throw new Error("expected coordinator state");

    const openPromise = state.openTab(null, "https://example.com");
    const requestId = requestIdOf(sentFrameOfKind(session, "openTab"));
    session.emit(
      {
        kind: "openTabResult",
        hasBinaryPayload: false,
        requestId,
        result: {
          ok: true,
          sessionId: "session-1",
          tabId: "tab-1",
          handoffToken: null,
        },
      },
      null,
    );
    await expect(openPromise).resolves.toMatchObject({ handoffToken: null });
    expect(
      handoffTokenFor({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
      }),
    ).toBeNull();
  });
});
