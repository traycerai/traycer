import type {
  BrowserForgetLedger,
  BrowserPrimaryProfileDelta,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserSessionsStreamEventEnvelope,
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabStatusChange,
} from "@traycer-clients/shared/platform/browser-view";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { BrowserSessionsTabPort } from "../browser-sessions-electron-tabs";
import type {
  BrowserSessionsJarPort,
  BrowserSessionsRegistryDeps,
} from "../browser-sessions-owner";
import type { BrowserPrimaryProfileCaptureResult } from "../../browser-view/storage/browser-storage-state";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
export {
  FakeStreamClient,
  FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { BrowserSessionsHostTransport } from "../browser-sessions-transport";
import type {
  BrowserViewEnsureTab,
  BrowserViewNativeTabTransfer,
} from "../../browser-view/browser-view-port";

export interface JarRecorder {
  readonly observed: Array<{
    readonly connectionId: string;
    readonly hostId: string;
    readonly domain: string;
    readonly cookieNames: readonly string[];
  }>;
  readonly acks: Array<{
    readonly hostId: string;
    readonly connectionId: string;
    readonly revision: number;
    readonly sentRevision: number;
  }>;
  readonly releasedConnectionIds: string[];
  readonly wrapped: string[];
  readonly unwrapped: string[];
  readonly attested: Array<{ readonly hostId: string; readonly nonce: string }>;
  captures: number;
  ledger: BrowserForgetLedger;
  emitLedgerChange: () => void;
  emitDelta: (delta: BrowserPrimaryProfileDelta) => void;
  readonly port: BrowserSessionsJarPort;
  /**
   * When true, `capturePrimaryProfile` returns a promise that only settles
   * once a suite calls {@link resolvePendingCapture} - a way to pin what a
   * stream does with a jar read that is still in flight when the connection
   * changes underneath it.
   */
  deferCaptures: boolean;
  /** Resolves the OLDEST still-pending deferred capture, in call order. */
  resolvePendingCapture: () => void;
  /**
   * When set, the NEXT `capturePrimaryProfile` call rejects with this error
   * instead of returning a result, then clears itself - once only, the way
   * one bad file read is.
   */
  failNextCapture: Error | null;
  /**
   * When true, `capturePrimaryProfileBehindBarrier` holds the gate closed
   * until a suite calls {@link releaseBarrier} - a way to pin what a
   * HOST-issued capture, or the final capture at close/quit, does while a
   * whole-jar barrier (a forget-all, a login import) is still pending.
   * Unlike {@link deferCaptures}, a barrier is not a per-call queue: every
   * awaiter blocked on it is released together, because that is what a
   * barrier is - one gate, not one slot per caller.
   */
  deferBarrier: boolean;
  /** Releases every awaiter currently blocked on the held barrier. */
  releaseBarrier: () => void;
  /**
   * How many `capturePrimaryProfileBehindBarrier` calls answered `null`
   * because the barrier was still held past their bounded `waitMs` - the
   * final capture's shutdown-budget path, never the host's unbounded ask.
   */
  boundedWaitTimeouts: number;
}

export function createJarRecorder(): JarRecorder {
  const ledgerListeners = new Set<() => void>();
  const deltaListeners = new Set<(delta: BrowserPrimaryProfileDelta) => void>();
  const pendingCaptures: Array<() => void> = [];
  let barrierWaiters: Array<() => void> = [];
  /**
   * The read every jar-reading port method shares: counted in
   * `recorder.captures`, honors `failNextCapture` once, and defers behind
   * `deferCaptures` exactly like the un-barriered path did before.
   */
  function readPrimaryProfile(): Promise<BrowserPrimaryProfileCaptureResult> {
    recorder.captures += 1;
    if (recorder.failNextCapture !== null) {
      const error = recorder.failNextCapture;
      recorder.failNextCapture = null;
      return Promise.reject(error);
    }
    const result: BrowserPrimaryProfileCaptureResult = {
      status: "captured",
      storageState: { cookies: [], origins: [] },
      reason: null,
    };
    if (!recorder.deferCaptures) return Promise.resolve(result);
    return new Promise<BrowserPrimaryProfileCaptureResult>((resolve) => {
      pendingCaptures.push(() => {
        resolve(result);
      });
    });
  }
  const recorder: JarRecorder = {
    observed: [],
    acks: [],
    releasedConnectionIds: [],
    wrapped: [],
    unwrapped: [],
    attested: [],
    captures: 0,
    deferCaptures: false,
    failNextCapture: null,
    deferBarrier: false,
    boundedWaitTimeouts: 0,
    resolvePendingCapture: () => {
      const resolve = pendingCaptures.shift();
      if (resolve === undefined) {
        throw new Error("no pending capture to resolve");
      }
      resolve();
    },
    releaseBarrier: () => {
      const waiters = barrierWaiters;
      barrierWaiters = [];
      for (const resolve of waiters) resolve();
    },
    ledger: { forgetAllAt: null, domains: [], revision: 0 },
    emitLedgerChange: () => {
      for (const listener of ledgerListeners) listener();
    },
    emitDelta: (delta) => {
      for (const listener of deltaListeners) listener(delta);
    },
    port: {
      capturePrimaryProfile: () => readPrimaryProfile(),
      // No barrier held by default: a host-issued capture (and the final
      // capture) reads at once. A suite that sets `deferBarrier` holds every
      // awaiter open until it calls `releaseBarrier`. `waitMs === null` waits
      // however long the barrier holds; a bounded wait answers `null` - and
      // counts a bounded-wait timeout - if `releaseBarrier` has not been
      // called by then.
      capturePrimaryProfileBehindBarrier: (waitMs) => {
        if (!recorder.deferBarrier) return readPrimaryProfile();
        if (waitMs === null) {
          return new Promise<BrowserPrimaryProfileCaptureResult | null>(
            (resolve) => {
              barrierWaiters.push(() => {
                resolve(readPrimaryProfile());
              });
            },
          );
        }
        return new Promise<BrowserPrimaryProfileCaptureResult | null>(
          (resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              recorder.boundedWaitTimeouts += 1;
              resolve(null);
            }, waitMs);
            barrierWaiters.push(() => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(readPrimaryProfile());
            });
          },
        );
      },
      applyObservedProfile: (input) => {
        recorder.observed.push({
          connectionId: input.connectionId,
          hostId: input.hostId,
          domain: input.domain,
          cookieNames: input.cookies.map((cookie) => cookie.name),
        });
        return Promise.resolve();
      },
      wrapStoreKey: (rawKey, userId, hostId) => {
        // Both ids the wrap is matched on, so a suite can tell WHICH account
        // and host a wrap was priced against.
        recorder.wrapped.push(`${userId}:${hostId}:${rawKey}`);
        return "d3JhcHBlZA==";
      },
      unwrapStoreKey: (wrappedKey, userId) => {
        recorder.unwrapped.push(`${userId}:${wrappedKey}`);
        return "cmF3";
      },
      attestDesktopIdentity: (input) => {
        recorder.attested.push(input);
        return Promise.resolve({
          publicKey: "cHVibGlj",
          keystoreId: "keystore-1",
          signature: "c2ln",
          jarEligible: true,
        });
      },
      readForgetLedger: () => recorder.ledger,
      recordForgetLedgerAck: (ack) => {
        recorder.acks.push(ack);
        return Promise.resolve();
      },
      releaseForgetLedgerConnection: (connectionId) => {
        recorder.releasedConnectionIds.push(connectionId);
      },
      onForgetLedgerChanged: (listener) => {
        ledgerListeners.add(listener);
        return {
          dispose: () => {
            ledgerListeners.delete(listener);
          },
        };
      },
      onPrimaryProfileDelta: (listener) => {
        deltaListeners.add(listener);
        return {
          dispose: () => {
            deltaListeners.delete(listener);
          },
        };
      },
    },
  };
  return recorder;
}

