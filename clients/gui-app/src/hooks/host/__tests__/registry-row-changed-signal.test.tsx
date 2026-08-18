import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  HostClient,
  type HostQueryInvalidationOptions,
  type IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useReactiveOwnerIdentityKey } from "@/hooks/host/use-reactive-owner-identity-key";

/**
 * THE P4.2 HANDOFF INSTRUMENT (redesign P4.1), now discharged.
 *
 * P4.2 deletes `HostClient.bind()` and the active slot. The only thing that
 * told a React consumer pinned by host id to look again when its row landed
 * was that slot's change event, so the deletion was safe only if a
 * replacement signal already carried it. This file is where that claim was
 * measured rather than asserted, and the measurement came out: the registry
 * carries it.
 *
 * IT USED TO HOLD A SECOND CASE, and its deletion is part of the same commit
 * that removed the arm it measured. `slot event only` reproduced the PRE-P4.1
 * world - no registry source installed, so the registry arm was inert by
 * construction and the landed row could only reach the consumer through
 * `bind()`. That case's entire subject was the slot event. Once
 * `useReactiveHostReadiness` stopped subscribing to `client.onChange` there
 * was no honest version of it left: kept as-is it fails, and any rewrite that
 * makes it pass is asserting something else while wearing its name. Deleted
 * rather than kept green, because a test whose subject no longer exists is
 * the vacuity class this epic keeps paying for.
 *
 * What remains is the assertion the deletion was allowed on - the row lands,
 * the directory emits, `bind()` is never called, and the consumer re-reads
 * off the registry alone - plus the render-suppression pin that keeps the
 * coarse arm's unconditional wake from churning the tree. The pair that made
 * the original flip readable is now history: it lives in the execution log
 * and in P4.1's K15 result, not in a case that can no longer fail for the
 * reason it was written for.
 */

const pingV10 = defineRpcContract({
  method: "host.ping",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ pong: z.literal(true) }),
});

const registry = defineVersionedRpcRegistry({
  "host.ping": {
    1: {
      latestMinor: 0,
      versions: { 0: { contract: pingV10, upgradeFromPreviousVersion: null } },
      downgradePathsFromLatest: {},
    },
  },
});

