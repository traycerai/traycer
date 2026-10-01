import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { BrowserDesktopControl } from "../browser-desktop-control";
import {
  createRegistryHarness,
  type FakeStreamSession,
  type RegistryHarness,
} from "./browser-sessions-stream-fixture";

/**
 * The desktop's half of automatic preparation: one local subscription that
 * turns each host `prepare` into a hold on this desktop's own browser streams,
 * answers `prepared` or `refused`, and lets go on `release`, on the stream
 * closing, or on the hold's owner reporting it unavailable.
 */

type Prepared = {
  readonly windowId: string;
  readonly release: () => void;
};

type PrepareCall = {
  readonly epicId: string;
  readonly onUnavailable: () => void;
};

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

describe("BrowserDesktopControl", () => {
  let harness: RegistryHarness;
  let control: BrowserDesktopControl;
  let calls: PrepareCall[];
  let releases: Mock<() => void>[];
  /** What `prepare` answers; null = this desktop cannot prepare. */
  let answer: "prepare" | "refuse";

  beforeEach(() => {
    harness = createRegistryHarness();
    calls = [];
    releases = [];
    answer = "prepare";
    control = new BrowserDesktopControl({
      directory: harness.deps.directory,
      openTransport: harness.deps.openTransport,
      userId: harness.deps.userId,
      localHostId: harness.deps.localHostId,
      subscribeLocalHostChange: harness.deps.subscribeLocalHostChange,
      subscribeBearerRotation: harness.deps.subscribeBearerRotation,
      prepare: (epicId, onUnavailable): Prepared | null => {
        calls.push({ epicId, onUnavailable });
        if (answer === "refuse") return null;
        const release = vi.fn<() => void>();
        releases.push(release);
        return { windowId: "window-1", release };
      },
    });
  });

  async function openControlSession(): Promise<FakeStreamSession> {
    await settle();
    const session = harness.clients.at(-1)?.sessions[0];
    if (session === undefined) throw new Error("no control subscription");
    session.emitStatus("open");
    return session;
  }

  function prepareFrame(requestId: string, epicId: string) {
    return {
      kind: "prepare",
      hasBinaryPayload: false,
      requestId,
      epicId,
    };
  }

  it("subscribes to the host's browser preparation stream on this machine's host", async () => {
    await openControlSession();

    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.subscribes).toEqual([
      { method: "host.browserPreparation.subscribe", params: {} },
    ]);
  });

  it("holds the epic's browser for a prepare, and answers prepared with the window it chose", async () => {
    const session = await openControlSession();

    session.emit(prepareFrame("request-1", "epic-1"), null);

    expect(calls.map((call) => call.epicId)).toEqual(["epic-1"]);
    expect(session.framesOfKind("prepared")).toEqual([
      {
        kind: "prepared",
        hasBinaryPayload: false,
        requestId: "request-1",
        windowId: "window-1",
      },
    ]);
  });

  it("does not prepare the same request twice", async () => {
    const session = await openControlSession();

    session.emit(prepareFrame("request-1", "epic-1"), null);
    session.emit(prepareFrame("request-1", "epic-1"), null);

    expect(calls).toHaveLength(1);
    expect(session.framesOfKind("prepared")).toHaveLength(1);
  });

  it("lets go of exactly that hold on release, once", async () => {
    const session = await openControlSession();
    session.emit(prepareFrame("request-1", "epic-1"), null);
    session.emit(prepareFrame("request-2", "epic-2"), null);

    const release = {
      kind: "release",
      hasBinaryPayload: false,
      requestId: "request-1",
    };
    session.emit(release, null);
    session.emit(release, null);

    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).not.toHaveBeenCalled();
  });

  it("answers refused when this desktop cannot prepare", async () => {
    answer = "refuse";
    const session = await openControlSession();

    session.emit(prepareFrame("request-1", "epic-1"), null);

    expect(session.framesOfKind("prepared")).toEqual([]);
    expect(session.framesOfKind("refused")).toEqual([
      { kind: "refused", hasBinaryPayload: false, requestId: "request-1" },
    ]);
  });

  it("releases a hold and refuses the request when the hold's owner reports it unavailable later", async () => {
    const session = await openControlSession();
    session.emit(prepareFrame("request-1", "epic-1"), null);

    calls[0]?.onUnavailable();

    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(session.framesOfKind("refused")).toEqual([
      { kind: "refused", hasBinaryPayload: false, requestId: "request-1" },
    ]);
    // A later release for it finds nothing left to let go of.
    session.emit(
      { kind: "release", hasBinaryPayload: false, requestId: "request-1" },
      null,
    );
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });

  it("releases every hold when the control stream leaves the open state", async () => {
    const session = await openControlSession();
    session.emit(prepareFrame("request-1", "epic-1"), null);
    session.emit(prepareFrame("request-2", "epic-2"), null);

    session.emitStatus("reconnecting");

    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).toHaveBeenCalledTimes(1);
  });

  it("ignores frames that are not a valid host frame, or that carry a binary payload", async () => {
    const session = await openControlSession();

    session.emit({ kind: "prepare", hasBinaryPayload: false }, null);
    session.emit({ kind: "pong", hasBinaryPayload: false }, null);
    session.emit(prepareFrame("request-1", "epic-1"), new Uint8Array([1]));

    expect(calls).toEqual([]);
    expect(session.sentFrames).toEqual([]);
  });

  it("releases every hold and closes its subscription on dispose", async () => {
    const session = await openControlSession();
    session.emit(prepareFrame("request-1", "epic-1"), null);

    control.dispose();

    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(session.closed).toBe(true);
    expect(harness.closedTransports).toHaveLength(1);
  });

  // `beforeEach` builds a control on a signed-in harness, and its first open
  // completes before a test body starts, so these use a fresh harness.
  it.each([
    { missing: "signed-in user", userId: null, localHostId: "host-1" },
    { missing: "local host", userId: "user-1", localHostId: null },
  ])("opens nothing while this machine has no $missing", async (setup) => {
    control.dispose();
    const fresh = createRegistryHarness();
    fresh.userId = setup.userId;
    fresh.localHostId = setup.localHostId;
    const idle = new BrowserDesktopControl({
      directory: fresh.deps.directory,
      openTransport: fresh.deps.openTransport,
      userId: fresh.deps.userId,
      localHostId: fresh.deps.localHostId,
      subscribeLocalHostChange: fresh.deps.subscribeLocalHostChange,
      subscribeBearerRotation: fresh.deps.subscribeBearerRotation,
      prepare: () => null,
    });
    await settle();

    expect(fresh.clients).toHaveLength(0);
    idle.dispose();
  });
});