export interface TabRecorder {
  readonly ensured: Array<{
    readonly windowId: string;
    readonly input: BrowserViewEnsureTab;
  }>;
  readonly accepted: BrowserViewNativeTabCapability[];
  readonly released: BrowserViewNativeTabCapability[];
  readonly cdp: Array<{ readonly tabId: string }>;
  emitStatus: (change: BrowserViewNativeTabStatusChange) => void;
  emitTransferred: (transfer: BrowserViewNativeTabTransfer) => void;
  readonly port: BrowserSessionsTabPort;
}

export function createTabRecorder(): TabRecorder {
  const statusListeners = new Set<
    (change: BrowserViewNativeTabStatusChange) => void
  >();
  const transferListeners = new Set<
    (transfer: BrowserViewNativeTabTransfer) => void
  >();
  const recorder: TabRecorder = {
    ensured: [],
    accepted: [],
    released: [],
    cdp: [],
    emitStatus: (change) => {
      for (const listener of statusListeners) listener(change);
    },
    emitTransferred: (transfer) => {
      for (const listener of transferListeners) listener(transfer);
    },
    port: {
      ensureTab: (windowId, input) => {
        recorder.ensured.push({ windowId, input });
        return Promise.resolve({
          hostId: input.hostId,
          sessionId: input.sessionId,
          tabId: input.tabId,
          registrationId: `registration-${recorder.ensured.length}`,
        });
      },
      acceptTab: (input) => {
        recorder.accepted.push(input);
        return Promise.resolve();
      },
      releaseTab: (input) => {
        recorder.released.push(input);
        return Promise.resolve(true);
      },
      dispatchElectronTabCdp: (input) => {
        recorder.cdp.push({ tabId: input.tabId });
        return Promise.resolve({
          kind: "cdpNavigate",
          ok: true,
          errorText: null,
        });
      },
      onNativeTabStatusChange: (listener) => {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
        };
      },
      onNativeTabTransferred: (listener) => {
        transferListeners.add(listener);
        return () => {
          transferListeners.delete(listener);
        };
      },
    },
  };
  return recorder;
}

