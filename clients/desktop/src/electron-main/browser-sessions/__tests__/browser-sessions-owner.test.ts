import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSessionsServerFrame,
  BrowserStorageState,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserSessionsStreamEventEnvelope,
  BrowserViewNativeTabStatusChange,
} from "@traycer-clients/shared/platform/browser-view";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { log } from "../../app/logger";
import {
  BrowserSessionsRegistry,
  FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS,
} from "../browser-sessions-owner";
import {
  createRegistryHarness,
  LOCAL_HOST_ENTRY,
  type FakeStreamSession,
  type RegistryHarness,
} from "./browser-sessions-stream-fixture";

/**
 * The jar plane in the main process (browser-security-hardening H10).
 *
 * What these pin is WHICH PROCESS each frame is handled in, so every arm below
 * checks two things at once: that main did the work, and that the renderer was
 * told nothing about it. The renderer's whole view of this stream is the
 * `emit` recorder - if a cookie can reach a renderer at all, it reaches it
 * there.
 */

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

const OPEN_REQUEST = {
  scope: { kind: "epic", epicId: "epic-1" } as const,
  hostId: "host-1",
  identityKey: "identity-1",
};

const SEED: BrowserStorageState = {
  cookies: [
    {
      name: "session",
      value: "s3cret",
      domain: ".example.com",
      path: "/",
      expires: 4102444800,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      partitionKey: null,
    },
  ],
  origins: [],
};

function snapshotFrame(): BrowserSessionsServerFrame {
  return { kind: "snapshot", hasBinaryPayload: false, sessions: [] };
}

function createTabFrame(): BrowserSessionsServerFrame {
  return {
    kind: "createElectronTab",
    hasBinaryPayload: false,
    requestId: "create-1",
    sessionId: "session-1",
    tabId: "tab-1",
    requestedUrl: "https://example.com/",
    reason: "session-bootstrap",
    profile: "primary",
    seedStorageState: SEED,
  };
}

/** Opens one stream and drives it to `open` with its snapshot delivered. */
async function openLiveStream(
  harness: RegistryHarness,
  registry: BrowserSessionsRegistry,
  windowId: string,
): Promise<FakeStreamSession> {
  registry.open(windowId, OPEN_REQUEST);
  // The directory read is a promise, so the subscription exists a microtask
  // after `open` returns.
  await Promise.resolve();
  await Promise.resolve();
  const client = harness.clients[harness.clients.length - 1];
  if (client === undefined) throw new Error("no transport was opened");
  const session = client.sessions[0];
  if (session === undefined) throw new Error("no stream was subscribed");
  session.emitStatus("open");
  session.emit(snapshotFrame(), null);
  return session;
}

function renderedFrameKinds(
  emitted: ReadonlyArray<{
    readonly envelope: BrowserSessionsStreamEventEnvelope;
  }>,
): readonly string[] {
  return emitted
    .map((entry) => entry.envelope.event)
    .filter((event) => event.kind === "frame")
    .map((event) => event.frame.kind);
}

/** The directory read, plus the attach it schedules behind it. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function lifecycles(
  emitted: ReadonlyArray<{
    readonly envelope: BrowserSessionsStreamEventEnvelope;
  }>,
): readonly string[] {
  return emitted
    .map((entry) => entry.envelope.event)
    .filter((event) => event.kind === "status")
    .map((event) => event.lifecycle);
}

/** One native-manager status report for the guest `createTabFrame` births. */
function tabStatus(viewed: boolean): BrowserViewNativeTabStatusChange {
  return {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    registrationId: "registration-1",
    url: "https://example.com/",
    title: "Example",
    status: "ready",
    reason: null,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    viewed,
  };
}

