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
import type { StreamAuthRevalidator } from "../../../../shared/auth/bearer-revalidator";

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
  // The probe wires this so an expired access token can be refreshed instead
  // of making the first UNAUTHORIZED terminal; tests drive it directly.
  readonly auth: StreamAuthRevalidator | null;
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
  // Typed with just the fields tests need (`signal`, `onUnauthorized`)
  // rather than the mint flow's full options shape - the real call site
  // (source, not this mock) is still checked against the real signature, so
  // this only needs to be wide enough for `.mock.calls` to expose what the
  // probe actually wired.
  const createMintFlowMock = vi.fn(
    (_options: {
      readonly signal: AbortSignal | null;
      readonly onUnauthorized: (() => void) | null;
    }) => mintFlowMock,
  );

  const readHostPidMetadataMock = vi.fn(async () => null);
  const isValidLocalHostWebsocketUrlMock = vi.fn((): boolean => true);

  // The credentials store is mocked wholesale: the real one resolves paths
  // under the operator's actual `~/.traycer` and its `rotate` spends a
  // single-use refresh token. `revalidateCurrentContextMock` is what tests
  // drive to simulate a refresh outcome.
  const revalidateCurrentContextMock = vi.fn(
    async (): Promise<"rotated" | "rejected" | "network-error"> => "rotated",
  );
  const storeDisposeMock = vi.fn((): void => undefined);
  const createCliCredentialsStoreMock = vi.fn(() => ({
    dispose: storeDisposeMock,
  }));
  // Same rationale as `createMintFlowMock` above: typed just wide enough to
  // expose `signal` from `.mock.calls`.
  const createStoreBackedRevalidatorMock = vi.fn(
    (_args: { readonly signal: AbortSignal | null }) => ({
      revalidateCurrentContext: revalidateCurrentContextMock,
    }),
  );

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
      | ((session: FakeStreamSession, lapIndex: number) => void)
      | null,
    FakeWsStreamClient,
    subscribeMock,
    clientCloseMock,
    mintFlowMock,
    createMintFlowMock,
    readHostPidMetadataMock,
    isValidLocalHostWebsocketUrlMock,
    revalidateCurrentContextMock,
    storeDisposeMock,
    createCliCredentialsStoreMock,
    createStoreBackedRevalidatorMock,
  };
});

vi.mock("../../../../shared/host-transport/ws-stream-client", () => ({
  WsStreamClient: mocks.FakeWsStreamClient,
}));

