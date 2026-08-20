import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type {
  IStreamSession,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
} from "../../../../shared/host-transport/i-stream-session";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { HostCredentialState } from "@traycer/protocol/framework/stream-ws-protocol";
import type {
  HostCredentialMintOutcome,
  HostCredentialMintRequest,
} from "../../../../shared/host-transport/host-credential-mint-flow";

// Pins `provisionInstalledHostCredential`'s own orchestration: the
// bounded-lap ack/mint/verify loop, independent of `WsStreamClient`'s
// internal single-flight-per-host mint bookkeeping (that machinery has its
// own suite in `ws-stream-client.test.ts`). `WsStreamClient` is replaced
// wholesale with a fake that captures its constructor options, so tests
// drive the flow directly: call the captured `onHostCredentialState(hostId,
// state)` to deliver an ack, and `hostCredentialMint(request)` to simulate
// the client's own mint invocation on a non-active ack.
//
// The headline invariant (case 3 below) is ordering: on a non-active ack the
// module must let the mint SETTLE before it closes that lap's handoff
// session - closing early would race the provision frame's flush. A
// call-order array pinned across the fake session's `close()` and the mint
// promise's own resolution catches a regression that closes under the
// write.

interface CapturedStreamClientOptions {
  readonly onHostCredentialState: (
    hostId: string,
    state: HostCredentialState,
  ) => void;
  readonly hostCredentialMint: (
    request: HostCredentialMintRequest,
  ) => Promise<HostCredentialMintOutcome>;
}

const mocks = vi.hoisted(() => {
  class FakeStreamSession implements IStreamSession {
    statusHandler: StatusChangeHandler | null = null;
    closed = false;

    // Idempotent, like the real session's `close()` - and it's the write
    // side of the ordering invariant this suite exists to pin.
    readonly close = vi.fn((): void => {
      if (this.closed) return;
      this.closed = true;
      mocks.callOrder.push("close");
    });

    sendClientFrame(): void {}

    onServerFrame(): void {}

    onStatusChange(handler: StatusChangeHandler): void {
      this.statusHandler = handler;
    }

    requestReconnect(): void {}

    getNegotiatedSchemaVersion(): SchemaVersion | null {
      return null;
    }

    // Test-only driver: simulates the transport reporting a status
    // transition (e.g. "open", or a fatal "closed") on this session.
    emitStatus(
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
    ): void {
      this.statusHandler?.(status, reason);
    }
  }

  // Lap index is derived from `mocks.sessions.length` (not a counter closed
  // over here) precisely because that array is reset in `beforeEach` - a
  // separate counter declared in this once-per-file `vi.hoisted` callback
  // would keep incrementing across every test in the file instead of
  // restarting at 1 for each one.
  const subscribeMock = vi.fn(
    (_method: string, _params: unknown): FakeStreamSession => {
      const session = new FakeStreamSession();
      mocks.sessions.push(session);
      const lapIndex = mocks.sessions.length;
      const hook = mocks.onSessionCreated;
      if (hook !== null) {
        hook(session, lapIndex);
      }
      return session;
    },
  );

  const clientCloseMock = vi.fn((_reason: string): void => undefined);

  class FakeWsStreamClient {
    constructor(options: CapturedStreamClientOptions) {
      mocks.capturedOptions = options;
    }

    subscribe = subscribeMock;
    close = clientCloseMock;
  }

  // Default: no credential to hand back. Individual tests override via
  // `mockResolvedValueOnce` / `mockRejectedValueOnce` for the laps that
  // actually invoke it.
  const mintFlowMock = vi.fn(
    (_request: HostCredentialMintRequest): Promise<HostCredentialMintOutcome> =>
      Promise.resolve({ kind: "unavailable" }),
  );
  const createMintFlowMock = vi.fn(() => mintFlowMock);

  const readHostPidMetadataMock = vi.fn(async () => null);
  const isValidLocalHostWebsocketUrlMock = vi.fn((): boolean => true);

  return {
    callOrder: [] as string[],
    sessions: [] as FakeStreamSession[],
    capturedOptions: null as CapturedStreamClientOptions | null,
    // Fired synchronously from inside `subscribe()`, once per lap, with the
    // just-created session and its 1-based lap index. Tests use it to
    // schedule (via `setTimeout(..., 0)`) their simulated ack/status
    // delivery for AFTER `observeNextAck`'s executor has finished binding
    // its observer - firing synchronously here would race that binding and
    // silently drop the ack.
    onSessionCreated: null as
      ((session: FakeStreamSession, lapIndex: number) => void) | null,
    FakeWsStreamClient,
    subscribeMock,
    clientCloseMock,
    mintFlowMock,
    createMintFlowMock,
    readHostPidMetadataMock,
    isValidLocalHostWebsocketUrlMock,
  };
});

