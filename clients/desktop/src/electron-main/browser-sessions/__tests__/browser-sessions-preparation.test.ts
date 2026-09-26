import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionsServerFrame } from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsStreamEventEnvelope } from "@traycer-clients/shared/platform/browser-view";
import { BrowserSessionsRegistry } from "../browser-sessions-owner";
import {
  createRegistryHarness,
  type FakeStreamSession,
  type RegistryHarness,
} from "./browser-sessions-stream-fixture";

/**
 * A routed cell's automatic preparation and a window's UI are two independent
 * reasons to keep one main-owned stream. These pin that it lives exactly as
 * long as at least one of them remains: a UI close never drops a stream a
 * cell or a native tab still needs, and the last thing leaving closes it.
 */

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

const KEY = {
  scope: { kind: "epic", epicId: "epic-1" } as const,
  hostId: "host-1",
  identityKey: "identity-1",
};

function snapshotFrame(): BrowserSessionsServerFrame {
  return { kind: "snapshot", hasBinaryPayload: false, sessions: [] };
}

function createTabFrame(
  requestId: string,
  reason: "session-bootstrap" | "restore",
): BrowserSessionsServerFrame {
  return {
    kind: "createElectronTab",
    hasBinaryPayload: false,
    requestId,
    sessionId: "session-1",
    tabId: "tab-1",
    requestedUrl: "https://example.com/",
    reason,
    profile: "primary",
    seedStorageState: null,
  };
}

function acceptedFrame(requestId: string): BrowserSessionsServerFrame {
  return {
    kind: "electronTabAccepted",
    hasBinaryPayload: false,
    requestId,
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
  };
}