/** The host whose row has not arrived yet - a machine still booting. */
const LATE_HOST_ID = "late-host";
const LATE_HOST: HostDirectoryEntry = {
  hostId: LATE_HOST_ID,
  label: "Late Host",
  kind: "remote",
  websocketUrl: "wss://late.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

/**
 * A fully-formed REMOTE row, because the additive case below turns on a field
 * only a remote entry carries. Its public key is what R-1 rotates.
 */
const ROTATING_HOST_ID = "rotating-host";
const rotatingHost = (publicKey: string): RemoteHostDirectoryEntry => ({
  hostId: ROTATING_HOST_ID,
  label: "Rotating Host",
  kind: "remote",
  // Every remote host shares one fixed relay attach URL, so a rotation is a
  // same-URL event by construction - the key is the only thing that moves.
  websocketUrl: "wss://rotating.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
  publicKey,
  relayFuseGrace: false,
  remoteStatus: {
    connectivity: "connectable",
    viewerReachability: "ok",
    clientCloud: "ok",
    updateState: "current",
    appVersion: null,
    lastSeenAt: null,
  },
});

class NoopInvalidator implements IHostQueryInvalidator {
  invalidateHostScope(
    _hostId: string | null,
    _options: HostQueryInvalidationOptions,
  ): void {
    // Cache behavior is not what these cases are about.
  }
}

/** The narrowest directory that can gain a row and say so. */
class LateArrivingDirectory {
  entries: HostDirectoryEntry[] = [];
  private readonly listeners = new Set<() => void>();

  findById(hostId: string): HostDirectoryEntry | null {
    const found = this.entries.find((entry) => entry.hostId === hostId);
    // A FRESH object per read, like production: the local row is rebuilt per
    // snapshot and crosses the IPC bridge as a new object. A registry that
    // compared by reference would report a change on every emit and this
    // suite would pass for the wrong reason.
    return found === undefined ? null : { ...found };
  }

  onChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The host finishes booting and its row lands in the directory. */
  publishLateHost(): void {
    this.entries = [LATE_HOST];
    this.emit();
  }

  /**
   * A directory emit that changes NOTHING about any row - the benign churn
   * production produces constantly (a respawn-in-place whose only delta is a
   * pid the entry does not carry).
   */
  emitUnchanged(): void {
    this.emit();
  }

  /** Seeds/rotates the remote row R-1 is about, then says so. */
  publishRotatingHost(publicKey: string): void {
    this.entries = [rotatingHost(publicKey)];
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function buildPinnedRequester(directory: LateArrivingDirectory): {
  readonly client: HostClient<typeof registry>;
  readonly pinned: HostClient<typeof registry>;
} {
  const provider = new DefaultRequestContextProvider({ origin: "renderer" });
  provider.setSignedIn({
    user: createAuthenticatedUserFixture(undefined),
    bearerToken: "bearer-1",
    operationId: undefined,
    externalAbortSignal: undefined,
  });
  const client = new HostClient<typeof registry>({
    registry,
    messenger: new MockHostMessenger<typeof registry>({
      registry,
      handlers: { "host.ping": () => ({ pong: true }) },
      requestId: () => "req-1",
    }),
    invalidator: new NoopInvalidator(),
    findHostById: (hostId) => directory.findById(hostId),
  });
  client.setRequestContext(provider.current());
  // What a window pointed at a host that has not resolved yet holds: the id
  // is named, the row is not there, so the requester answers `null` exactly
  // as an unbound client always did.
  return { client, pinned: client.createRequesterForHostId(LATE_HOST_ID) };
}

describe("the registry's row-changed signal (P4.2 handoff)", () => {
  afterEach(() => {
    cleanup();
    resetHostConnectionRegistryForTest();
  });

  it("reaches the consumer through the REGISTRY with bind() never called (the post-P4.1 world)", () => {
    const directory = new LateArrivingDirectory();
    const { pinned } = buildPinnedRequester(directory);
    installHostConnectionRegistrySource({
      directory: {
        findById: (hostId) => directory.findById(hostId),
        onDirectoryChanged: (listener) => directory.onChange(listener),
      },
      leases: null,
    });

    const { result } = renderHook(() => useReactiveHostReadiness(pinned));
    expect(result.current.hostId).toBeNull();
    expect(result.current.isReady).toBe(false);

    act(() => {
      directory.publishLateHost();
    });

    // No `bind()` anywhere in this case. This is the assertion P4.2 is
    // allowed to delete the slot on.
    expect(result.current.hostId).toBe(LATE_HOST_ID);
    expect(result.current.isReady).toBe(true);
  });

  it("renders nothing on a directory emit that moved no row this consumer can see", () => {
    const directory = new LateArrivingDirectory();
    directory.entries = [LATE_HOST];
    const { pinned } = buildPinnedRequester(directory);
    installHostConnectionRegistrySource({
      directory: {
        findById: (hostId) => directory.findById(hostId),
        onDirectoryChanged: (listener) => directory.onChange(listener),
      },
      leases: null,
    });

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useReactiveHostReadiness(pinned);
    });
    expect(result.current.hostId).toBe(LATE_HOST_ID);
    const rendersAfterMount = renders;

    // The coarse arm deliberately WAKES on every source emit (a consumer that
    // cannot name its host must be woken by rows it has never seen). What
    // stops that from churning the tree is the value-compared snapshot, and
    // this is where that is pinned: `findById` hands back a fresh object
    // every read, so a reference-compared snapshot would re-render here.
    act(() => {
      directory.emitUnchanged();
    });
    expect(renders).toBe(rendersAfterMount);
  });

  /**
   * THE SECOND PROJECTION, and the reason this case is additive rather than a
   * duplicate: the two cases above drive `useReactiveHostReadiness`. All three
   * projections that lost their `client.onChange` arm in P4.2 ride the SAME
   * coarse subscription (`subscribeAnyHostRowChanged`), so what distinguishes
   * this case is not the arm - it is the projection reading off it and the
   * stimulus that moves it. One projection being carried is not evidence that
   * another is: they compose different snapshots from different fields.
   *
   * The stimulus is R-1: a same-`hostId` public-key rotation
   * (re-enrollment / corruption recovery). It is worth pinning HERE
   * specifically because P4.2 deleted the only case that covered it - the
   * client-layer test asserted `bind()` re-binding a rotated entry, and that
   * mechanism is gone. A rotation is now an ordinary row change and this is
   * the arm that has to carry it; nothing else asserts that it does.
   */
  it("re-projects the owner identity on an R-1 public-key rotation, through the COARSE arm", () => {
    const directory = new LateArrivingDirectory();
    const { client } = buildPinnedRequester(directory);
    directory.publishRotatingHost("pubkey-a");
    installHostConnectionRegistrySource({
      directory: {
        findById: (hostId) => directory.findById(hostId),
        onDirectoryChanged: (listener) => directory.onChange(listener),
      },
      leases: null,
    });
    const pinnedToRotating = client.createRequesterForHostId(ROTATING_HOST_ID);

    const { result } = renderHook(() =>
      useReactiveOwnerIdentityKey(pinnedToRotating),
    );
    const before = result.current;
    expect(before).not.toBeNull();
    expect(before).toContain("pubkey-a");

    // ONLY the key moves: same id, same relay URL, same version, same status.
    act(() => {
      directory.publishRotatingHost("pubkey-b");
    });

    expect(result.current).not.toBe(before);
    expect(result.current).toContain("pubkey-b");
  });
});
