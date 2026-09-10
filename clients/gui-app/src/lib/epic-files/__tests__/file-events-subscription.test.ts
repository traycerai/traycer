import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => {
  const base = vi.fn();
  return {
    toast: Object.assign(base, {
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

import { toast } from "sonner";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  __resetEpicFileEventsForTests,
  getEpicFileRefusals,
} from "@/lib/epic-files/file-events-store";
import {
  __epicFileEventsClaimCountForTests,
  __resetEpicFileEventsSubscriptionsForTests,
  acquireEpicFileEvents,
  releaseEpicFileEvents,
  type EpicFileEventsClaim,
  type EpicFileEventsTransportOpener,
} from "@/lib/epic-files/file-events-subscription";

/** A driveable `IStreamSession`: the test pushes frames through `emit`. */
class FakeStreamSession implements IStreamSession {
  private frameHandler: ServerFrameHandler | null = null;
  closed = false;

  sendClientFrame(): void {
    // Unused by this subscription: `epic.fileEvents`'s only client frame is
    // `ping`, which this module never sends.
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.frameHandler = handler;
  }

  onStatusChange(_handler: StatusChangeHandler): void {
    // The subscription installs no status handler by design (see the
    // "degrading on an older host" note in file-events-subscription.ts).
  }

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {
    // Not exercised: nothing in this module calls it.
  }

  close(): void {
    this.closed = true;
  }

  /** Pushes a server frame through whatever handler `onServerFrame` installed. */
  emit(envelope: StreamFrameEnvelope): void {
    this.frameHandler?.(envelope, null);
  }
}

interface SubscribeCall {
  readonly method: string;
  readonly params: unknown;
}

interface FakeTransport {
  readonly transport: DurableStreamTransport;
  readonly subscribeCalls: SubscribeCall[];
  readonly sessions: FakeStreamSession[];
  readonly closeCallCount: () => number;
}

function createFakeTransport(): FakeTransport {
  const subscribeCalls: SubscribeCall[] = [];
  const sessions: FakeStreamSession[] = [];
  let closeCalls = 0;

  const wsStreamClient: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe: (method, params) => {
      subscribeCalls.push({ method, params });
      const session = new FakeStreamSession();
      sessions.push(session);
      return session;
    },
    subscribeWithParamsProvider: (method, paramsProvider) => {
      subscribeCalls.push({ method, params: paramsProvider(null) });
      const session = new FakeStreamSession();
      sessions.push(session);
      return session;
    },
    close: () => undefined,
    isClosed: () => false,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "fake-file-events-ws-stream-client",
    notifyBearerRotated: () => undefined,
    notifyCloudVerdictChanged: () => undefined,
    reconnectAll: () => undefined,
    isReady: () => true,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
  };

  return {
    transport: {
      wsStreamClient,
      close: () => {
        closeCalls += 1;
      },
    },
    subscribeCalls,
    sessions,
    closeCallCount: () => closeCalls,
  };
}

function openerFor(fake: FakeTransport): EpicFileEventsTransportOpener {
  return () => fake.transport;
}

beforeEach(() => {
  __resetEpicFileEventsSubscriptionsForTests();
  __resetEpicFileEventsForTests();
  vi.mocked(toast.warning).mockClear();
});

describe("acquireEpicFileEvents", () => {
  it("dials once with method epic.fileEvents and params { epicId }, and lands pushed frames in the store", () => {
    const fake = createFakeTransport();
    const claim: EpicFileEventsClaim = {};

    acquireEpicFileEvents({
      epicId: "epic-1",
      hostId: "host-1",
      claim,
      openTransport: openerFor(fake),
    });

    expect(fake.subscribeCalls).toEqual([
      { method: "epic.fileEvents", params: { epicId: "epic-1" } },
    ]);

    fake.sessions[0].emit({
      kind: "refused",
      path: "files/a.env",
      reason: "secret-shaped",
      hasBinaryPayload: false,
    });

    expect(getEpicFileRefusals("epic-1")).toHaveLength(1);

    releaseEpicFileEvents({ epicId: "epic-1", hostId: "host-1", claim });
  });

  it("shares one dial across two claims, keeps the session open on a non-dialing release, and tears everything down on the last release", () => {
    const fake = createFakeTransport();
    const dialingClaim: EpicFileEventsClaim = {};
    const otherClaim: EpicFileEventsClaim = {};
    const opener = openerFor(fake);

    // First claim dials.
    acquireEpicFileEvents({
      epicId: "epic-2",
      hostId: "host-1",
      claim: dialingClaim,
      openTransport: opener,
    });
    // Second claim on the same (host, epic) does not dial again.
    acquireEpicFileEvents({
      epicId: "epic-2",
      hostId: "host-1",
      claim: otherClaim,
      openTransport: opener,
    });

    expect(fake.subscribeCalls).toHaveLength(1);
    expect(__epicFileEventsClaimCountForTests("host-1", "epic-2")).toBe(2);

    // Releasing the NON-dialing claim leaves the live session untouched.
    releaseEpicFileEvents({
      epicId: "epic-2",
      hostId: "host-1",
      claim: otherClaim,
    });
    expect(fake.sessions[0].closed).toBe(false);
    expect(fake.closeCallCount()).toBe(0);

    fake.sessions[0].emit({
      kind: "refused",
      path: "files/a.env",
      reason: "secret-shaped",
      hasBinaryPayload: false,
    });
    expect(getEpicFileRefusals("epic-2")).toHaveLength(1);

    // Releasing the last (and dialing) claim closes the session, the
    // transport, and drops the epic's notices.
    releaseEpicFileEvents({
      epicId: "epic-2",
      hostId: "host-1",
      claim: dialingClaim,
    });
    expect(fake.sessions[0].closed).toBe(true);
    expect(fake.closeCallCount()).toBe(1);
    expect(getEpicFileRefusals("epic-2")).toEqual([]);
  });

  it("re-dials through the surviving claim's opener when the dialing claim releases", () => {
    const fakeFirst = createFakeTransport();
    const fakeSecond = createFakeTransport();
    const dialingClaim: EpicFileEventsClaim = {};
    const survivingClaim: EpicFileEventsClaim = {};

    acquireEpicFileEvents({
      epicId: "epic-3",
      hostId: "host-1",
      claim: dialingClaim,
      openTransport: openerFor(fakeFirst),
    });
    acquireEpicFileEvents({
      epicId: "epic-3",
      hostId: "host-1",
      claim: survivingClaim,
      openTransport: openerFor(fakeSecond),
    });

    expect(fakeFirst.subscribeCalls).toHaveLength(1);
    expect(fakeSecond.subscribeCalls).toHaveLength(0);

    releaseEpicFileEvents({
      epicId: "epic-3",
      hostId: "host-1",
      claim: dialingClaim,
    });

    // The departing dialer's session and transport are closed...
    expect(fakeFirst.sessions[0].closed).toBe(true);
    expect(fakeFirst.closeCallCount()).toBe(1);
    // ...and a fresh dial happens through the surviving claim's own opener.
    expect(fakeSecond.subscribeCalls).toHaveLength(1);

    releaseEpicFileEvents({
      epicId: "epic-3",
      hostId: "host-1",
      claim: survivingClaim,
    });
  });

  it("keeps different epics and different hosts independent", () => {
    const fakeEpicX = createFakeTransport();
    const fakeEpicY = createFakeTransport();
    const fakeOtherHost = createFakeTransport();
    const claimX: EpicFileEventsClaim = {};
    const claimY: EpicFileEventsClaim = {};
    const claimOtherHost: EpicFileEventsClaim = {};

    acquireEpicFileEvents({
      epicId: "epic-x",
      hostId: "host-1",
      claim: claimX,
      openTransport: openerFor(fakeEpicX),
    });
    acquireEpicFileEvents({
      epicId: "epic-y",
      hostId: "host-1",
      claim: claimY,
      openTransport: openerFor(fakeEpicY),
    });
    acquireEpicFileEvents({
      epicId: "epic-x",
      hostId: "host-2",
      claim: claimOtherHost,
      openTransport: openerFor(fakeOtherHost),
    });

    expect(fakeEpicX.subscribeCalls).toHaveLength(1);
    expect(fakeEpicY.subscribeCalls).toHaveLength(1);
    expect(fakeOtherHost.subscribeCalls).toHaveLength(1);
    expect(__epicFileEventsClaimCountForTests("host-1", "epic-x")).toBe(1);
    expect(__epicFileEventsClaimCountForTests("host-1", "epic-y")).toBe(1);
    expect(__epicFileEventsClaimCountForTests("host-2", "epic-x")).toBe(1);

    releaseEpicFileEvents({
      epicId: "epic-x",
      hostId: "host-1",
      claim: claimX,
    });
    releaseEpicFileEvents({
      epicId: "epic-y",
      hostId: "host-1",
      claim: claimY,
    });
    releaseEpicFileEvents({
      epicId: "epic-x",
      hostId: "host-2",
      claim: claimOtherHost,
    });
  });

  it("degrades quietly when the opener throws: no throw out of acquire, no toast, no store entry", () => {
    const claim: EpicFileEventsClaim = {};
    const throwingOpener: EpicFileEventsTransportOpener = () => {
      throw new Error("no dialable directory entry for this host");
    };

    expect(() =>
      acquireEpicFileEvents({
        epicId: "epic-degrade",
        hostId: "host-1",
        claim,
        openTransport: throwingOpener,
      }),
    ).not.toThrow();

    expect(toast.warning).not.toHaveBeenCalled();
    expect(getEpicFileRefusals("epic-degrade")).toEqual([]);

    releaseEpicFileEvents({ epicId: "epic-degrade", hostId: "host-1", claim });
  });

  it("degrades quietly when the host closes the session for an unsupported method with no frame ever sent", () => {
    const fake = createFakeTransport();
    const claim: EpicFileEventsClaim = {};

    acquireEpicFileEvents({
      epicId: "epic-unsupported",
      hostId: "host-1",
      claim,
      openTransport: openerFor(fake),
    });

    // The host declines the optional method and the transport simply closes
    // the session - no server frame is ever delivered.
    fake.sessions[0].close();

    expect(toast.warning).not.toHaveBeenCalled();
    expect(getEpicFileRefusals("epic-unsupported")).toEqual([]);

    releaseEpicFileEvents({
      epicId: "epic-unsupported",
      hostId: "host-1",
      claim,
    });
  });

  it("ignores an unparsable envelope: no refusal, no toast, no throw", () => {
    const fake = createFakeTransport();
    const claim: EpicFileEventsClaim = {};

    acquireEpicFileEvents({
      epicId: "epic-bad-frame",
      hostId: "host-1",
      claim,
      openTransport: openerFor(fake),
    });

    expect(() =>
      fake.sessions[0].emit({ kind: "nope", hasBinaryPayload: false }),
    ).not.toThrow();

    expect(toast.warning).not.toHaveBeenCalled();
    expect(getEpicFileRefusals("epic-bad-frame")).toEqual([]);

    releaseEpicFileEvents({
      epicId: "epic-bad-frame",
      hostId: "host-1",
      claim,
    });
  });
});
