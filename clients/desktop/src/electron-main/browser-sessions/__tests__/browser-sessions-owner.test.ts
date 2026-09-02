import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserSessionsServerFrame,
  BrowserStorageState,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsStreamEventEnvelope } from "@traycer-clients/shared/platform/browser-view";
import { BrowserSessionsRegistry } from "../browser-sessions-owner";
import {
  createRegistryHarness,
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
  epicId: "epic-1",
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
  session.emit(snapshotFrame());
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

describe("the browser.sessions jar plane lives in main", () => {
  let harness: RegistryHarness;
  let registry: BrowserSessionsRegistry;

  beforeEach(() => {
    harness = createRegistryHarness();
    registry = new BrowserSessionsRegistry(harness.deps);
  });

  it("answers a capture request in main and shows the renderer nothing", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit({
      kind: "capturePrimaryProfile",
      hasBinaryPayload: false,
      requestId: "capture-1",
      standing: false,
    });
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

    session.emit({
      kind: "capturePrimaryProfile",
      hasBinaryPayload: false,
      requestId: "standing-1",
      standing: true,
    });
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

    session.emit({
      kind: "capturePrimaryProfile",
      hasBinaryPayload: false,
      requestId: "standing-1",
      standing: true,
    });
    const flushed = registry.captureFinalPrimaryProfiles("window-1");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const captured = session.framesOfKind("primaryProfileCaptured");
    expect(captured).toHaveLength(1);
    // The standing id, never a client-minted one - the host refuses a capture
    // that answers neither it nor an outstanding request.
    expect(captured[0]?.requestId).toBe("standing-1");
    session.emit({
      kind: "primaryProfileCaptureAck",
      hasBinaryPayload: false,
      requestId: "standing-1",
    });
    await flushed;
  });

  it("drops the standing id with the connection, so a reconnect must be re-issued one", async () => {
    const session = await openLiveStream(harness, registry, "window-1");
    session.emit({
      kind: "capturePrimaryProfile",
      hasBinaryPayload: false,
      requestId: "standing-1",
      standing: true,
    });

    session.emitStatus("reconnecting");
    session.emitStatus("open");
    await registry.captureFinalPrimaryProfiles("window-1");

    // A new incarnation has been issued nothing, and quoting the retired id
    // would answer a request this connection never received.
    expect(session.framesOfKind("primaryProfileCaptured")).toHaveLength(0);
  });

  it("hands the createElectronTab seed straight to the native manager, and the renderer only learns a tab exists", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit(createTabFrame());
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
    session.emit(createTabFrame());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    session.emit({
      kind: "electronTabAccepted",
      hasBinaryPayload: false,
      requestId: "create-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
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

    session.emit({
      kind: "desktopIdentityChallenge",
      hasBinaryPayload: false,
      requestId: "challenge-1",
      nonce: "bm9uY2U=",
    });
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

    session.emit({
      kind: "storeKeyWrapRequest",
      hasBinaryPayload: false,
      requestId: "wrap-1",
      rawKey: "cmF3S2V5",
    });
    session.emit({
      kind: "storeKeyUnwrapRequest",
      hasBinaryPayload: false,
      requestId: "unwrap-1",
      wrappedKey: "d3JhcHBlZEtleQ==",
    });

    // Both halves are priced against the account main opened the stream for.
    expect(harness.jar.wrapped).toEqual(["user-1:cmF3S2V5"]);
    expect(harness.jar.unwrapped).toEqual(["user-1:d3JhcHBlZEtleQ=="]);
    expect(session.framesOfKind("storeKeyWrapped")).toHaveLength(1);
    expect(session.framesOfKind("storeKeyUnwrapped")).toHaveLength(1);
    expect(renderedFrameKinds(harness.emitted)).toEqual(["snapshot"]);
  });

  it("applies an observed sign-in in main with the connection's provenance", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit({
      kind: "primaryProfileObserved",
      hasBinaryPayload: false,
      domain: "example.com",
      cookies: SEED.cookies,
    });
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
    // Locality is the whole of what readiness declares now: the window a
    // stream belongs to never leaves this process (H02 retired the host's
    // last reader for it).
    expect(session.sentFrames[0]?.coLocatedHostId).toBe("host-1");
    expect(session.sentFrames[0]).not.toHaveProperty("desktopWindowId");
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

    session.emit({
      kind: "primaryProfileForgetLedgerAck",
      hasBinaryPayload: false,
      revision: 4,
    });
    expect(harness.jar.acks[0]?.sentRevision).toBe(4);
    const firstConnectionId = harness.jar.acks[0]?.connectionId;

    // A reconnect is a new incarnation: it has been told nothing, so an ack
    // that arrives before any digest is worth nothing.
    session.emitStatus("reconnecting");
    expect(harness.jar.releasedConnectionIds).toEqual([firstConnectionId]);
    session.emitStatus("open");
    session.emit({
      kind: "primaryProfileForgetLedgerAck",
      hasBinaryPayload: false,
      revision: 4,
    });

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
  });

  it("closes its streams itself when the user signs out", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    harness.userId = null;
    harness.rotateBearer();

    // The jar plane speaks for an account: leaving the socket open on a
    // revoked credential and waiting for the host to notice is not a state
    // main should hold.
    expect(session.closed).toBe(true);
    expect(harness.closedTransports).toEqual([0]);
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
      session.emit({
        kind: "capturePrimaryProfile",
        hasBinaryPayload: false,
        requestId: "standing-1",
        standing: true,
      });
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
      session.emit({
        kind: "primaryProfileCaptureAck",
        hasBinaryPayload: false,
        requestId,
      });
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

  it("tells each host once when one saved-login site is cleared", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    expect(registry.clearSiteOnEveryHost("example.com")).toBe(1);

    const cleared = session.framesOfKind("clearSite");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.domain).toBe("example.com");
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

  it("projects the UX frames a renderer renders from", async () => {
    const session = await openLiveStream(harness, registry, "window-1");

    session.emit({
      kind: "caption",
      hasBinaryPayload: false,
      sessionId: "session-1",
      tabId: "tab-1",
      burstId: "burst-1",
      cellTitle: "Signed in",
    });

    expect(renderedFrameKinds(harness.emitted)).toEqual([
      "snapshot",
      "caption",
    ]);
  });
});