/** The directory read, plus the attach it schedules behind it. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

function eventKinds(
  emitted: ReadonlyArray<{
    readonly envelope: BrowserSessionsStreamEventEnvelope;
  }>,
): readonly string[] {
  return emitted.map((entry) => entry.envelope.event.kind);
}

describe("main-owned browser.sessions streams held by preparation and UI", () => {
  let harness: RegistryHarness;
  let registry: BrowserSessionsRegistry;

  beforeEach(() => {
    harness = createRegistryHarness();
    registry = new BrowserSessionsRegistry(harness.deps);
  });

  /**
   * Drives the newest stream to `open` with its snapshot delivered. `line` is
   * the schema line the host negotiated: preparation needs 2.2, and a stream
   * built on an older host cannot honour it.
   */
  async function openNewestStream(line: {
    readonly major: number;
    readonly minor: number;
  }): Promise<FakeStreamSession> {
    await settle();
    const client = harness.clients.at(-1);
    const session = client?.sessions[0];
    if (session === undefined) throw new Error("no stream was subscribed");
    session.negotiatedSchemaVersion = line;
    session.emitStatus("open");
    session.emit(snapshotFrame(), null);
    return session;
  }

  const CURRENT_LINE = { major: 2, minor: 2 } as const;

  async function bindOneTab(session: FakeStreamSession): Promise<void> {
    session.emit(createTabFrame("create-1", "session-bootstrap"), null);
    await settle();
    session.emit(acceptedFrame("create-1"), null);
    await settle();
  }

  function releaseTabFrame(): BrowserSessionsServerFrame {
    return {
      kind: "releaseElectronTab",
      hasBinaryPayload: false,
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    };
  }

  it("opens a demand-only stream that announces itself as on-demand readiness", async () => {
    const release = registry.acquirePreparation(
      "window-1",
      KEY,
      () => undefined,
    );
    expect(release).not.toBeNull();

    const session = await openNewestStream(CURRENT_LINE);

    const ready = session.framesOfKind("electronTabLifecycleReadyOnDemand");
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ desktopWindowId: "window-1" });
    expect(session.framesOfKind("electronTabLifecycleReady")).toEqual([]);
  });

  it("closes a stream nobody needs when the last no-tab preparation is released", async () => {
    const release = registry.acquirePreparation(
      "window-1",
      KEY,
      () => undefined,
    );
    const session = await openNewestStream(CURRENT_LINE);

    release?.();

    expect(session.closed).toBe(true);
    expect(harness.closedTransports).toHaveLength(1);
    // Releasing twice is harmless.
    release?.();
    expect(harness.closedTransports).toHaveLength(1);
  });

  it("keeps the stream while any of two preparations is held", async () => {
    const first = registry.acquirePreparation("window-1", KEY, () => undefined);
    const second = registry.acquirePreparation(
      "window-1",
      KEY,
      () => undefined,
    );
    const session = await openNewestStream(CURRENT_LINE);
    expect(harness.clients).toHaveLength(1);

    first?.();
    expect(session.closed).toBe(false);
    second?.();
    expect(session.closed).toBe(true);
  });

  it("a UI close leaves a pending preparation's stream open, and the release then closes it", async () => {
    registry.open("window-1", KEY);
    const release = registry.acquirePreparation(
      "window-1",
      KEY,
      () => undefined,
    );
    const session = await openNewestStream(CURRENT_LINE);

    registry.close("window-1", KEY);
    expect(session.closed).toBe(false);

    release?.();
    expect(session.closed).toBe(true);
  });

  it("a UI close leaves a stream open while an actual native tab lives on it, and releasing the last tab closes it", async () => {
    registry.open("window-1", KEY);
    const session = await openNewestStream(CURRENT_LINE);
    await bindOneTab(session);

    registry.close("window-1", KEY);
    await settle();
    expect(session.closed).toBe(false);

    session.emit(releaseTabFrame(), null);
    await settle();

    expect(harness.tabs.released).toHaveLength(1);
    expect(session.closed).toBe(true);
  });

  it("a preparation released after the UI closed does not close a stream a native tab still needs", async () => {
    const release = registry.acquirePreparation(
      "window-1",
      KEY,
      () => undefined,
    );
    const session = await openNewestStream(CURRENT_LINE);
    await bindOneTab(session);

    release?.();
    await settle();

    // The tab is the actual demand: preparation only ever bridged to it.
    expect(session.closed).toBe(false);

    session.emit(releaseTabFrame(), null);
    await settle();
    expect(session.closed).toBe(true);
  });

  it("a restore that replaces the last tab in one step does not close the stream mid-transition", async () => {
    registry.open("window-1", KEY);
    const session = await openNewestStream(CURRENT_LINE);
    await bindOneTab(session);
    registry.close("window-1", KEY);

    // The replacement retires the old birth and registers the new one in the
    // same synchronous step: bookkeeping is momentarily empty in between.
    session.emit(createTabFrame("create-2", "restore"), null);
    await settle();

    expect(session.closed).toBe(false);
    expect(harness.tabs.ensured).toHaveLength(2);
  });

  it("closing one window's UI does not close another window's stream that holds a native tab", async () => {
    registry.open("window-2", KEY);
    const windowTwo = await openNewestStream(CURRENT_LINE);
    await bindOneTab(windowTwo);
    const release = registry.acquirePreparation(
      "window-1",
      KEY,
      () => undefined,
    );
    const windowOne = await openNewestStream(CURRENT_LINE);

    // Preparation picked window 1; the tab is already placed in window 2.
    release?.();
    registry.close("window-2", KEY);
    await settle();

    expect(windowOne.closed).toBe(true);
    expect(windowTwo.closed).toBe(false);
  });

  it("a renderer that adopts an already-running stream asks the host to republish and replays its bindings", async () => {
    const release = registry.acquirePreparation(
      "window-1",
      KEY,
      () => undefined,
    );
    const session = await openNewestStream(CURRENT_LINE);
    await bindOneTab(session);
    expect(session.framesOfKind("requestSnapshot")).toEqual([]);
    harness.emitted.length = 0;

    registry.open("window-1", KEY);

    expect(session.framesOfKind("requestSnapshot")).toHaveLength(1);
    expect(eventKinds(harness.emitted)).toEqual(["status", "tabBound"]);
    // Still one stream: the renderer joined it instead of opening a second.
    expect(harness.clients).toHaveLength(1);
    release?.();
  });

  it("a renderer that adopts a stream before its first snapshot still hears the lifecycle, and asks for nothing yet", async () => {
    registry.acquirePreparation("window-1", KEY, () => undefined);
    await settle();
    const session = harness.clients.at(-1)?.sessions[0];
    if (session === undefined) throw new Error("no stream was subscribed");
    session.negotiatedSchemaVersion = CURRENT_LINE;
    session.emitStatus("open");
    harness.emitted.length = 0;

    registry.open("window-1", KEY);

    expect(eventKinds(harness.emitted)).toEqual(["status"]);
    expect(session.framesOfKind("requestSnapshot")).toEqual([]);
    // The snapshot the host was already going to send reaches the renderer.
    session.emit(snapshotFrame(), null);
    expect(eventKinds(harness.emitted)).toEqual(["status", "frame"]);
    // Adopting the stream did not promote it: it keeps announcing on-demand
    // readiness, so it cannot relocate an unrelated live headless session.
    expect(
      session.framesOfKind("electronTabLifecycleReadyOnDemand"),
    ).toHaveLength(1);
    expect(session.framesOfKind("electronTabLifecycleReady")).toEqual([]);
  });

  it("on a 2.1 host, a renderer that adopts an automatic stream before its snapshot keeps its stream, and only the preparation is refused", async () => {
    const unavailable = vi.fn();
    registry.acquirePreparation("window-1", KEY, unavailable);
    await settle();
    const session = harness.clients.at(-1)?.sessions[0];
    if (session === undefined) throw new Error("no stream was subscribed");
    session.negotiatedSchemaVersion = { major: 2, minor: 1 };
    session.emitStatus("open");
    registry.open("window-1", KEY);

    session.emit(snapshotFrame(), null);

    // The waiting preparation is told once; the UI's stream is not dropped.
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(session.closed).toBe(false);
    expect(harness.closedTransports).toEqual([]);
    // Ordinary readiness, never the on-demand kind a 2.1 host cannot read.
    expect(session.framesOfKind("electronTabLifecycleReadyOnDemand")).toEqual(
      [],
    );
    expect(session.framesOfKind("electronTabLifecycleReady")).toHaveLength(1);
    // A later preparation is refused, and the stream lives until the UI leaves.
    expect(
      registry.acquirePreparation("window-1", KEY, () => undefined),
    ).toBeNull();
    expect(session.closed).toBe(false);

    registry.close("window-1", KEY);
    await settle();
    expect(session.closed).toBe(true);
  });

  it("a reconnect that comes back as 2.1 refuses preparation on an adopted automatic stream but keeps the UI's stream and readiness", async () => {
    const unavailable = vi.fn();
    registry.acquirePreparation("window-1", KEY, unavailable);
    const session = await openNewestStream(CURRENT_LINE);
    registry.open("window-1", KEY);
    expect(
      session.framesOfKind("electronTabLifecycleReadyOnDemand"),
    ).toHaveLength(1);

    session.emitStatus("reconnecting");
    session.negotiatedSchemaVersion = { major: 2, minor: 1 };
    session.emitStatus("open");
    session.emit(snapshotFrame(), null);
    await settle();

    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(session.closed).toBe(false);
    expect(
      session.framesOfKind("electronTabLifecycleReadyOnDemand"),
    ).toHaveLength(1);
    expect(session.framesOfKind("electronTabLifecycleReady")).toHaveLength(1);
    expect(
      registry.acquirePreparation("window-1", KEY, () => undefined),
    ).toBeNull();

    registry.close("window-1", KEY);
    await settle();
    expect(session.closed).toBe(true);
  });

  it("on a host older than 2.2 a UI close still closes the stream that holds a native tab", async () => {
    registry.open("window-1", KEY);
    const session = await openNewestStream({ major: 2, minor: 1 });
    await bindOneTab(session);

    registry.close("window-1", KEY);
    await settle();

    // Such a host cannot replay a snapshot when the renderer comes back, so
    // the renderer-owned lifetime is unchanged.
    expect(session.closed).toBe(true);
  });

  it("keeps a native-only stream through a reconnect gap, and drops it if the host comes back older than 2.2", async () => {
    registry.open("window-1", KEY);
    const session = await openNewestStream(CURRENT_LINE);
    await bindOneTab(session);
    registry.close("window-1", KEY);
    await settle();
    expect(session.closed).toBe(false);

    session.emitStatus("reconnecting");
    await settle();
    // The gap keeps what the last snapshot proved.
    expect(session.closed).toBe(false);

    session.negotiatedSchemaVersion = { major: 2, minor: 1 };
    session.emitStatus("open");
    session.emit(snapshotFrame(), null);
    await settle();

    expect(session.closed).toBe(true);
  });

  it("tells every waiter once when the stream goes away, and refuses new ones until it is open again", async () => {
    registry.open("window-1", KEY);
    const unavailable = vi.fn();
    registry.acquirePreparation("window-1", KEY, unavailable);
    const session = await openNewestStream(CURRENT_LINE);

    session.emitStatus("closed");

    expect(unavailable).toHaveBeenCalledTimes(1);
    // The UI still holds the stream, so it stays registered - but latched.
    expect(
      registry.acquirePreparation("window-1", KEY, () => undefined),
    ).toBeNull();

    session.emitStatus("open");
    expect(
      registry.acquirePreparation("window-1", KEY, () => undefined),
    ).not.toBeNull();
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it("refuses preparation on a host too old to place tabs on demand, and closes what it opened", async () => {
    const unavailable = vi.fn();
    registry.acquirePreparation("window-1", KEY, unavailable);

    const session = await openNewestStream({ major: 2, minor: 1 });

    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(session.framesOfKind("electronTabLifecycleReadyOnDemand")).toEqual(
      [],
    );
    expect(harness.closedTransports).toHaveLength(1);
    // A later preparation starts a fresh stream rather than reusing the dead one.
    expect(
      registry.acquirePreparation("window-1", KEY, () => undefined),
    ).not.toBeNull();
    // The new stream's transport opens after its directory read.
    await settle();
    expect(harness.clients).toHaveLength(2);
  });
});