vi.mock("../../store/credentials-store", () => ({
  createCliCredentialsStore: mocks.createCliCredentialsStoreMock,
  createStoreBackedRevalidator: mocks.createStoreBackedRevalidatorMock,
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

// The onUnauthorized hook the probe wires into
// `createCliHostCredentialMintFlow` - captured from the mock factory's own
// call args, distinct from `capturedClientOptions` (the stream client).
function capturedMintFlowOptions(): {
  readonly signal: AbortSignal | null;
  readonly onUnauthorized: (() => void) | null;
} {
  const call = mocks.createMintFlowMock.mock.calls[0];
  if (call === undefined) {
    throw new Error("createCliHostCredentialMintFlow was never called");
  }
  return call[0];
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

function fatalReason(reason: string, code: string): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code,
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

  mocks.createCliCredentialsStoreMock.mockClear();
  mocks.createStoreBackedRevalidatorMock.mockClear();
  mocks.storeDisposeMock.mockClear();
  // Same hazard as `mintFlowMock`: tests set bespoke outcomes here.
  mocks.revalidateCurrentContextMock.mockReset();
  mocks.revalidateCurrentContextMock.mockResolvedValue("rotated");

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
    // `settleMint` is a pure pacing bound now - it abandons the WAIT, never
    // the bookkeeping - so a mint that is still unsettled when the deadline
    // fires is neither provisioned nor definitively failed: `settledOutcome`
    // only claims `not-adopted` for a mint that definitively PROVISIONED
    // (`mintProvisioned`), so an invoked-but-unsettled mint reports
    // `mint-unavailable` instead - "the handoff did not complete" is all
    // that is known, not an adoption failure the host can be blamed for.
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

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 600, progress: vi.fn() }),
    );

    // Deliberately NOT a wall-clock assertion: this suite runs real timers
    // with 750ms drains, so an elapsed-time bound is a flake waiting for a
    // loaded runner. The regression is a HANG - an unbounded await on a mint
    // that never settles - and it shows up as the outcome being reached at
    // all, plus the single lap the exhausted budget allows. Under the old
    // code this test does not fail an assertion, it times out.
    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "mint-unavailable",
    });
    expect(mocks.sessions).toHaveLength(1);
    expect(mocks.sessions[0].close).toHaveBeenCalledTimes(1);
    expectCleanTeardown();
  });

  it("a mint that settles provisioned only after the wait gave up still counts once a later ack verifies active", async () => {
    // `recordMintOutcome` is attached to the mint's own promise BEFORE
    // `settleMint` is ever called, so it keeps listening independent of
    // whatever `settleMint`'s pacing bound decided. A mint that took longer
    // than a short deadline would ever have waited for it (see the previous
    // test) still lands as `minted: true` once it resolves, as long as a
    // later lap is still around to observe `active`.
    const hostId = "host-1";
    const deferredMint = createDeferred<HostCredentialMintOutcome>();
    mocks.mintFlowMock.mockReturnValueOnce(deferredMint.promise);
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

    // Comfortably longer than the 600ms deadline the previous test used to
    // exhaust a tight budget entirely - this mint would have been abandoned
    // under that budget. Here the overall deadline is generous, so the late
    // settlement still lands well before it.
    await sleep(900);
    deferredMint.resolve(provisionedOutcome());

    const outcome = await resultPromise;

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "active",
      minted: true,
    });
    expect(mocks.mintFlowMock).toHaveBeenCalledTimes(1);
    expectCleanTeardown();
  }, 10_000);

  it("a mint that settles unavailable only after the wait gave up still reports mint-unavailable when no ack ever verifies active", async () => {
    const hostId = "host-1";
    const deferredMint = createDeferred<HostCredentialMintOutcome>();
    mocks.mintFlowMock.mockReturnValueOnce(deferredMint.promise);
    mocks.onSessionCreated = (_session, lapIndex): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        if (lapIndex === 1) {
          void options.hostCredentialMint({ hostId, reason: "missing" });
          options.onHostCredentialState(hostId, "missing");
        }
        // Every later lap keeps acking "missing" too - adoption never
        // verifies, so the late `unavailable` is what decides the outcome.
      }, 0);
    };

    const resultPromise = provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 3_000, progress: vi.fn() }),
    );

    await sleep(900);
    deferredMint.resolve({ kind: "unavailable" });

    const outcome = await resultPromise;

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "mint-unavailable",
    });
    expect(mocks.mintFlowMock).toHaveBeenCalledTimes(1);
    expectCleanTeardown();
  }, 10_000);

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

  it("stops re-dialing an older host after a few silent opens instead of spending the whole deadline", async () => {
    // Regression guard on the lap-cap removal. Running verification to the
    // deadline is right for a question whose answer can still change - has
    // the host adopted the credential yet - but a connection that opens
    // without the ack ever carrying a state is a property of the host's
    // BUILD. Re-dialing cannot change it, so burning the budget on it would
    // leave `host install` sitting for the full deadline before printing
    // that this host cannot be credentialed. The previous coverage used a
    // 400ms deadline, which is too short to tell the two apart.
    const deadlineMs = 20_000;
    mocks.onSessionCreated = (session): void => {
      setTimeout(() => {
        session.emitStatus("open", null);
      }, 0);
    };

    const startedAt = Date.now();
    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs, progress: vi.fn() }),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "unsupported",
    });
    // SILENT_OPEN_CONFIRMATIONS laps, each a grace window plus its pacing -
    // nowhere near the budget.
    expect(mocks.sessions).toHaveLength(3);
    expect(elapsedMs).toBeLessThan(deadlineMs / 2);
    expectCleanTeardown();
  }, 25_000);

  it("reports unsupported and stops after a single lap when a non-active state arrives with the mint hook never invoked (a withheld mint)", async () => {
    // The state rides the handshake and is reported before this method's own
    // version check even runs, so a version-incompatible ack (or a non-UUID
    // legacy host id) shows up as a non-active state that the client decided
    // NOT to mint for - `mintInvoked` never flips. Both are deterministic for
    // this client, so the probe must not burn further laps re-measuring a
    // constant: exactly one session, no retry.
    mocks.onSessionCreated = (): void => {
      setTimeout(() => {
        capturedClientOptions().onHostCredentialState("host-1", "missing");
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 5_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "unsupported",
    });
    expect(mocks.mintFlowMock).not.toHaveBeenCalled();
    expect(mocks.subscribeMock).toHaveBeenCalledTimes(1);
    expect(mocks.sessions).toHaveLength(1);
    expect(mocks.sessions[0].close).toHaveBeenCalledTimes(1);
    expectCleanTeardown();
  });

  // Each non-active lap drains for PUSH_DRAIN_MS (750ms) and then waits out
  // the verify backoff, so these two cases are genuinely multi-second - well
  // past the 5s default test timeout, hence the explicit ones.
  it("reports not-adopted only after spending the whole deadline, not after a fixed lap count", async () => {
    // Regression: verification used to stop after MAX_SESSIONS (4) laps,
    // which on a fast-acking host is a couple of seconds. A host that needed
    // longer to persist and advertise its credential was then told it "did
    // not adopt it in time" with most of the budget unspent - blaming it for
    // a deadline it was never actually given. The deadline is now the only
    // stop condition, so the probe must still be watching near the end of it.
    const hostId = "host-1";
    const deadlineMs = 8_000;
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

    const startedAt = Date.now();
    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs, progress: vi.fn() }),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "not-adopted",
    });
    expect(mocks.mintFlowMock).toHaveBeenCalledTimes(1);
    // The load-bearing assertion: under the old fixed cap this returned in
    // roughly 3s regardless of the budget. Allow slack for the final lap's
    // pacing, but stay far above what four laps could ever cost.
    expect(elapsedMs).toBeGreaterThan(deadlineMs - 1_500);
    // ...and it kept re-verifying rather than giving up at the old cap.
    expect(mocks.sessions.length).toBeGreaterThan(4);
    for (const session of mocks.sessions) {
      expect(session.close).toHaveBeenCalledTimes(1);
    }
    expectCleanTeardown();
  }, 20_000);

  it("reports active when adoption lands on a lap past the old four-lap cap", async () => {
    // The payoff of the change above: a host slow to advertise its
    // credential is now actually caught adopting it, instead of being
    // reported `not-adopted` while it was still on its way there.
    const hostId = "host-1";
    const adoptOnLap = 5;
    mocks.mintFlowMock.mockResolvedValueOnce(provisionedOutcome());
    mocks.onSessionCreated = (_session, lapIndex): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        if (lapIndex === 1) {
          void options.hostCredentialMint({ hostId, reason: "missing" });
        }
        options.onHostCredentialState(
          hostId,
          lapIndex >= adoptOnLap ? "active" : "missing",
        );
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 20_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "active",
      minted: true,
    });
    expect(mocks.sessions).toHaveLength(adoptOnLap);
    expectCleanTeardown();
  }, 25_000);

  it("does not report unreachable when the host answered but the refresh never completed", async () => {
    // Regression: an expired stored bearer against a temporarily unreachable
    // authn is the shape where the host keeps answering UNAUTHORIZED, each
    // revalidation comes back `network-error` (neither a rejection nor a
    // success), and the stream just reconnects until the budget runs out.
    // Nothing recorded that the host had answered, so the terminal fallback
    // was `unreachable` - "the host did not come up in time" - about a host
    // that replied to every dial. Reaching the reconnect revalidator at all
    // proves contact, so the truthful report is the handoff failing.
    mocks.revalidateCurrentContextMock.mockResolvedValue("network-error");
    mocks.onSessionCreated = (_session, lapIndex): void => {
      // Fire on the FIRST lap only, and bind `auth` here - synchronously,
      // while `capturedOptions` is still this test's client. Re-reading it
      // inside the timer would let a timer that outlives this probe drive
      // the NEXT test's revalidator, which is precisely what the
      // deadline-revalidation case below asserts never happens. One call is
      // all this needs: the flag it sets does not clear.
      if (lapIndex !== 1) {
        return;
      }
      const auth = capturedClientOptions().auth;
      if (auth === null) {
        throw new Error("probe wired no reconnect revalidator");
      }
      setTimeout(() => {
        // The host rejected our bearer: this is exactly the callback the
        // transport invokes on an UNAUTHORIZED close. No ack ever follows.
        void auth.revalidateForReconnect();
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 1_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "mint-unavailable",
    });
    expect(mocks.mintFlowMock).not.toHaveBeenCalled();
    expectCleanTeardown();
  }, 10_000);

  it("confirms a mint 401 with exactly one rotation, however many laps follow", async () => {
    // Regression: `mintUnauthorized` never clears (the 401 is a fact about
    // this run), so the confirmation branch re-fired on every later
    // non-active lap - spending a fresh single-use refresh family each time
    // and racing whatever other signed-in client holds the same one. The
    // branch asks one question ("is this sign-in dead?") whose answer cannot
    // change lap to lap, so it may rotate at most once. Now that laps run to
    // the deadline rather than stopping at four, an unlatched confirm would
    // churn credentials far more than it used to.
    const hostId = "host-1";
    mocks.mintFlowMock.mockImplementation(async () => {
      // Mirrors the real flow: authn's 401 fires the hook synchronously,
      // before the mint promise settles as `unavailable`.
      capturedMintFlowOptions().onUnauthorized?.();
      return { kind: "unavailable" };
    });
    // A successful rotation - so `credentialRejected` stays false and the
    // probe keeps looping, which is precisely when the old code re-rotated.
    mocks.revalidateCurrentContextMock.mockResolvedValue("rotated");
    mocks.onSessionCreated = (_session, lapIndex): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        if (lapIndex === 1) {
          void options.hostCredentialMint({ hostId, reason: "missing" });
        }
        options.onHostCredentialState(hostId, "missing");
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 6_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "mint-unavailable",
    });
    // Several laps ran, so an unlatched branch had every chance to re-rotate.
    expect(mocks.sessions.length).toBeGreaterThan(2);
    expect(mocks.revalidateCurrentContextMock).toHaveBeenCalledTimes(1);
    expectCleanTeardown();
  }, 15_000);

  it("reports the close code when the host fatally closes before any mint", async () => {
    // Regression: this used to be reported as `unreachable`, which is false
    // on its face - a fatal `closed` frame PROVES the host answered. With no
    // rejected sign-in and no mint history to explain it otherwise, the close
    // code itself is now surfaced as an `error` outcome.
    mocks.onSessionCreated = (session): void => {
      setTimeout(() => {
        session.emitStatus(
          "closed",
          fatalReason("simulated fatal close before any mint", "UNAUTHORIZED"),
        );
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 2_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "error",
      message: "the host closed the stream (UNAUTHORIZED)",
    });
    expect(mocks.mintFlowMock).not.toHaveBeenCalled();
    expectCleanTeardown();
  });

  it("still reports the close code when a reconnect revalidation fired before the fatal close", async () => {
    // Guards the seam between two fixes. The `hostAnswered` fallback exists
    // so an unexplained probe stops claiming `unreachable`, but the
    // fatal-close arm decides whether to surface the close code - and if it
    // asked "did this settle as unreachable?", the fallback would answer
    // "no, mint-unavailable" and swallow the code. The close code is the
    // more diagnostic of the two, so contact via the revalidator must not
    // displace it.
    mocks.revalidateCurrentContextMock.mockResolvedValue("network-error");
    mocks.onSessionCreated = (session, lapIndex): void => {
      if (lapIndex !== 1) {
        return;
      }
      // Bound synchronously - see the reachability case above for why a
      // timer must not re-read the captured options.
      const auth = capturedClientOptions().auth;
      if (auth === null) {
        throw new Error("probe wired no reconnect revalidator");
      }
      setTimeout(() => {
        void auth.revalidateForReconnect();
        session.emitStatus(
          "closed",
          fatalReason("simulated fatal close after a refresh", "INTERNAL"),
        );
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 2_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "error",
      message: "the host closed the stream (INTERNAL)",
    });
    expectCleanTeardown();
  });

  it("reports unsupported on a fatal close whose code is INCOMPATIBLE, before any state was observed", async () => {
    // This method failed the host's version-compatibility check on the
    // handshake itself (no state ever rode an ack), which is a capability gap
    // the self-heal covers - not an unreachable host and not the generic
    // "closed the stream" error the other fatal codes get.
    mocks.onSessionCreated = (session): void => {
      setTimeout(() => {
        session.emitStatus(
          "closed",
          fatalReason("simulated version mismatch", "INCOMPATIBLE"),
        );
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 2_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "unsupported",
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
          fatalReason(
            "simulated fatal close after a mint attempt",
            "UNAUTHORIZED",
          ),
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

  it("reports unauthorized (never the self-healing kinds) when revalidation is terminally rejected", async () => {
    // `resolveHostAuth` only checks that the stored token is non-empty, so a
    // revoked/expired refresh family still reads as "signed in" at pre-flight.
    // The probe then finds out the hard way. Reporting that as `unreachable`
    // told the user a later client would sort it out - false, because no
    // client can mint on a dead credential either. They have to sign in.
    mocks.revalidateCurrentContextMock.mockResolvedValue("rejected");
    mocks.onSessionCreated = (): void => {
      setTimeout(() => {
        void capturedClientOptions().auth?.revalidateForReconnect();
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 500, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "unauthorized",
    });
    expectCleanTeardown();
  });

  it("reports unauthorized even after a mint resolved - a rejected sign-in outranks mint history", async () => {
    // `settledOutcome` checks `credentialRejected` FIRST, ahead of
    // `mintUnavailable`/`mintInvoked`: a dead sign-in explains every other
    // symptom below it, so it must win the priority order even when this run
    // also minted (and lost, or was superseded) before the rejection landed.
    const hostId = "host-1";
    mocks.revalidateCurrentContextMock.mockResolvedValue("rejected");
    mocks.mintFlowMock.mockResolvedValueOnce({ kind: "unavailable" });
    mocks.onSessionCreated = (_session, lapIndex): void => {
      setTimeout(() => {
        const options = capturedClientOptions();
        if (lapIndex === 1) {
          void options.hostCredentialMint({ hostId, reason: "missing" });
          options.onHostCredentialState(hostId, "missing");
          void options.auth?.revalidateForReconnect();
        }
        // Later laps ack nothing - adoption never verifies either.
      }, 0);
    };

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 2_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "unauthorized",
    });
    expect(mocks.mintFlowMock).toHaveBeenCalledTimes(1);
    expectCleanTeardown();
  });

  it("a mint that 401s, confirmed by a terminally rejected rotation, reports unauthorized", async () => {
    // `createCliHostCredentialMintFlow` fires `onUnauthorized` synchronously
    // before its own promise resolves (mirroring the real flow: the flag is
    // settled whenever the mint is), then still returns `{ kind:
    // "unavailable" }` - the stream contract has no richer kind. This probe
    // treats that specific failure as NOT client-local (the host accepted the
    // very same bearer to open this stream) and confirms via one rotation
    // before deciding: a terminal rejection means the sign-in is dead.
    const hostId = "host-1";
    mocks.revalidateCurrentContextMock.mockResolvedValue("rejected");
    mocks.mintFlowMock.mockImplementationOnce(
      async (): Promise<HostCredentialMintOutcome> => {
        const options = capturedMintFlowOptions();
        if (options.onUnauthorized !== null) {
          options.onUnauthorized();
        }
        return { kind: "unavailable" };
      },
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
      kind: "unauthorized",
    });
    expectCleanTeardown();
  });

  it("a mint that 401s, confirmed by a successful rotation, stays mint-unavailable - a later client can still mint", async () => {
    // The other half of the same confirmation: a successful rotation proves
    // the stored sign-in is alive, so the 401 was this run's own problem (an
    // expired access token this probe had not refreshed yet) rather than a
    // dead credential - the self-heal promise in `mint-unavailable` stays
    // true.
    const hostId = "host-1";
    mocks.revalidateCurrentContextMock.mockResolvedValue("rotated");
    mocks.mintFlowMock.mockImplementationOnce(
      async (): Promise<HostCredentialMintOutcome> => {
        const options = capturedMintFlowOptions();
        if (options.onUnauthorized !== null) {
          options.onUnauthorized();
        }
        return { kind: "unavailable" };
      },
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
    expectCleanTeardown();
  });

  it("does not START a revalidation once the deadline is spent", async () => {
    // The CLI sets `process.exitCode` instead of calling `process.exit`, so
    // the process waits for the event loop to drain: a rotation begun as the
    // budget ran out would hold `host install` open past its bound, and
    // disposing the store does not cancel one already in flight.
    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 0, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "unreachable",
    });
    // Drive the hook DIRECTLY now the budget is spent, rather than scheduling
    // a timer: a timer late enough to be past the deadline is also late
    // enough to fire after the probe returned, which would assert nothing.
    const auth = capturedClientOptions().auth;
    if (auth === null) {
      throw new Error("expected the probe to wire a stream auth revalidator");
    }
    await expect(auth.revalidateForReconnect()).resolves.toBe("rejected");
    expect(mocks.revalidateCurrentContextMock).not.toHaveBeenCalled();
    expectCleanTeardown();
  });

  it("a throw during SETUP is mapped, not propagated, and releases what was already acquired", async () => {
    // The setup (endpoint poll, mint flow, credentials store, stream client)
    // used to run OUTSIDE this module's try. A throw there escaped the error
    // mapping entirely and surfaced out of `host install` - after the bytes
    // were swapped and the service started - turning a completed install into
    // a reported failure, and leaking the poll interval on the way out.
    mocks.createMintFlowMock.mockImplementationOnce(() => {
      throw new Error("simulated setup failure");
    });

    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 2_000, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "error",
      message: "simulated setup failure",
    });
    // The interval was armed before the throw, so it must be cleared; the
    // client never got constructed, so closing it must NOT be attempted.
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(mocks.clientCloseMock).not.toHaveBeenCalled();
    expect(mocks.subscribeMock).not.toHaveBeenCalled();
  });

  it("wires the SAME live AbortSignal into the revalidator and the mint flow, aborted once the probe settles", async () => {
    // The probe's own controller cancels its own remote work - the mint's
    // HTTP request and the locked credential rotation - on the way out, so an
    // abandoned one cannot keep a drain-to-exit CLI open past its deadline.
    // No `onSessionCreated` hook: nothing ever acks, so the lap's own bound
    // resolves the probe and every acquired resource is torn down in
    // `finally`, including this controller.
    const outcome = await provisionInstalledHostCredential(
      makeOptions({ deadlineMs: 300, progress: vi.fn() }),
    );

    expect(outcome).toEqual<HostCredentialProvisionOutcome>({
      kind: "unreachable",
    });
    expect(mocks.createStoreBackedRevalidatorMock).toHaveBeenCalledTimes(1);
    expect(mocks.createMintFlowMock).toHaveBeenCalledTimes(1);
    const revalidatorSignal =
      mocks.createStoreBackedRevalidatorMock.mock.calls[0][0].signal;
    const mintFlowSignal = mocks.createMintFlowMock.mock.calls[0][0].signal;
    if (revalidatorSignal === null) {
      throw new Error("expected the probe to wire a revalidator signal");
    }
    // Same controller backs both: they are cancelled together.
    expect(mintFlowSignal).toBe(revalidatorSignal);
    expect(revalidatorSignal.aborted).toBe(true);
  });
});
