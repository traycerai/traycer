import "fake-indexeddb/auto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { StreamFrameEnvelope } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { BrowserOwnerInventoryEvidence } from "@traycer/protocol/host/browser/catalog-contracts";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  acquireBrowserSessionsCoordinator,
  browserSessionsCoordinatorState,
  hasBrowserSessionsCoordinator,
  type BrowserSessionsCoordinatorRuntime,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { useAuthStore } from "@/stores/auth/auth-store";
import { browserCatalogInventory } from "@/lib/browser-view/sessions/browser-catalog-inventory";
import {
  closeBrowserCatalogTab,
  runBrowserCatalogOwnerAction,
} from "@/lib/browser-view/sessions/browser-catalog-owner-action";
import {
  coordinatorKey,
  epicScope,
  independentScope,
  owner,
  sessionInfo,
  tabInfo,
} from "./browser-session-test-kit";

const HOST = "host-b";
const capability = {
  catalogVersion: 1,
  durableInventoryRevisions: true,
  revisionedMutationAcks: true,
} as const;

let epicCounter = 0;
let epicId = "";
let userScope = { userId: "user-1", epicId: "" };

function liveEvidence(
  sessionId: string,
  rev: number,
): BrowserOwnerInventoryEvidence {
  return {
    kind: "live",
    record: {
      epicId,
      hostId: HOST,
      sessionId,
      inventoryRevision: rev,
      lastActivityAt: 1,
      tabs: [{ tabId: "tab-keep", title: null, url: "https://example.test" }],
    },
  };
}

interface Harness {
  readonly runtime: BrowserSessionsCoordinatorRuntime;
  readonly clients: FakeStreamClient[];
  readonly hostIds: string[];
  readonly latest: () => FakeStreamSession;
}

function harness(): Harness {
  const clients: FakeStreamClient[] = [];
  const hostIds: string[] = [];
  const runtime: BrowserSessionsCoordinatorRuntime = {
    browserView: null,
    userId: "user-1",
    localHostId: null,
    presentation: null,
    navigateNested: () => null,
    openTransport: (hostId): DurableStreamTransport => {
      hostIds.push(hostId);
      const client = new FakeStreamClient(true);
      clients.push(client);
      return { wsStreamClient: client, close: () => undefined };
    },
  };
  const latest = (): FakeStreamSession => {
    const session = clients.flatMap((client) => client.sessions).at(-1);
    if (session === undefined) throw new Error("expected a subscribed session");
    return session;
  };
  return { runtime, clients, hostIds, latest };
}

function bringOnline(
  session: FakeStreamSession,
  options: { readonly durable: boolean },
): void {
  session.negotiatedSchemaVersion = {
    major: 2,
    minor: options.durable ? 3 : 2,
  };
  if (options.durable) {
    session.emit(
      {
        kind: "ownerInventorySnapshot",
        hasBinaryPayload: false,
        capability,
        inventory: { epicId, hostId: HOST, sessions: [] },
      },
      null,
    );
  }
  session.emit(
    {
      kind: "snapshot",
      hasBinaryPayload: false,
      sessions: [
        sessionInfo({
          sessionId: "session-1",
          hostId: HOST,
          scope: epicScope(epicId),
          tabs: [
            tabInfo({ tabId: "tab-close" }),
            tabInfo({ tabId: "tab-keep" }),
          ],
        }),
      ],
    },
    null,
  );
}

/** The stream opens once the durable load settles, so wait for it before driving it. */
async function bringOnlineWhenSubscribed(
  h: Harness,
  options: { readonly durable: boolean },
): Promise<void> {
  await vi.waitFor(() =>
    expect(h.clients.flatMap((client) => client.sessions)).not.toHaveLength(0),
  );
  bringOnline(h.latest(), options);
}

function closeFrameOf(
  session: FakeStreamSession,
): StreamFrameEnvelope | undefined {
  return session.framesOfKind("closeTab").at(-1);
}

function ack(
  session: FakeStreamSession,
  requestId: unknown,
  ok: boolean,
  reason: string | null,
): void {
  session.emit(
    { kind: "actionAck", hasBinaryPayload: false, requestId, ok, reason },
    null,
  );
}