describe("the browser.sessions jar plane lives in main", () => {
  let harness: RegistryHarness;
  let registry: BrowserSessionsRegistry;

  beforeEach(() => {
    vi.mocked(log.warn).mockClear();
    harness = createRegistryHarness();
    registry = new BrowserSessionsRegistry(harness.deps);
  });

  it("answers a capture request in main and shows the renderer nothing", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "capture-1",
        standing: false,
      },
      null,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.jar.captures).toBe(1);
    const captured = session.framesOfKind("primaryProfileCaptured");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.status).toBe("captured");
    // The renderer saw the snapshot and NOT the capture request, its answer,
    // or the storage state that answer carries.
    expect(renderedFrameKinds(harness.emitted)).toEqual(["snapshot"]);
  });

  it("keeps a STANDING capture request instead of answering it", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );
    await Promise.resolve();
    await Promise.resolve();

    // "Capture nothing now, keep this id" (H02): reading the jar here would be
    // a whole-jar read nobody asked for, and the answer would be refused.
    expect(harness.jar.captures).toBe(0);
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
  });

  it("quotes the standing id on the quit flush, and sends nothing without one", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    // No standing id yet: this host has not authorized the jar plane for this
    // connection, so a capture would be dropped there anyway.
    await registry.captureFinalPrimaryProfiles("window-1");
    expect(harness.jar.captures).toBe(0);
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);

    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );
    const flushed = registry.captureFinalPrimaryProfiles("window-1");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const captured = session.framesOfKind("primaryProfileCaptured");
    expect(captured).toHaveLength(1);
    // The standing id, never a client-minted one - the host refuses a capture
    // that answers neither it nor an outstanding request.
    expect(captured[0]?.requestId).toBe("standing-1");
    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );
    await flushed;
  });

  it("drops the standing id with the connection, so a reconnect must be re-issued one", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );

    session.emitStatus("reconnecting");
    session.emitStatus("open");
    await registry.captureFinalPrimaryProfiles("window-1");

    // A new incarnation has been issued nothing, and quoting the retired id
    // would answer a request this connection never received.
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
  });

  it("a host-issued capture waits for the jar barrier before reading", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    harness.jar.deferBarrier = true;

    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "capture-1",
        standing: false,
      },
      null,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The barrier is held open: the read has not even started, so nothing
    // left yet.
    expect(harness.jar.captures).toBe(0);
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);

    harness.jar.releaseBarrier();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.jar.captures).toBe(1);
    const captured = session.framesOfKind("primaryProfileCaptured");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.status).toBe("captured");
  });

  it("the desktop's own push does not wait for the barrier", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );

    harness.jar.deferBarrier = true;
    const pushed = registry.capturePrimaryProfileOnEveryHost();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Main's own push quotes "now" ordering, which never awaits the barrier -
    // the read runs and the frame leaves while the barrier is still held.
    expect(harness.jar.captures).toBe(1);
    const captured = session.framesOfKind("primaryProfileCaptured");
    expect(captured).toHaveLength(1);

    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );
    expect(await pushed).toBe(1);

    // Nothing left held for a later test in this file.
    harness.jar.releaseBarrier();
  });

  it("the final capture at close/quit skips the read when the barrier is still held past its shutdown budget, sending no frame", async () => {
    vi.useFakeTimers();
    try {
      const session = await openLiveStream(harness, registry, "window-1");
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );

      harness.jar.deferBarrier = true;
      const flushed = registry.captureFinalPrimaryProfiles("window-1");
      await vi.advanceTimersByTimeAsync(FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS);
      await flushed;

      // The barrier was still held past the shutdown budget: nothing was
      // read, so no frame left and no ack was ever awaited - shipping a
      // hybrid jar is exactly what the bounded wait exists to avoid.
      expect(harness.jar.captures).toBe(0);
      expect(harness.jar.boundedWaitTimeouts).toBe(1);
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      harness.jar.releaseBarrier();
    }
  });

  it("sends the final capture once the barrier releases, and still awaits its ack", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );

    harness.jar.deferBarrier = true;
    let settled = false;
    const flushed = registry
      .captureFinalPrimaryProfiles("window-1")
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The barrier is held open: the read has not even started.
    expect(harness.jar.captures).toBe(0);
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
    expect(settled).toBe(false);

    harness.jar.releaseBarrier();
    // The bounded-wait promise resolves through an extra microtask hop (it
    // adopts `readPrimaryProfile()`'s own promise rather than settling with
    // a plain value), so the ack waiter needs a few more ticks to register
    // than the frame needs to leave.
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve();
    }

    expect(harness.jar.captures).toBe(1);
    const captured = session.framesOfKind("primaryProfileCaptured");
    expect(captured).toHaveLength(1);
    // Sent, but not yet acked - the quit flush still waits for the host's
    // ack, not merely for the socket write.
    expect(settled).toBe(false);

    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );
    await flushed;
    expect(settled).toBe(true);
  });

  it("gives the final capture's ack the REMAINDER of its one shared deadline, not a fresh budget once the barrier releases", async () => {
    vi.useFakeTimers();
    try {
      const session = await openLiveStream(harness, registry, "window-1");
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );

      harness.jar.deferBarrier = true;
      let settled = false;
      const flushed = registry
        .captureFinalPrimaryProfiles("window-1")
        .then(() => {
          settled = true;
        });

      // 4 of the 5-second shutdown budget spent waiting on the barrier.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(harness.jar.captures).toBe(0);
      expect(settled).toBe(false);

      harness.jar.releaseBarrier();
      // Same extra-hop reasoning as the sibling test above: the bounded-wait
      // promise adopts `readPrimaryProfile()`'s own promise, which costs a
      // few more microtask ticks than the frame needs to leave.
      for (let tick = 0; tick < 8; tick += 1) {
        await Promise.resolve();
      }

      expect(harness.jar.captures).toBe(1);
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(1);
      // Sent, but the ack has not arrived - and this budget is what is under
      // test, not a socket write.
      expect(settled).toBe(false);

      // ONE budget for the whole capture: only the second left of the
      // original five is what the ack gets, not a fresh
      // FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS on top of the barrier wait it
      // just spent four of. Advancing by exactly that remainder is enough to
      // time the flush out with no ack ever sent.
      await vi.advanceTimersByTimeAsync(1_000);
      await flushed;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
      harness.jar.releaseBarrier();
    }
  });

  it("the final capture's deadline expires while the jar read is still pending, sending no frame even once the read resolves late", async () => {
    vi.useFakeTimers();
    try {
      const session = await openLiveStream(harness, registry, "window-1");
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );

      // No barrier held - the jar read itself is what stays outstanding past
      // the deadline.
      harness.jar.deferCaptures = true;
      const flushed = registry.captureFinalPrimaryProfiles("window-1");
      await vi.advanceTimersByTimeAsync(FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS);
      await flushed;

      // The deadline passed with the read still in flight: the flush settled
      // on `not-sent` without waiting for it.
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);

      harness.jar.resolvePendingCapture();
      for (let tick = 0; tick < 8; tick += 1) {
        await Promise.resolve();
      }

      // The read finished AFTER the deadline: `stillWanted` now also requires
      // `!expired()`, so no frame was sent and no ack waiter was ever
      // registered to satisfy.
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
      session.emit(
        {
          kind: "primaryProfileCaptureAck",
          hasBinaryPayload: false,
          requestId: "standing-1",
        },
        null,
      );
      // An ack emitted afterwards changes nothing - there was never a waiter
      // for it to satisfy.
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the final capture's one deadline covers the barrier wait too: a jar read still pending when it expires sends no frame", async () => {
    vi.useFakeTimers();
    try {
      const session = await openLiveStream(harness, registry, "window-1");
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );

      harness.jar.deferBarrier = true;
      const flushed = registry.captureFinalPrimaryProfiles("window-1");

      // 3 of the 5-second shutdown budget spent waiting on the barrier.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(harness.jar.captures).toBe(0);

      // The barrier releases with 2 seconds of the deadline left, but the
      // read it starts stays pending.
      harness.jar.deferCaptures = true;
      harness.jar.releaseBarrier();
      await vi.advanceTimersByTimeAsync(2_000);
      await flushed;

      expect(harness.jar.captures).toBe(1);
      // No fresh budget was granted once the barrier released - the read was
      // still in flight when the ONE shared deadline ran out.
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);

      harness.jar.resolvePendingCapture();
      for (let tick = 0; tick < 8; tick += 1) {
        await Promise.resolve();
      }
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      harness.jar.releaseBarrier();
    }
  });

  it("the import's own push still reads and sends immediately while the barrier is deferred, unblocked by a final capture waiting on the same gate", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );

    harness.jar.deferBarrier = true;
    // The final capture is queued behind the barrier first ...
    const flushed = registry.captureFinalPrimaryProfiles("window-1");
    // ... and the import's own push arrives while it is still waiting.
    const pushed = registry.capturePrimaryProfileOnEveryHost();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The push quotes "now" ordering, which never awaits the barrier: it
    // read and sent its frame while the final capture is still held open.
    expect(harness.jar.captures).toBe(1);
    const captured = session.framesOfKind("primaryProfileCaptured");
    expect(captured).toHaveLength(1);

    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );
    expect(await pushed).toBe(1);

    // The final capture has still sent nothing - the push did not release it.
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(1);

    harness.jar.releaseBarrier();
    // Same extra-hop reasoning as the previous test: the bounded-wait
    // promise adopts `readPrimaryProfile()`'s promise, which costs one more
    // microtask tick than the frame needing to leave.
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve();
    }

    expect(harness.jar.captures).toBe(2);
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(2);

    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );
    await flushed;
  });

  it("hands the createElectronTab seed straight to the native manager, and the renderer only learns a tab exists", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit(createTabFrame(), null);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.tabs.ensured).toHaveLength(1);
    // The seed reached the one validated write path with its provenance, and
    // never transited a renderer: the frame that carries it is not projected.
    expect(harness.tabs.ensured[0]?.input.seedStorageState).toEqual(SEED);
    expect(harness.tabs.ensured[0]?.input.connectionId).not.toBeNull();
    expect(harness.tabs.ensured[0]?.windowId).toBe("window-1");
    expect(renderedFrameKinds(harness.emitted)).toEqual(["snapshot"]);
    expect(session.framesOfKind("electronTabProvisioned")).toHaveLength(1);
  });

  it("publishes a bound tab to the renderer by identity only", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(createTabFrame(), null);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    session.emit(
      {
        kind: "electronTabAccepted",
        hasBinaryPayload: false,
        requestId: "create-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      },
      null,
    );
    await Promise.resolve();

    const bound = harness.emitted
      .map((entry) => entry.envelope.event)
      .find((event) => event.kind === "tabBound");
    expect(bound).toEqual({
      kind: "tabBound",
      capability: {
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      },
    });
    expect(harness.tabs.accepted).toHaveLength(1);
  });

  it("signs a desktop identity challenge in main, with no IPC hop", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit(
      {
        kind: "desktopIdentityChallenge",
        hasBinaryPayload: false,
        requestId: "challenge-1",
        nonce: "bm9uY2U=",
      },
      null,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.jar.attested).toEqual([
      { hostId: "host-1", nonce: "bm9uY2U=" },
    ]);
    const attest = session.framesOfKind("desktopIdentityAttest");
    expect(attest).toHaveLength(1);
    expect(attest[0]?.signature).toBe("c2ln");
    // The challenge never reached a renderer, so there is no attest channel a
    // renderer could be asked to answer on.
    expect(renderedFrameKinds(harness.emitted)).toEqual(["snapshot"]);
  });

  it("answers the store-key handshake in main", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit(
      {
        kind: "storeKeyWrapRequest",
        hasBinaryPayload: false,
        requestId: "wrap-1",
        rawKey: "cmF3S2V5",
      },
      null,
    );
    session.emit(
      {
        kind: "storeKeyUnwrapRequest",
        hasBinaryPayload: false,
        requestId: "unwrap-1",
        wrappedKey: "d3JhcHBlZEtleQ==",
      },
      null,
    );

    // Both halves are priced against the account main opened the stream for,
    // and the wrap is matched on the host it opened to as well.
    expect(harness.jar.wrapped).toEqual(["user-1:host-1:cmF3S2V5"]);
    expect(harness.jar.unwrapped).toEqual(["user-1:d3JhcHBlZEtleQ=="]);
    expect(session.framesOfKind("storeKeyWrapped")).toHaveLength(1);
    expect(session.framesOfKind("storeKeyUnwrapped")).toHaveLength(1);
    expect(renderedFrameKinds(harness.emitted)).toEqual(["snapshot"]);
  });

  it("applies an observed sign-in in main with the connection's provenance", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit(
      {
        kind: "primaryProfileObserved",
        hasBinaryPayload: false,
        domain: "example.com",
        cookies: SEED.cookies,
      },
      null,
    );
    await Promise.resolve();

    expect(harness.jar.observed).toHaveLength(1);
    expect(harness.jar.observed[0]?.hostId).toBe("host-1");
    expect(harness.jar.observed[0]?.domain).toBe("example.com");
    expect(harness.jar.observed[0]?.cookieNames).toEqual(["session"]);
    // Provenance is the connection's, and the connection is main's.
    expect(harness.jar.observed[0]?.connectionId).not.toBe("");
    expect(renderedFrameKinds(harness.emitted)).toEqual(["snapshot"]);
  });

  it("sends a cookie delta from main and fans it out to no renderer", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    harness.jar.emitDelta({
      domain: "example.com",
      cookies: SEED.cookies,
      removedKeys: [],
      issuedAt: 1,
    });

    expect(session.framesOfKind("primaryProfileDelta")).toHaveLength(1);
    expect(renderedFrameKinds(harness.emitted)).toEqual(["snapshot"]);
  });

  it("bursts readiness then the forget-ledger digest, in that order, on one stream", async () => {
    harness.jar.ledger = {
      forgetAllAt: null,
      domains: [{ domain: "example.com", forgottenAt: 10 }],
      revision: 7,
    };

    const session = await openLiveStream(harness, registry, "window-1");

    const kinds = session.sentFrames.map((frame) => frame.kind);
    expect(kinds).toEqual([
      "electronTabLifecycleReady",
      "primaryProfileForgetLedger",
    ]);
    // Readiness declares two things: locality, and which window this stream
    // speaks for. The window travels again because native routes are elected
    // per scope AND window - one stream per window, so the id main keys the
    // stream by is the route identity the host elects.
    expect(session.sentFrames[0]?.coLocatedHostId).toBe("host-1");
    expect(session.sentFrames[0]?.desktopWindowId).toBe("window-1");
    expect(session.sentFrames[1]?.revision).toBe(7);
  });

  it("sends the attach burst once this machine's host appears, not only on a reconnect", async () => {
    harness.localHostId = null;
    const session = await openLiveStream(harness, registry, "window-1");

    // A null locality can never be elected, so nothing is declared yet.
    expect(session.sentFrames).toEqual([]);

    harness.publishLocalHost("host-1");

    expect(session.sentFrames.map((frame) => frame.kind)).toEqual([
      "electronTabLifecycleReady",
      "primaryProfileForgetLedger",
    ]);
  });

  it("prices a ledger ack against what THIS connection was sent, and re-earns it after a reconnect", async () => {
    harness.jar.ledger = { forgetAllAt: null, domains: [], revision: 4 };
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit(
      {
        kind: "primaryProfileForgetLedgerAck",
        hasBinaryPayload: false,
        revision: 4,
      },
      null,
    );
    expect(harness.jar.acks[0]?.sentRevision).toBe(4);
    const firstConnectionId = harness.jar.acks[0]?.connectionId;

    // A reconnect is a new incarnation: it has been told nothing, so an ack
    // that arrives before any digest is worth nothing.
    session.emitStatus("reconnecting");
    expect(harness.jar.releasedConnectionIds).toEqual([firstConnectionId]);
    session.emitStatus("open");
    session.emit(
      {
        kind: "primaryProfileForgetLedgerAck",
        hasBinaryPayload: false,
        revision: 4,
      },
      null,
    );

    expect(harness.jar.acks[1]?.sentRevision).toBe(0);
    expect(harness.jar.acks[1]?.connectionId).not.toBe(firstConnectionId);
  });

  it("re-pushes the digest to a live stream when a forget lands in another window", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    harness.jar.ledger = { forgetAllAt: 99, domains: [], revision: 9 };

    harness.jar.emitLedgerChange();

    const pushes = session.framesOfKind("primaryProfileForgetLedger");
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.revision).toBe(9);
  });

  it("keeps two windows on one host as two subscribers, each declaring its own window", async () => {
    const first = await openLiveStream(harness, registry, "window-1");
    const second = await openLiveStream(harness, registry, "window-2");

    // Two sockets, therefore two subscribers, therefore two Electron
    // lifecycle owners - which is what keeps one window's native tabs off the
    // other window's route.
    expect(harness.clients).toHaveLength(2);
    expect(first).not.toBe(second);
    expect(first.framesOfKind("electronTabLifecycleReady")).toHaveLength(1);
    expect(second.framesOfKind("electronTabLifecycleReady")).toHaveLength(1);
  });

  it("closes only the streams of the window whose renderer went away", async () => {
    const first = await openLiveStream(harness, registry, "window-1");
    const second = await openLiveStream(harness, registry, "window-2");

    registry.closeWindow("window-1");

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  it("opens nothing while the desktop is signed out, and opens on the sign-in", async () => {
    harness.userId = null;
    registry.open("window-1", OPEN_REQUEST);
    await Promise.resolve();
    await Promise.resolve();

    // Main reads the signed-in user itself, so a renderer asking early gets
    // nothing rather than a stream opened for an identity it named.
    expect(harness.clients).toHaveLength(0);

    harness.userId = "user-1";
    harness.rotateBearer();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.clients).toHaveLength(1);
  });

  it("pushes a rotated bearer onto the live stream", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    harness.rotateBearer();

    // The host's request context would otherwise hold the credential this
    // connection opened with, and close at its expiry.
    expect(session.framesOfKind("credentialUpdate")).toHaveLength(1);
    // And the LIVE stream is pushed to, never restarted: every rotation
    // rebuilding a healthy socket would be a restart storm on a machine that
    // refreshes its token on a timer.
    expect(harness.clients).toHaveLength(1);
    expect(session.closed).toBe(false);
    // The cached registry was read for the PREVIOUS identity, and the rows are
    // per account, so a fresh bearer drops the whole cache before any restart
    // could resolve against it.
    expect(harness.directoryResets.count).toBe(1);
  });

  it("closes its streams itself when the user signs out", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    harness.userId = null;
    harness.rotateBearer();

    // The jar plane speaks for an account: leaving the socket open on a
    // revoked credential and waiting for the host to notice is not a state
    // main should hold.
    await settle();

    expect(session.closed).toBe(true);
    expect(harness.closedTransports).toEqual([0]);
    // Torn down and NOT restarted: there is no identity to open a stream for.
    expect(harness.clients).toHaveLength(1);
  });

  it("restarts a stream the host closed on an expired bearer, on the next rotation", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    expect(harness.clients).toHaveLength(1);

    // What H08's per-connection expiry close looks like from here: a fatal
    // UNAUTHORIZED. Main holds no revalidator, so the transport is terminal
    // and nothing but a user-clicked Retry would ever reopen the jar plane.
    session.emitFatal("UNAUTHORIZED");
    expect(session.closed).toBe(false);

    harness.rotateBearer();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.clients).toHaveLength(2);
    const restarted = harness.clients[1]?.sessions[0];
    expect(restarted).toBeDefined();
    expect(session.closed).toBe(true);
  });

  it("drops the streams of a window that closed, so no dead window keeps its placement", async () => {
    const first = await openLiveStream(harness, registry, "window-1");
    const second = await openLiveStream(harness, registry, "window-2");

    registry.retainWindows(new Set(["window-2"]));

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  it("captures once per stream on the quit path, without a renderer, and waits for each host's ack", async () => {
    const first = await openLiveStream(harness, registry, "window-1");
    const second = await openLiveStream(harness, registry, "window-2");
    for (const session of [first, second]) {
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );
    }

    let settled = false;
    const flushed = registry.captureFinalPrimaryProfiles(null).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.jar.captures).toBe(2);
    // The quit path waits for the host to say it stored the jar, not for the
    // socket write - so it is still outstanding until both hosts ack.
    expect(settled).toBe(false);
    for (const session of [first, second]) {
      const captured = session.framesOfKind("primaryProfileCaptured")[0];
      const requestId = captured?.requestId;
      if (typeof requestId !== "string") throw new Error("no capture went out");
      session.emit(
        {
          kind: "primaryProfileCaptureAck",
          hasBinaryPayload: false,
          requestId,
        },
        null,
      );
    }

    await flushed;
    expect(settled).toBe(true);
    // No renderer was asked for any of it.
    expect(renderedFrameKinds(harness.emitted)).toEqual([
      "snapshot",
      "snapshot",
    ]);
  });

  it("tells each host once when the user forgets every login", async () => {
    const first = await openLiveStream(harness, registry, "window-1");
    // A second stream on the SAME host: the frame speaks for the user's whole
    // slice there, so asking twice would only ask for the same work twice.
    const second = await openLiveStream(harness, registry, "window-2");

    const hosts = registry.forgetLoginsOnEveryHost();

    expect(hosts).toBe(1);
    expect(first.framesOfKind("forgetLogins")).toHaveLength(1);
    expect(second.framesOfKind("forgetLogins")).toHaveLength(0);
  });

  it("pushes the imported jar once per host, and counts the host that acked", async () => {
    const first = await openLiveStream(harness, registry, "window-1");
    // The same host again: the jar is the user's whole slice there, so a
    // second capture would read and send the identical jar twice.
    const second = await openLiveStream(harness, registry, "window-2");
    for (const session of [first, second]) {
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );
    }

    const pushed = registry.capturePrimaryProfileOnEveryHost();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.jar.captures).toBe(1);
    expect(first.framesOfKind("primaryProfileCaptured")).toHaveLength(1);
    expect(second.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
    second.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );
    first.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );

    // One, not two: the ack that counts is the one from the stream the capture
    // actually went out on, so the host cannot be counted twice by a sibling
    // stream answering an id it was never sent.
    expect(await pushed).toBe(1);
  });

  it("does not count a host the imported jar reached but that never acked it", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );

    const pushed = registry.capturePrimaryProfileOnEveryHost();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The capture DID go out - this is not the "nothing was sent" case.
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(1);
    // The connection dies before the host answers, which is the honest form of
    // an unanswered capture that needs no clock to reach.
    session.emitStatus("reconnecting");

    // Zero, not one: Done says how many hosts TOOK the jar, and a frame that
    // left is not a host that has it.
    expect(await pushed).toBe(0);
  });

  it("does not send a host's second stream after the first stream's capture left unacked", async () => {
    const first = await openLiveStream(harness, registry, "window-1");
    // A second window on the SAME host: the once-per-host rule tries this
    // sibling only when the first stream sent nothing at all.
    const second = await openLiveStream(harness, registry, "window-2");
    for (const session of [first, second]) {
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );
    }

    const pushed = registry.capturePrimaryProfileOnEveryHost();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The capture DID go out on the first stream - this is the "left but
    // unacked" case, not the "nothing was sent" case the once-per-host rule
    // treats differently.
    expect(first.framesOfKind("primaryProfileCaptured")).toHaveLength(1);

    // The connection dies before the host answers.
    first.emitStatus("reconnecting");

    expect(await pushed).toBe(0);
    // The sibling stream on the SAME host was never tried: a frame that LEFT
    // is this host's one capture, acked or not - trying a second stream
    // would risk a second whole jar reaching the same host.
    expect(second.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
  });

  it("a capture whose stream closed during the jar read is not-sent, and the sibling stream is tried", async () => {
    const first = await openLiveStream(harness, registry, "window-1");
    // A second window on the SAME host, exactly as the other sibling tests set
    // up - the once-per-host rule only tries this sibling when the first
    // stream sent nothing at all.
    const second = await openLiveStream(harness, registry, "window-2");
    for (const session of [first, second]) {
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );
    }

    harness.jar.deferCaptures = true;
    const pushed = registry.capturePrimaryProfileOnEveryHost();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The first stream's jar read is in flight.
    expect(harness.jar.captures).toBe(1);

    // The stream closes while that read is still outstanding.
    first.emitStatus("closed");
    harness.jar.resolvePendingCapture();
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve();
    }

    // Nothing left on the closed stream - the read finished after the
    // connection was no longer open to answer on.
    expect(first.framesOfKind("primaryProfileCaptured")).toHaveLength(0);

    // The once-per-host rule tries the healthy sibling next.
    expect(harness.jar.captures).toBe(2);
    harness.jar.resolvePendingCapture();
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve();
    }

    expect(second.framesOfKind("primaryProfileCaptured")).toHaveLength(1);
    second.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );

    // The host is counted once, through the sibling that actually answered.
    expect(await pushed).toBe(1);
  });

  it("a capture whose standing id was re-issued during the jar read is not-sent", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );

    harness.jar.deferCaptures = true;
    const pushed = registry.capturePrimaryProfileOnEveryHost();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.jar.captures).toBe(1);

    // The host re-issues a fresh standing id while this read is still in
    // flight - e.g. it reconnected and re-sent its handshake.
    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-2",
        standing: true,
      },
      null,
    );

    harness.jar.resolvePendingCapture();
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve();
    }

    // Nothing leaves: a frame quoting "standing-1" would be refused by a host
    // whose standing id is now "standing-2", so the read's answer is dropped
    // once the id is seen to have moved, and no frame names either id.
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);

    // Not-sent, so no host is counted, and there is no sibling stream on
    // this host to try instead.
    expect(await pushed).toBe(0);
  });

  it("the ack budget starts when the frame leaves, not when the jar read starts", async () => {
    vi.useFakeTimers();
    try {
      const session = await openLiveStream(harness, registry, "window-1");
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );

      harness.jar.deferCaptures = true;
      const firstPushed = registry.capturePrimaryProfileOnEveryHost();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The jar read is in flight. The ack waiter - and its timer - are only
      // registered once the frame has LEFT, so nothing has been sent yet.
      expect(harness.jar.captures).toBe(1);
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);

      // Advancing past the whole ack budget while the read is still pending
      // must consume nothing: there is no timer running yet to expire.
      await vi.advanceTimersByTimeAsync(FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS);

      harness.jar.resolvePendingCapture();
      for (let tick = 0; tick < 8; tick += 1) {
        await Promise.resolve();
      }

      const captured = session.framesOfKind("primaryProfileCaptured");
      expect(captured).toHaveLength(1);
      const requestId = captured[0]?.requestId;
      if (typeof requestId !== "string") {
        throw new Error("no capture went out");
      }

      session.emit(
        {
          kind: "primaryProfileCaptureAck",
          hasBinaryPayload: false,
          requestId,
        },
        null,
      );

      // Acked: the budget only started once the frame left, and the ack
      // arrived well inside it.
      expect(await firstPushed).toBe(1);

      // Control: a second run, this time with no ack at all. Its OWN budget
      // starts only once ITS frame leaves, and expires normally from there.
      harness.jar.deferCaptures = true;
      const secondPushed = registry.capturePrimaryProfileOnEveryHost();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.jar.captures).toBe(2);
      harness.jar.resolvePendingCapture();
      for (let tick = 0; tick < 8; tick += 1) {
        await Promise.resolve();
      }
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS);

      expect(await secondPushed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late ack for a timed-out frame does not satisfy the next capture", async () => {
    vi.useFakeTimers();
    try {
      const session = await openLiveStream(harness, registry, "window-1");
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );

      // The first capture's frame leaves and is never acked - it times out.
      const firstPushed = registry.capturePrimaryProfileOnEveryHost();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS);
      expect(await firstPushed).toBe(0);

      // A second capture on the SAME standing id: its frame leaves too, so
      // there are now two frames outstanding under "standing-1" - the timed
      // out one (settled, but still queued to absorb its own late ack) and
      // this live one.
      const secondPushed = registry.capturePrimaryProfileOnEveryHost();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(2);

      let secondSettled = false;
      void secondPushed.then(() => {
        secondSettled = true;
      });

      // One ack: absorbed by the OLDEST slot, the already timed-out first
      // frame's - not by the live second one.
      session.emit(
        {
          kind: "primaryProfileCaptureAck",
          hasBinaryPayload: false,
          requestId: "standing-1",
        },
        null,
      );
      for (let tick = 0; tick < 8; tick += 1) {
        await Promise.resolve();
      }
      expect(secondSettled).toBe(false);

      // A second ack now reaches the second capture's own slot.
      session.emit(
        {
          kind: "primaryProfileCaptureAck",
          hasBinaryPayload: false,
          requestId: "standing-1",
        },
        null,
      );

      expect(await secondPushed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an ack absorbed by a timed-out frame before the next frame leaves is not counted either", async () => {
    vi.useFakeTimers();
    try {
      const session = await openLiveStream(harness, registry, "window-1");
      session.emit(
        {
          kind: "capturePrimaryProfile",
          hasBinaryPayload: false,
          requestId: "standing-1",
          standing: true,
        },
        null,
      );

      // The first capture's frame leaves and is never acked - it times out.
      const firstPushed = registry.capturePrimaryProfileOnEveryHost();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS);
      expect(await firstPushed).toBe(0);

      // The second capture's jar read is held open, so its frame has not
      // left yet - no ack waiter for it exists.
      harness.jar.deferCaptures = true;
      const secondPushed = registry.capturePrimaryProfileOnEveryHost();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.jar.captures).toBe(2);
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(1);

      // The ack arrives now, while only the timed-out first frame's slot is
      // queued - it is absorbed there, harmlessly.
      session.emit(
        {
          kind: "primaryProfileCaptureAck",
          hasBinaryPayload: false,
          requestId: "standing-1",
        },
        null,
      );

      // The jar read finishes and the second frame leaves, registering its
      // OWN ack waiter fresh.
      harness.jar.resolvePendingCapture();
      for (let tick = 0; tick < 8; tick += 1) {
        await Promise.resolve();
      }
      expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(2);

      // No further ack arrives for the second frame - its own budget runs
      // out and it is unacked, not satisfied by the ack absorbed earlier.
      await vi.advanceTimersByTimeAsync(FINAL_PRIMARY_PROFILE_FLUSH_TIMEOUT_MS);
      expect(await secondPushed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a jar read that throws answers a closed reason and logs the cause, never the raw path", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    harness.jar.failNextCapture = new Error("EACCES /Users/x/Library/Cookies");

    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "capture-1",
        standing: false,
      },
      null,
    );
    await Promise.resolve();
    await Promise.resolve();

    const captured = session.framesOfKind("primaryProfileCaptured");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.status).toBe("failed");
    expect(captured[0]?.reason).toBe("capture-failed");
    // The raw path text never crosses into the frame the host receives.
    expect(JSON.stringify(captured[0])).not.toContain("EACCES");
    expect(JSON.stringify(captured[0])).not.toContain(
      "/Users/x/Library/Cookies",
    );

    const warnCalls = vi.mocked(log.warn).mock.calls;
    expect(
      warnCalls.some((call) =>
        /primary profile capture failed/.test(String(call[0])),
      ),
    ).toBe(true);
  });

  it("a capture whose jar read failed is sent but counts no host", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );

    harness.jar.failNextCapture = new Error("EACCES /Users/x/Library/Cookies");
    const firstPushed = registry.capturePrimaryProfileOnEveryHost();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The frame LEFT - this is not the "nothing was sent" case - but it
    // carried no jar: the read failed, so it answers `failed` rather than
    // `captured`.
    const firstCaptured = session.framesOfKind("primaryProfileCaptured");
    expect(firstCaptured).toHaveLength(1);
    expect(firstCaptured[0]?.status).toBe("failed");

    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );

    // Acked or not, a frame with no jar in it never counts as a host that
    // took the jar - `sent-no-jar` is not `acked`.
    expect(await firstPushed).toBe(0);

    // A second capture on the SAME standing id, this time with a healthy jar
    // read: its own ack must satisfy its own slot - proving the first
    // frame's ack did not spuriously satisfy this next slot in the
    // ack-in-send-order sequence.
    const secondPushed = registry.capturePrimaryProfileOnEveryHost();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const captured = session.framesOfKind("primaryProfileCaptured");
    expect(captured).toHaveLength(2);
    expect(captured[1]?.status).toBe("captured");

    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );

    expect(await secondPushed).toBe(1);
  });

  it("runs the import's push and the final capture independently on one stream, since the final capture bypasses capturePrimaryProfileNow's lane", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );

    // Two callers overlapping on the SAME stream - a login import's push
    // beside the quit-path flush. The final capture is deliberately NOT
    // routed through `capturePrimaryProfileNow`'s in-flight/trailing lane
    // (the import's own push takes that lane from inside its barrier, and a
    // final capture queued ahead of it there would have the push wait on the
    // capture that waits on the push) - so both read the jar and send their
    // own frame independently, quoting the one standing id.
    const pushed = registry.capturePrimaryProfileOnEveryHost();
    const flushed = registry.captureFinalPrimaryProfiles("window-1");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.jar.captures).toBe(2);
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(2);

    // Acks are attributed in SEND order under the standing id: the first ack
    // satisfies the push's frame, sent first.
    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );
    expect(await pushed).toBe(1);

    // The second ack satisfies the final capture's own slot.
    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );
    await flushed;
  });

  it("a third caller during the same in-flight capture shares the one trailing capture", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(
      {
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      },
      null,
    );

    // Three back-to-back callers on the same stream, all arriving while the
    // first capture is still in flight. The second and third must share ONE
    // trailing capture rather than each minting their own - a burst of
    // overlapping callers costs two frames total on this stream, never one
    // per caller.
    const first = registry.capturePrimaryProfileOnEveryHost();
    const second = registry.capturePrimaryProfileOnEveryHost();
    const third = registry.capturePrimaryProfileOnEveryHost();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.jar.captures).toBe(1);
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(1);

    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve();
    }

    // Exactly ONE more frame for the shared trailing capture - not two.
    expect(harness.jar.captures).toBe(2);
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(2);

    session.emit(
      {
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId: "standing-1",
      },
      null,
    );

    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(await third).toBe(1);
  });

  it("counts no host for an import push when none issued a standing capture request", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    const notified = await registry.capturePrimaryProfileOnEveryHost();

    // Zero is the ordinary opportunistic outcome the Done step reports as
    // "saved on this machine", not a failure - and the jar is never even read,
    // because a capture answering no standing id would be refused there.
    expect(notified).toBe(0);
    expect(harness.jar.captures).toBe(0);
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
  });

  it("relays a renderer's tab request onto the stream verbatim", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    registry.send("window-1", OPEN_REQUEST, {
      kind: "openTab",
      hasBinaryPayload: false,
      requestId: "open-1",
      sessionId: null,
      url: "https://example.com/",
    });

    expect(session.framesOfKind("openTab")).toHaveLength(1);
  });

  it("refuses a window's streams past the per-window cap, and bounds only that window", async () => {
    for (let index = 0; index < 13; index += 1) {
      registry.open("window-1", {
        ...OPEN_REQUEST,
        identityKey: `identity-${index}`,
      });
    }
    await settle();

    // Every distinct identity the renderer names costs a socket, a relay
    // attach, an attestation and a whole contributed-set replay, so a renderer
    // that loops the key is bounded rather than amplified.
    expect(harness.clients).toHaveLength(12);
    expect(vi.mocked(log.warn).mock.calls).toHaveLength(1);

    // The refused one is REPORTED, not dropped in silence: its renderer-side
    // session would otherwise sit in `connecting` for the life of the window.
    const refused = harness.emitted.filter(
      (entry) =>
        entry.envelope.key.identityKey === "identity-12" &&
        entry.envelope.event.kind === "status",
    );
    expect(lifecycles(refused)).toEqual(["failed"]);

    // The bound is per window, not per process: another window is untouched.
    registry.open("window-2", OPEN_REQUEST);
    await settle();

    expect(harness.clients).toHaveLength(13);
  });

  it("reports a stream that never reached a socket as failed and drops it, so the same key re-opens", async () => {
    harness.resolveHost = () => Promise.resolve(null);
    registry.open("window-1", OPEN_REQUEST);
    await settle();

    expect(lifecycles(harness.emitted)).toContain("failed");
    expect(harness.clients).toHaveLength(0);

    // Dropped from the registry entirely, so the re-open is not deduped
    // against a dead entry - the renderer's own retry is the recovery.
    harness.resolveHost = () => Promise.resolve(LOCAL_HOST_ENTRY);
    registry.open("window-1", OPEN_REQUEST);
    await settle();

    expect(harness.clients).toHaveLength(1);
  });

  it("charges the per-window cap only for streams that reached a socket", async () => {
    harness.resolveHost = () => Promise.resolve(null);
    for (let index = 0; index < 12; index += 1) {
      registry.open("window-1", {
        ...OPEN_REQUEST,
        identityKey: `identity-${index}`,
      });
    }
    await settle();
    expect(harness.clients).toHaveLength(0);

    // A stream that will never reach a socket holds no place under the cap.
    harness.resolveHost = () => Promise.resolve(LOCAL_HOST_ENTRY);
    registry.open("window-1", { ...OPEN_REQUEST, identityKey: "identity-12" });
    await settle();

    expect(harness.clients).toHaveLength(1);
  });

  it("opens ONE transport when a bearer rotation lands inside the directory read", async () => {
    const pending: Array<(entry: HostDirectoryEntry | null) => void> = [];
    harness.resolveHost = () =>
      new Promise<HostDirectoryEntry | null>((resolve) => {
        pending.push(resolve);
      });

    registry.open("window-1", OPEN_REQUEST);
    await Promise.resolve();
    expect(pending).toHaveLength(1);

    // The rotation tears this incarnation down and starts a second one while
    // the first directory read is still in flight.
    harness.rotateBearer();
    await Promise.resolve();
    expect(pending).toHaveLength(2);

    for (const resolve of pending) resolve(LOCAL_HOST_ENTRY);
    await settle();

    // The read that belongs to the torn-down incarnation must drop rather than
    // attach: two attaches would orphan a live client and leave two
    // subscribers on one epic.
    expect(harness.clients).toHaveLength(1);
    expect(harness.closedTransports).toEqual([]);
    const session = harness.clients[0]?.sessions[0];
    if (session === undefined) throw new Error("no stream was subscribed");
    session.emitStatus("open");
    session.emit(snapshotFrame(), null);
    expect(session.framesOfKind("electronTabLifecycleReady")).toHaveLength(1);
  });

  it("restarts the stream for a switched-to account and prices its store-key wrap against it", async () => {
    const first = await openLiveStream(harness, registry, "window-1");

    harness.userId = "user-2";
    harness.rotateBearer();
    await settle();

    // The wrap, the relay grant and the forget ledger are all priced against
    // the account the stream was OPENED for, so a switch cannot be pushed down
    // the open socket: it is torn down and re-opened for the new account.
    expect(first.closed).toBe(true);
    expect(harness.closedTransports).toEqual([0]);
    expect(harness.clients).toHaveLength(2);

    const second = harness.clients[1]?.sessions[0];
    if (second === undefined) throw new Error("the stream was not restarted");
    second.emitStatus("open");
    second.emit(
      {
        kind: "storeKeyWrapRequest",
        hasBinaryPayload: false,
        requestId: "wrap-1",
        rawKey: "cmF3S2V5",
      },
      null,
    );

    expect(harness.jar.wrapped).toEqual(["user-2:host-1:cmF3S2V5"]);
  });

  it("refuses a preview of a native guest that is off screen, and sends it once it is on screen", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit(createTabFrame(), null);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    session.emit(
      {
        kind: "electronTabAccepted",
        hasBinaryPayload: false,
        requestId: "create-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      },
      null,
    );
    await Promise.resolve();

    harness.tabs.emitStatus(tabStatus(false));
    registry.send("window-1", OPEN_REQUEST, {
      kind: "captureTabPreview",
      hasBinaryPayload: false,
      requestId: "preview-1",
      tabId: "tab-1",
    });

    // A preview is a screenshot of a signed-in page and `openTab` is one IPC
    // away, so a guest THIS desktop owns is photographed only while it is on
    // screen - otherwise a renderer could open the user's mail and read it
    // back with nothing appearing on the display.
    expect(session.framesOfKind("captureTabPreview")).toHaveLength(0);
    expect(vi.mocked(log.warn).mock.calls).toHaveLength(1);

    harness.tabs.emitStatus(tabStatus(true));
    registry.send("window-1", OPEN_REQUEST, {
      kind: "captureTabPreview",
      hasBinaryPayload: false,
      requestId: "preview-2",
      tabId: "tab-1",
    });

    expect(session.framesOfKind("captureTabPreview")).toHaveLength(1);
  });

  it("passes through a preview of a tab it owns no native guest for", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    registry.send("window-1", OPEN_REQUEST, {
      kind: "captureTabPreview",
      hasBinaryPayload: false,
      requestId: "preview-1",
      tabId: "tab-on-the-host",
    });

    // The picker's ordinary cross-host case: the host answers for its own
    // tabs, and nothing in this process can see them.
    expect(session.framesOfKind("captureTabPreview")).toHaveLength(1);
    expect(vi.mocked(log.warn).mock.calls).toHaveLength(0);
  });

  it("projects the UX frames a renderer renders from", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit(
      {
        kind: "caption",
        hasBinaryPayload: false,
        sessionId: "session-1",
        tabId: "tab-1",
        burstId: "burst-1",
        cellTitle: "Signed in",
      },
      null,
    );

    expect(renderedFrameKinds(harness.emitted)).toEqual([
      "snapshot",
      "caption",
    ]);
  });
});