vi.mock("../../../../shared/host-transport/ws-stream-client", () => ({
  WsStreamClient: mocks.FakeWsStreamClient,
}));

vi.mock("../../auth/host-credential-mint", () => ({
  createCliHostCredentialMintFlow: mocks.createMintFlowMock,
}));

vi.mock("../pid-metadata", () => ({
  readHostPidMetadata: mocks.readHostPidMetadataMock,
  isValidLocalHostWebsocketUrl: mocks.isValidLocalHostWebsocketUrlMock,
}));

import {
  provisionInstalledHostCredential,
  type HostCredentialProvisionOutcome,
  type ProvisionHostCredentialOptions,
} from "../credential-provisioning";
import { noopLogger } from "../../logger";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Manually-settled promise, used only where a test needs to control exactly
// WHEN the mint resolves relative to other events (the ordering test).
function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      if (resolveFn === null) {
        throw new Error("deferred resolved before its executor ran");
      }
      resolveFn(value);
    },
  };
}

function capturedClientOptions(): CapturedStreamClientOptions {
  const options = mocks.capturedOptions;
  if (options === null) {
    throw new Error("WsStreamClient was never constructed");
  }
  return options;
}

function makeOptions(
  overrides: Partial<ProvisionHostCredentialOptions>,
): ProvisionHostCredentialOptions {
  return {
    environment: "production",
    auth: {
      token: "test-bearer-token",
      authnBaseUrl: "https://authn.test",
      userId: "user-1",
    },
    deadlineMs: 2_000,
    progress: () => undefined,
    logger: noopLogger,
    ...overrides,
  };
}

function provisionedOutcome(): HostCredentialMintOutcome {
  return {
    kind: "provisioned",
    token: "minted-token",
    refreshToken: "minted-refresh",
    familyId: "family-1",
    provisionedAt: "2026-01-01T00:00:00.000Z",
    expiresIn: 600,
  };
}

function fatalReason(reason: string): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

let clearIntervalSpy: MockInstance;

beforeEach(() => {
  mocks.callOrder = [];
  mocks.sessions = [];
  mocks.capturedOptions = null;
  mocks.onSessionCreated = null;

  mocks.subscribeMock.mockClear();
  mocks.clientCloseMock.mockClear();
  mocks.createMintFlowMock.mockClear();
  mocks.readHostPidMetadataMock.mockClear();
  mocks.isValidLocalHostWebsocketUrlMock.mockClear();

  // Fully reset (not just cleared): tests queue bespoke `...Once`
  // resolutions/rejections on this one, and a leftover queued value must
  // never leak into the next test.
  mocks.mintFlowMock.mockReset();
  mocks.mintFlowMock.mockResolvedValue({ kind: "unavailable" });

  clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
});

afterEach(() => {
  clearIntervalSpy.mockRestore();
});

// Requirement 11: the client is always closed with its settle reason, and
// the endpoint poll interval is always cleared - assert this on every path.
function expectCleanTeardown(): void {
  expect(mocks.clientCloseMock).toHaveBeenCalledWith(
    "host-install-credential-provisioning-settled",
  );
  expect(clearIntervalSpy).toHaveBeenCalled();
}