function mutationAck(
  session: FakeStreamSession,
  requestId: unknown,
  evidence: BrowserOwnerInventoryEvidence,
): void {
  session.emit(
    {
      kind: "inventoryMutationAck",
      hasBinaryPayload: false,
      requestId,
      evidence,
    },
    null,
  );
}

describe("browser catalog owner actions", () => {
  beforeEach(() => {
    epicCounter += 1;
    epicId = `epic-owner-${epicCounter}`;
    userScope = { userId: "user-1", epicId };
    useAuthStore.setState({
      contextMetadata: { userId: "user-1", username: "user-1" },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    useAuthStore.setState({ contextMetadata: null });
  });

  function startClose(h: Harness, hostId: string): Promise<void> {
    const promise = closeBrowserCatalogTab({
      identity: { epicId, hostId, sessionId: "session-1" },
      tabId: "tab-close",
      owner: owner({ hostId, identityKey: "identity-b" }),
      runtime: h.runtime,
    });
    // Mirror the rejection so a late settlement is never reported as unhandled.
    promise.catch(() => undefined);
    return promise;
  }

  async function sentClose(h: Harness): Promise<string> {
    await vi.waitFor(() => expect(closeFrameOf(h.latest())).toBeDefined());
    const requestId = closeFrameOf(h.latest())?.requestId;
    if (typeof requestId !== "string")
      throw new Error("expected a close request id");
    return requestId;
  }

  it("sends the close only to the owning host and journals its ACK before the close resolves", async () => {
    const h = harness();
    const closing = startClose(h, HOST);
    await bringOnlineWhenSubscribed(h, { durable: true });
    const requestId = await sentClose(h);

    expect(h.hostIds).toEqual([HOST]);
    expect(closeFrameOf(h.latest())).toMatchObject({
      sessionId: "session-1",
      tabId: "tab-close",
    });

    mutationAck(h.latest(), requestId, liveEvidence("session-1", 12));
    ack(h.latest(), requestId, true, null);
    await closing;

    expect(
      browserCatalogInventory
        .read(userScope)
        .records.map((r) => r.inventoryRevision),
    ).toEqual([12]);
    expect(browserCatalogInventory.read(userScope).pendingCount).toBe(1);
  });

  it("does not resolve a close whose ACK carries no durable evidence", async () => {
    const h = harness();
    const closing = startClose(h, HOST);
    await bringOnlineWhenSubscribed(h, { durable: true });
    const requestId = await sentClose(h);

    ack(h.latest(), requestId, true, null);

    await expect(closing).rejects.toThrow();
    expect(browserCatalogInventory.read(userScope).records).toEqual([]);
  });

  it("rejects with the host's reason when the owner refuses the close, journaling nothing", async () => {
    const h = harness();
    const closing = startClose(h, HOST);
    await bringOnlineWhenSubscribed(h, { durable: true });
    const requestId = await sentClose(h);

    ack(h.latest(), requestId, false, "Close is incomplete on this device.");

    await expect(closing).rejects.toThrow(
      "Close is incomplete on this device.",
    );
    expect(browserCatalogInventory.read(userScope).pendingCount).toBe(0);
  });

  it("rejects the close when the evidence cannot be saved", async () => {
    const h = harness();
    const closing = startClose(h, HOST);
    await bringOnlineWhenSubscribed(h, { durable: true });
    const requestId = await sentClose(h);
    // Access to the task is withdrawn after the close left, before its evidence lands.
    await browserCatalogInventory.purge(userScope);

    mutationAck(h.latest(), requestId, liveEvidence("session-1", 12));
    ack(h.latest(), requestId, true, null);

    await expect(closing).rejects.toThrow("Could not save browser inventory");
  });

  it("releases only its own interest: an independent viewer keeps the stream and the journal keeps the evidence", async () => {
    const h = harness();
    const scope = epicScope(epicId);
    const key = coordinatorKey(scope, {
      hostId: HOST,
      identityKey: "identity-b",
    });
    const releaseViewer = acquireBrowserSessionsCoordinator({
      key,
      consumerId: Symbol("viewer"),
      scope,
      owner: owner({ hostId: HOST, identityKey: "identity-b" }),
      runtime: h.runtime,
      createIfMissing: true,
    });
    await vi.waitFor(() => expect(h.clients).toHaveLength(1));
    const session = h.latest();
    bringOnline(session, { durable: true });

    const closing = startClose(h, HOST);
    const requestId = await sentClose(h);
    mutationAck(session, requestId, liveEvidence("session-1", 12));
    ack(session, requestId, true, null);
    await closing;

    expect(h.clients).toHaveLength(1);
    expect(session.closed).toBe(false);
    expect(hasBrowserSessionsCoordinator(key)).toBe(true);
    releaseViewer();
    expect(hasBrowserSessionsCoordinator(key)).toBe(false);
    expect(
      browserCatalogInventory
        .read(userScope)
        .records.map((r) => r.inventoryRevision),
    ).toEqual([12]);
  });

  it("ignores owner evidence from a stream whose user is no longer signed in", async () => {
    const h = harness();
    const closing = startClose(h, HOST);
    await bringOnlineWhenSubscribed(h, { durable: true });
    const requestId = await sentClose(h);

    useAuthStore.setState({
      contextMetadata: { userId: "user-2", username: "user-2" },
    });
    mutationAck(h.latest(), requestId, liveEvidence("session-1", 12));
    ack(h.latest(), requestId, true, null);

    await expect(closing).rejects.toThrow();
    expect(browserCatalogInventory.read(userScope).records).toEqual([]);
  });

  it("rejects a close whose owner journal committed when the signed-in user changes before the write is acknowledged", async () => {
    const h = harness();
    const closing = startClose(h, HOST);
    await bringOnlineWhenSubscribed(h, { durable: true });
    const requestId = await sentClose(h);

    const realOwner = browserCatalogInventory.owner.bind(
      browserCatalogInventory,
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let committed: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const spy = vi
      .spyOn(browserCatalogInventory, "owner")
      .mockImplementation(async (...args) => {
        await realOwner(...args);
        committed();
        await gate;
      });
    onTestFinished(() => spy.mockRestore());

    mutationAck(h.latest(), requestId, liveEvidence("session-1", 12));
    ack(h.latest(), requestId, true, null);
    await entered;
    expect(
      browserCatalogInventory
        .read(userScope)
        .records.map((r) => r.inventoryRevision),
    ).toEqual([12]);

    useAuthStore.setState({
      contextMetadata: { userId: "user-2", username: "user-2" },
    });
    release();

    await expect(closing).rejects.toThrow("Sign in to use this browser tab.");
  });

  it("completes an ordinary close under local-only with no cloud rows and no save error, and keeps the mode across a reload", async () => {
    await browserCatalogInventory.load(userScope);
    await browserCatalogInventory.accept(
      userScope,
      { kind: "local-only" },
      browserCatalogInventory.epoch(userScope),
    );

    const h = harness();
    const closing = startClose(h, HOST);
    await bringOnlineWhenSubscribed(h, { durable: true });
    const requestId = await sentClose(h);
    ack(h.latest(), requestId, true, null);
    await closing;

    expect(browserCatalogInventory.read(userScope).status).toBe("local-only");
    expect(browserCatalogInventory.read(userScope).records).toEqual([]);
    expect(browserCatalogInventory.read(userScope).pendingCount).toBe(0);

    vi.resetModules();
    const reloaded =
      await import("@/lib/browser-view/sessions/browser-catalog-inventory");
    await reloaded.browserCatalogInventory.load(userScope);
    expect(reloaded.browserCatalogInventory.read(userScope).status).toBe(
      "local-only",
    );
    expect(reloaded.browserCatalogInventory.read(userScope).records).toEqual(
      [],
    );
  });

  it("rejects a local-only close once the signed-in user has changed, journaling nothing", async () => {
    await browserCatalogInventory.load(userScope);
    await browserCatalogInventory.accept(
      userScope,
      { kind: "local-only" },
      browserCatalogInventory.epoch(userScope),
    );
    const h = harness();
    const closing = startClose(h, HOST);
    await bringOnlineWhenSubscribed(h, { durable: true });
    const requestId = await sentClose(h);

    useAuthStore.setState({
      contextMetadata: { userId: "user-2", username: "user-2" },
    });
    ack(h.latest(), requestId, true, null);

    await expect(closing).rejects.toThrow("Sign in to use this browser tab.");
    expect(browserCatalogInventory.read(userScope).records).toEqual([]);
    expect(browserCatalogInventory.read(userScope).pendingCount).toBe(0);
  });

  describe("a close driven straight through the coordinator", () => {
    async function closeOn(
      scope: HostResourceScope,
      userId: string | null,
    ): Promise<{
      readonly closing: Promise<void>;
      readonly session: FakeStreamSession;
    }> {
      const h = harness();
      const key = coordinatorKey(scope, {
        hostId: HOST,
        identityKey: "identity-b",
      });
      const release = acquireBrowserSessionsCoordinator({
        key,
        consumerId: Symbol("direct"),
        scope,
        owner: owner({ hostId: HOST, identityKey: "identity-b" }),
        runtime: { ...h.runtime, userId },
        createIfMissing: true,
      });
      onTestFinished(release);
      await vi.waitFor(() =>
        expect(h.clients.flatMap((client) => client.sessions)).not.toHaveLength(
          0,
        ),
      );
      const session = h.latest();
      // The first frame is what advertises the 2.3 capability.
      session.negotiatedSchemaVersion = { major: 2, minor: 3 };
      session.emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessions: [
            sessionInfo({
              sessionId: "session-1",
              hostId: HOST,
              scope,
              tabs: [tabInfo({ tabId: "tab-close" })],
            }),
          ],
        },
        null,
      );
      const state = browserSessionsCoordinatorState(key);
      if (state === null) throw new Error("expected coordinator state");
      const closing = state.closeTab("session-1", "tab-close");
      closing.catch(() => undefined);
      return { closing, session };
    }

    it("completes an independent close on a 2.3 stream from a plain ACK, since it has no durable catalog", async () => {
      const { closing, session } = await closeOn(independentScope(), "user-1");
      const requestId = closeFrameOf(session)?.requestId;

      ack(session, requestId, true, null);

      await expect(closing).resolves.toBeUndefined();
    });

    it("rejects an epic close on a 2.3 stream that has no signed-in user", async () => {
      const { closing, session } = await closeOn(epicScope(epicId), null);
      const requestId = closeFrameOf(session)?.requestId;

      ack(session, requestId, true, null);

      await expect(closing).rejects.toThrow("Sign in to use this browser tab.");
    });
  });

  it("refuses a peer that never advertises durable inventory once the wait ends, without running the action", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const action = vi.fn(() => Promise.resolve());
    const running = runBrowserCatalogOwnerAction({
      epicId,
      owner: owner({ hostId: HOST, identityKey: "identity-b" }),
      runtime: h.runtime,
      requireDurable: true,
      action,
    });
    running.catch(() => undefined);
    await bringOnlineWhenSubscribed(h, { durable: false });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(running).rejects.toThrow(
      "Couldn't read this device's saved browser tabs.",
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("lets a non-durable action run against a legacy peer", async () => {
    const h = harness();
    const running = runBrowserCatalogOwnerAction({
      epicId,
      owner: owner({ hostId: HOST, identityKey: "identity-b" }),
      runtime: h.runtime,
      requireDurable: false,
      action: (state) => Promise.resolve(state.lifecycle),
    });
    await bringOnlineWhenSubscribed(h, { durable: false });

    await expect(running).resolves.toBe("live");
  });

  async function revokeDevice(hostId: string): Promise<void> {
    await browserCatalogInventory.load(userScope);
    await browserCatalogInventory.accept(
      userScope,
      {
        kind: "available",
        snapshot: {
          kind: "snapshot",
          version: 1,
          records: [],
          fences: [],
          readiness: [],
          revokedHostIds: [hostId],
        },
      },
      browserCatalogInventory.epoch(userScope),
    );
  }

  it("refuses an action on a revoked device before any connection is opened", async () => {
    await revokeDevice(HOST);
    const h = harness();
    const action = vi.fn(() => Promise.resolve());

    await expect(
      runBrowserCatalogOwnerAction({
        epicId,
        owner: owner({ hostId: HOST, identityKey: "identity-b" }),
        runtime: h.runtime,
        requireDurable: false,
        action,
      }),
    ).rejects.toThrow("Browser access is unavailable for this device.");

    expect(h.hostIds).toEqual([]);
    expect(action).not.toHaveBeenCalled();
  });

  it("refuses a device whose revocation was only persisted, with no inventory preloaded in the new session", async () => {
    await revokeDevice(HOST);

    vi.resetModules();
    const freshAuth = await import("@/stores/auth/auth-store");
    const freshRunner =
      await import("@/lib/browser-view/sessions/browser-catalog-owner-action");
    freshAuth.useAuthStore.setState({
      contextMetadata: { userId: "user-1", username: "user-1" },
    });
    const h = harness();
    const action = vi.fn(() => Promise.resolve());

    try {
      await expect(
        freshRunner.runBrowserCatalogOwnerAction({
          epicId,
          owner: owner({ hostId: HOST, identityKey: "identity-b" }),
          runtime: h.runtime,
          requireDurable: false,
          action,
        }),
      ).rejects.toThrow("Browser access is unavailable for this device.");
    } finally {
      freshAuth.useAuthStore.setState({ contextMetadata: null });
    }

    expect(h.hostIds).toEqual([]);
    expect(action).not.toHaveBeenCalled();
  });

  it("refuses the action and releases its interest when the device is revoked while the owner is still becoming ready", async () => {
    const h = harness();
    const scope = epicScope(epicId);
    const key = coordinatorKey(scope, {
      hostId: HOST,
      identityKey: "identity-b",
    });
    const action = vi.fn(() => Promise.resolve());
    const running = runBrowserCatalogOwnerAction({
      epicId,
      owner: owner({ hostId: HOST, identityKey: "identity-b" }),
      runtime: h.runtime,
      requireDurable: false,
      action,
    });
    running.catch(() => undefined);
    await vi.waitFor(() => expect(h.clients).toHaveLength(1));

    await revokeDevice(HOST);
    await bringOnlineWhenSubscribed(h, { durable: true });

    await expect(running).rejects.toThrow(
      "Browser access is unavailable for this device.",
    );
    expect(action).not.toHaveBeenCalled();
    expect(hasBrowserSessionsCoordinator(key)).toBe(false);
  });

  it("rejects an identity that names a different owner without opening any connection", async () => {
    const h = harness();
    await expect(
      closeBrowserCatalogTab({
        identity: { epicId, hostId: "host-other", sessionId: "session-1" },
        tabId: "tab-close",
        owner: owner({ hostId: HOST, identityKey: "identity-b" }),
        runtime: h.runtime,
      }),
    ).rejects.toThrow();
    expect(h.hostIds).toEqual([]);
  });

  it("keeps an unanswered close unknown after re-reading the owner, even when the tab is gone from the snapshot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const closing = startClose(h, HOST);
    await bringOnlineWhenSubscribed(h, { durable: true });
    await sentClose(h);

    await vi.advanceTimersByTimeAsync(10_000);
    // The retry reconnects; the owner's fresh inventory no longer lists the tab.
    const reconnected = h.latest();
    reconnected.negotiatedSchemaVersion = { major: 2, minor: 3 };
    reconnected.emit(
      {
        kind: "ownerInventorySnapshot",
        hasBinaryPayload: false,
        capability,
        inventory: {
          epicId,
          hostId: HOST,
          sessions: [liveEvidence("session-1", 12)],
        },
      },
      null,
    );
    reconnected.emit(
      {
        kind: "snapshot",
        hasBinaryPayload: false,
        sessions: [
          sessionInfo({
            sessionId: "session-1",
            hostId: HOST,
            scope: epicScope(epicId),
            tabs: [tabInfo({ tabId: "tab-keep" })],
          }),
        ],
      },
      null,
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(closing).rejects.toThrow(
      "Browser sessions request timed out.",
    );
  });
});