export const LOCAL_HOST_ENTRY: HostDirectoryEntry = {
  hostId: "host-1",
  label: "host-1",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:1234",
  version: "1.0.0",
  transportDialability: "dialable",
};

export interface RegistryHarness {
  readonly deps: BrowserSessionsRegistryDeps;
  rotateBearer: () => void;
  /** This machine's host id, as main reads it; null before a host publishes. */
  localHostId: string | null;
  /** The signed-in user main reads for itself; null while signed out. */
  userId: string | null;
  publishLocalHost: (hostId: string) => void;
  /**
   * What the directory answers for a host id. Replaceable so a suite can hold
   * the read open (the resolve is one await wide, and an identity change
   * inside it is the race worth pinning) or answer `null` for a host that is
   * not in the account's registry.
   */
  resolveHost: (hostId: string) => Promise<HostDirectoryEntry | null>;
  /** How many times a fresh identity dropped the whole cached registry. */
  readonly directoryResets: { count: number };
  readonly jar: JarRecorder;
  readonly tabs: TabRecorder;
  readonly clients: FakeStreamClient[];
  readonly emitted: Array<{
    readonly windowId: string;
    readonly envelope: BrowserSessionsStreamEventEnvelope;
  }>;
  readonly closedTransports: number[];
  /** Host ids whose cached directory row the stream threw away. */
  readonly invalidated: readonly string[];
}

export function createRegistryHarness(): RegistryHarness {
  const jar = createJarRecorder();
  const tabs = createTabRecorder();
  const clients: FakeStreamClient[] = [];
  const emitted: RegistryHarness["emitted"] = [];
  const closedTransports: number[] = [];
  const openTransport = (): BrowserSessionsHostTransport => {
    // The desktop suites drive the connection themselves - the attach burst,
    // a rotation, a terminal close - so a subscription must not be born open.
    const client = new FakeStreamClient(false);
    const index = clients.push(client) - 1;
    return {
      wsStreamClient: client,
      close: () => {
        closedTransports.push(index);
      },
    };
  };
  const localHostListeners = new Set<() => void>();
  const bearerListeners = new Set<() => void>();
  const invalidated: string[] = [];
  const harness: RegistryHarness = {
    jar,
    tabs,
    clients,
    emitted,
    closedTransports,
    invalidated,
    localHostId: "host-1",
    userId: "user-1",
    resolveHost: () => Promise.resolve(LOCAL_HOST_ENTRY),
    directoryResets: { count: 0 },
    rotateBearer: () => {
      for (const listener of bearerListeners) listener();
    },
    publishLocalHost: (hostId) => {
      harness.localHostId = hostId;
      for (const listener of localHostListeners) listener();
    },
    deps: {
      directory: {
        invalidate: (hostId) => {
          invalidated.push(hostId);
        },
        reset: () => {
          harness.directoryResets.count += 1;
        },
        resolve: (hostId) => harness.resolveHost(hostId),
        endpoint: () => ({
          hostId: LOCAL_HOST_ENTRY.hostId,
          websocketUrl: LOCAL_HOST_ENTRY.websocketUrl,
        }),
      },
      openTransport,
      jar: jar.port,
      tabs: tabs.port,
      userId: () => harness.userId,
      localHostId: () => harness.localHostId,
      subscribeLocalHostChange: (listener) => {
        localHostListeners.add(listener);
        return () => {
          localHostListeners.delete(listener);
        };
      },
      subscribeBearerRotation: (listener) => {
        bearerListeners.add(listener);
        return () => {
          bearerListeners.delete(listener);
        };
      },
      emit: (windowId, envelope) => {
        emitted.push({ windowId, envelope });
      },
    },
  };
  return harness;
}