describe("provisionInstalledHostCredential", () => {
  it("reports active with minted:false when the host already holds a credential, and probes with the exact subscribe params", async () => {
    const hostId = "host-1";
    mocks.onSessionCreated = (): void => {
      setTimeout(() => {
        capturedClientOptions().onHostCredentialState(hostId, "active");
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 2_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "active",
      minted: false,
    });
    expect(mocks.mintFlowMock).not.toHaveBeenCalled();
    // Those exact params are validated by the protocol schema - a drift
    // here breaks the probe silently.
    expect(mocks.subscribeMock).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeMock).toHaveBeenCalledWith(
      "host.notifications.subscribe",
      { filter: "unread", initialLimit: 1 },
    );
    expect(mocks.sessions).toHaveLength(1);
    expect(mocks.sessions[0].close).toHaveBeenCalledTimes(1);
    expectCleanTeardown();
  });

  it("the headline path: mints on a missing ack and verifies active on the reconnect lap", async () => {
    const hostId = "host-1";
    mocks.mintFlowMock.mockResolvedValueOnce(provisionedOutcome());
    mocks.onSessionCreated = (_session, lapIndex): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        if (lapIndex === 1) {
          void options.hostCredentialMint({ hostId, reason: "missing" });
          options.onHostCredentialState(hostId, "missing");
          return;
        }
        options.onHostCredentialState(hostId, "active");
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 5_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "active",
      minted: true,
    });
    expect(mocks.mintFlowMock).toHaveBeenCalledTimes(1);
    expect(mocks.mintFlowMock).toHaveBeenCalledWith({
      hostId,
      reason: "missing",
    });
    expect(mocks.subscribeMock).toHaveBeenCalledTimes(2);
    expect(mocks.subscribeMock).toHaveBeenNthCalledWith(
      1,
      "host.notifications.subscribe",
      { filter: "unread", initialLimit: 1 },
    );
    expect(mocks.subscribeMock).toHaveBeenNthCalledWith(
      2,
      "host.notifications.subscribe",
      { filter: "unread", initialLimit: 1 },
    );
    expect(mocks.sessions).toHaveLength(2);
    expect(mocks.sessions[0].close).toHaveBeenCalledTimes(1);
    expect(mocks.sessions[1].close).toHaveBeenCalledTimes(1);
    expectCleanTeardown();
  });

  it("closes the handoff session only AFTER the mint settles, never under the write", async () => {
    const hostId = "host-1";
    const deferredMint = createDeferred<HostCredentialMintOutcome>();
    mocks.mintFlowMock.mockReturnValueOnce(
      deferredMint.promise.then((outcome) => {
        mocks.callOrder.push("mint-settled");
        return outcome;
      }),
    );
    mocks.onSessionCreated = (_session, lapIndex): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        if (lapIndex === 1) {
          void options.hostCredentialMint({ hostId, reason: "missing" });
          options.onHostCredentialState(hostId, "missing");
          return;
        }
        options.onHostCredentialState(hostId, "active");
      }, 0);
    };

    const resultPromise = provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 5_000, progress: vi.fn() }),
    );

    // Hold the mint pending for a stretch that comfortably outlasts any
    // synchronous/microtask-scale mistake: a regression that closes the
    // session immediately on the ack (instead of awaiting the mint) would
    // push "close" within a few milliseconds, long before this fires.
    await sleep(100);
    deferredMint.resolve(provisionedOutcome());

    const outcome = await resultPromise;

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "active",
      minted: true,
    });
    // "mint-settled" first (lap 1's handoff), then two closes: lap 1's
    // handoff session (after the drain) and lap 2's verify session (on the
    // active ack). Order is the whole point of this test.
    expect(mocks.callOrder).toEqual(["mint-settled", "close", "close"]);
    expectCleanTeardown();
  });

  it("reports mint-unavailable when the mint flow resolves unavailable, and still closes the session", async () => {
    const hostId = "host-1";
    mocks.mintFlowMock.mockResolvedValueOnce({ kind: "unavailable" });
    mocks.onSessionCreated = (): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        void options.hostCredentialMint({ hostId, reason: "missing" });
        options.onHostCredentialState(hostId, "missing");
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 2_000, progress: vi.fn() }),
    );

    // A failed mint is NOT terminal: the same `unavailable` covers the 409
    // supersede, so the probe keeps verifying and only reports the failure
    // once no ack ever said `active`. Every session it opened is closed.
    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "mint-unavailable",
    });
    expect(mocks.sessions.length).toBeGreaterThan(1);
    for (const session of mocks.sessions) {
      expect(session.close).toHaveBeenCalledTimes(1);
    }
    expectCleanTeardown();
  });

  it("a superseded mint still verifies: the winner's credential lands as active, not as a failure", async () => {
    // The regression this guards: `createCliHostCredentialMintFlow` maps the
    // 409 supersede onto `unavailable`, and treating that as terminal made an
    // ordinary concurrent GUI/monitor mint print a false "not provisioned"
    // warning on an install that in fact ended fully credentialed.
    const hostId = "host-1";
    mocks.mintFlowMock.mockResolvedValueOnce({ kind: "unavailable" });
    mocks.onSessionCreated = (_session, lapIndex): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        if (lapIndex === 1) {
          void options.hostCredentialMint({ hostId, reason: "missing" });
          options.onHostCredentialState(hostId, "missing");
          return;
        }
        // The winner's credential arrived while we were losing the race.
        options.onHostCredentialState(hostId, "active");
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 5_000, progress: vi.fn() }),
    );

    // `minted: false` - the host is credentialed, but not by us, so the
    // caller stays quiet instead of claiming the provisioning.
    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "active",
      minted: false,
    });
    expect(mocks.sessions).toHaveLength(2);
    expectCleanTeardown();
  });

  it("bounds the mint await by the remaining deadline instead of the mint's own timeout", async () => {
    // The regression this guards: an unbounded `await` on the mint let a host
    // that acked `missing` near the end of the budget push `host install`
    // roughly the mint's full HTTP timeout past the advertised deadline.
    const hostId = "host-1";
    // Never settles - only the deadline can end this.
    mocks.mintFlowMock.mockReturnValueOnce(
      new Promise<HostCredentialMintOutcome>(() => {}),
    );
    mocks.onSessionCreated = (): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        void options.hostCredentialMint({ hostId, reason: "missing" });
        options.onHostCredentialState(hostId, "missing");
      }, 0);
    };

    const deadlineMs = 600;
    const startedAt = Date.now();
    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs, progress: vi.fn() }),
    );
    const elapsed = Date.now() - startedAt;

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "mint-unavailable",
    });
    // Generous headroom over the deadline, but far under the unbounded case:
    // a hung mint used to hold the loop open indefinitely.
    expect(elapsed).toBeLessThan(deadlineMs + 1_500);
    expectCleanTeardown();
  });

  it("reports mint-unavailable when the mint flow throws (a rejected promise)", async () => {
    const hostId = "host-1";
    mocks.mintFlowMock.mockRejectedValueOnce(
      new Error("mint transport blew up"),
    );
    mocks.onSessionCreated = (): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        void options.hostCredentialMint({ hostId, reason: "missing" });
        options.onHostCredentialState(hostId, "missing");
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 2_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "mint-unavailable",
    });
    expect(mocks.sessions.length).toBeGreaterThan(1);
    for (const session of mocks.sessions) {
      expect(session.close).toHaveBeenCalledTimes(1);
    }
    expectCleanTeardown();
  });

  it("reports unreachable when the host never acks and the connection never opens before the deadline", async () => {
    // No `onSessionCreated` hook: nothing ever arrives on the session, so
    // the lap's own bound timeout is what resolves it.
    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 300, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "unreachable",
    });
    expect(mocks.mintFlowMock).not.toHaveBeenCalled();
    expect(mocks.sessions).toHaveLength(1);
    expect(mocks.sessions[0].close).toHaveBeenCalledTimes(1);
    expectCleanTeardown();
  });

  it("reports unsupported when the connection opens but the host never reports a credential state (an older host)", async () => {
    mocks.onSessionCreated = (session): void => {
      setTimeout(() => {
        session.emitStatus("open", null);
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      // Comfortably above SILENT_ACK_GRACE_MS (100ms) so the grace timer -
      // not the overall deadline - is what resolves the first lap.
      makeOptions({ deadlineMs: 400, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "unsupported",
    });
    expect(mocks.mintFlowMock).not.toHaveBeenCalled();
    expect(mocks.sessions.length).toBeGreaterThan(0);
    for (const session of mocks.sessions) {
      expect(session.close).toHaveBeenCalledTimes(1);
    }
    expectCleanTeardown();
  });

  // Each non-active lap drains for PUSH_DRAIN_MS (750ms), so four laps is
  // genuinely a few seconds - well past the 5s default test timeout, hence
  // the explicit one on this case.
  it("reports not-adopted when the mint succeeds but adoption is never verified within MAX_SESSIONS laps", async () => {
    const hostId = "host-1";
    mocks.mintFlowMock.mockResolvedValueOnce(provisionedOutcome());
    mocks.onSessionCreated = (_session, lapIndex): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        if (lapIndex === 1) {
          void options.hostCredentialMint({ hostId, reason: "missing" });
        }
        // Every lap keeps acking "missing" - adoption never verifies.
        options.onHostCredentialState(hostId, "missing");
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 10_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "not-adopted",
    });
    expect(mocks.mintFlowMock).toHaveBeenCalledTimes(1);
    // MAX_SESSIONS laps, every one closed.
    expect(mocks.sessions).toHaveLength(4);
    for (const session of mocks.sessions) {
      expect(session.close).toHaveBeenCalledTimes(1);
    }
    expectCleanTeardown();
  }, 15_000);

  it("reports unreachable on a fatal close before any mint was attempted", async () => {
    mocks.onSessionCreated = (session): void => {
      setTimeout(() => {
        session.emitStatus(
          "closed",
          fatalReason("simulated fatal close before any mint"),
        );
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 2_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "unreachable",
    });
    expect(mocks.mintFlowMock).not.toHaveBeenCalled();
    expectCleanTeardown();
  });

  it("reports not-adopted on a fatal close after a mint was invoked", async () => {
    const hostId = "host-1";
    mocks.mintFlowMock.mockResolvedValueOnce(provisionedOutcome());
    mocks.onSessionCreated = (session, lapIndex): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        if (lapIndex === 1) {
          void options.hostCredentialMint({ hostId, reason: "missing" });
          options.onHostCredentialState(hostId, "missing");
          return;
        }
        session.emitStatus(
          "closed",
          fatalReason("simulated fatal close after a mint attempt"),
        );
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 5_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "not-adopted",
    });
    expect(mocks.mintFlowMock).toHaveBeenCalledTimes(1);
    expectCleanTeardown();
  });

  it("resolves to an error outcome instead of rejecting on an unexpected throw", async () => {
    mocks.subscribeMock.mockImplementationOnce(() => {
      throw new Error("simulated subscribe failure");
    });

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 2_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "error",
      message: "simulated subscribe failure",
    });
    // The finally block runs on the error path too.
    expectCleanTeardown();
  });
});
