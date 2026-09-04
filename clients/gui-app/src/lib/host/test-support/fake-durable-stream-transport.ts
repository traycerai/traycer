/**
 * A `DurableStreamTransport` opener that mints no socket.
 *
 * Every suite that mounts `EpicSessionProvider` needs one. The provider opens
 * a transport UNCONDITIONALLY - there is no longer any path that skips it, and
 * the branch that once did (the stream-factory override) was deleted because a
 * factory built on MAIN cannot cross `postMessage` to a runtime living in the
 * worker. So "no socket in tests" has to be supplied HERE, at the opener, and
 * a stub that throws no longer expresses it: throwing used to be safe only
 * because a branch above meant the opener was never reached.
 *
 * What crosses to the worker is this fake's `wsStreamClient`. It is INERT by
 * construction and that is not a shortcut: a suite driving a live replica
 * supplies its own factories to `createInProcessEpicRuntimeWorker`, and
 * `epic-runtime-composition.ts` takes `laneSelection` from those factories
 * rather than deriving it - so nothing reads this client at all. The one
 * member with a considered value is `getMethodSupport`, which pins the adapter
 * verdict to `"legacy"` (never `"undecided"`, never `"lanes"`) for the one
 * suite that does exercise the real proxy path.
 *
 * One registry per test FILE. `opener`'s identity is load-bearing:
 * `useDurableStreamTransportFactory` is documented as returning a
 * referentially-STABLE opener, and the acquire effect depends on it - so a
 * reset restores the SAME default function rather than minting a new one, and
 * a suite that wants to churn the identity does so deliberately (see `opener`).
 */
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { AttributableDurableStreamTransport } from "@/lib/host/durable-stream-transport";

/** One transport this opener minted, and what has happened to it since. */
export interface FakeTransportRecord {
  readonly hostId: string;
  closeCount: number;
  readonly closeReasons: string[];
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
}

export interface FakeDurableStreamTransports {
  /** Every transport minted since the last reset, in open order. */
  readonly records: ReadonlyArray<FakeTransportRecord>;
  /**
   * The opener to return from a mocked `useDurableStreamTransportFactory`.
   *
   * MUTABLE, and deliberately - assigning a new function is how a suite churns
   * the opener's IDENTITY, which is a property the provider has to absorb.
   * `epic-session-provider.test.tsx`'s "absorbs a churning effect dependency"
   * pin does exactly that, and the failure it guards is an infinite render loop
   * rather than a wasted render: the acquire effect depends on this identity, so
   * a provider that wrote a fresh presentation per commit would churn it again
   * and write again. Nothing in production enforces stability, which is why the
   * pin has to be able to break it here.
   *
   * A mock must therefore read this member on every hook call
   * (`() => fakeDurableStreamTransports().opener`) rather than capture it once.
   * `resetFakeDurableStreamTransports` puts the default back, so a churned
   * opener cannot leak into the next test in the file.
   */
  opener: (hostId: string) => AttributableDurableStreamTransport;
}

function fakeStreamSession(): IStreamSession {
  return {
    sendClientFrame: () => undefined,
    onServerFrame: () => undefined,
    onStatusChange: () => undefined,
    getNegotiatedSchemaVersion: () => null,
    requestReconnect: () => undefined,
    close: () => undefined,
  };
}

function createWsStreamClient(
  instanceIndex: number,
  closeReasons: string[],
): IHostStreamClient<HostStreamRpcRegistry> {
  let closed = false;
  let closedReason: string | null = null;
  return {
    subscribe: () => fakeStreamSession(),
    subscribeWithParamsProvider: () => fakeStreamSession(),
    close: (reason) => {
      if (closed) return;
      closed = true;
      closedReason = reason;
      closeReasons.push(reason);
    },
    isClosed: () => closed,
    isReady: () => true,
    getClosedReason: () => closedReason,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    // "unsupported" on every lane method pins the adapter-selection verdict to
    // "legacy" - see `readEpicAdapterVerdict` / `EPIC_LANE_METHODS`. It matters
    // only for a suite that lets the real `buildProxiedStreamFactories` run;
    // a suite supplying its own factories never reaches this member, because
    // the composition takes `laneSelection` from those factories directly.
    getMethodSupport: () => "unsupported",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    instanceId: `fake-ws-stream-client-${instanceIndex}`,
    subscribeAvailabilityRecovered: () => () => undefined,
    onClosed: () => () => undefined,
  };
}

const records: FakeTransportRecord[] = [];

const defaultOpener = (hostId: string): AttributableDurableStreamTransport => {
  const closeReasons: string[] = [];
  const wsStreamClient = createWsStreamClient(records.length, closeReasons);
  const record: FakeTransportRecord = {
    hostId,
    closeCount: 0,
    closeReasons,
    wsStreamClient,
  };
  records.push(record);
  const closeWithReason = (reason: string): void => {
    record.closeCount += 1;
    wsStreamClient.close(reason);
  };
  return {
    wsStreamClient,
    close: () => {
      closeWithReason("durable-transport-closed");
    },
    closeWithReason,
  };
};

const shared: FakeDurableStreamTransports = { records, opener: defaultOpener };

/**
 * The file's registry.
 *
 * Reachable from BOTH sides of the mock boundary, which is the whole reason it
 * is module-scoped rather than constructed by the caller: a `vi.mock` factory
 * runs hoisted, before the test file's imports, so it cannot close over a value
 * the test body also holds. Both sides call this instead and resolve the same
 * module.
 */
export function fakeDurableStreamTransports(): FakeDurableStreamTransports {
  return shared;
}

/**
 * Forget every minted transport and restore the default opener. Call in
 * `beforeEach`.
 *
 * Records are cleared IN PLACE, because `records` is handed out as a live view
 * and a replacement array would leave every holder reading a detached one.
 */
export function resetFakeDurableStreamTransports(): void {
  records.length = 0;
  shared.opener = defaultOpener;
}
