import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  HostClient,
  type HostClientChangeEvent,
  type HostQueryInvalidationOptions,
  type IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { buildHostKeyRotationSweep } from "@/lib/host/host-key-rotation-sweep";

/**
 * (A) THE UNIT PIN. `buildHostKeyRotationSweep` (read its header first - the
 * contract and its stated limits live there) turns one directory emit into
 * "which REMOTE hosts rotated their public key under the same id" and hands
 * those ids to `sweepHostScope`. These cases drive the closure directly with
 * a bare recorder so each rule is isolated from `HostClient` entirely; (B)
 * below is what proves the closure wired to a REAL client behaves.
 */

/** A remote row with a chosen `publicKey`, built from the shared fixture. */
function remoteEntry(overrides: {
  readonly hostId?: string;
  readonly publicKey: string;
}): RemoteHostDirectoryEntry {
  return {
    ...mockRemoteHostEntry,
    hostId: overrides.hostId ?? mockRemoteHostEntry.hostId,
    publicKey: overrides.publicKey,
    relayFuseGrace: false,
    recentHostCheckIn: false,
    planAllowsRemote: true,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
  };
}

/** A local row with a chosen `websocketUrl`, built from the shared fixture. */
function localEntry(websocketUrl: string): HostDirectoryEntry {
  return { ...mockLocalHostEntry, websocketUrl };
}

function buildSweepRecorder(): {
  readonly sweep: (entries: readonly HostDirectoryEntry[]) => void;
  readonly swept: string[];
} {
  const swept: string[] = [];
  const sweep = buildHostKeyRotationSweep({
    sweepHostScope: (hostId) => {
      swept.push(hostId);
    },
  });
  return { sweep, swept };
}

describe("buildHostKeyRotationSweep", () => {
  it("sweeps a host whose public key changed between two emits, and only that host", () => {
    const { sweep, swept } = buildSweepRecorder();
    const other = remoteEntry({ hostId: "other-host", publicKey: "pk-other" });
    sweep([remoteEntry({ publicKey: "pk-a" }), other]);
    expect(swept).toEqual([]);

    sweep([remoteEntry({ publicKey: "pk-b" }), other]);

    expect(swept).toEqual([mockRemoteHostEntry.hostId]);
  });

  it("does not sweep a host's FIRST sighting - an arrival is not a rotation", () => {
    const { sweep, swept } = buildSweepRecorder();

    sweep([remoteEntry({ publicKey: "pk-a" })]);

    expect(swept).toEqual([]);
  });

  it("does not sweep when the same key repeats across emits", () => {
    const { sweep, swept } = buildSweepRecorder();
    sweep([remoteEntry({ publicKey: "pk-a" })]);

    sweep([remoteEntry({ publicKey: "pk-a" })]);
    sweep([remoteEntry({ publicKey: "pk-a" })]);

    expect(swept).toEqual([]);
  });

  it("sweeps both hosts when two remote entries rotate in the SAME emit, and nothing else", () => {
    const { sweep, swept } = buildSweepRecorder();
    const hostX = { hostId: "host-x", publicKey: "x-1" };
    const hostY = { hostId: "host-y", publicKey: "y-1" };
    sweep([remoteEntry(hostX), remoteEntry(hostY)]);
    expect(swept).toEqual([]);

    sweep([
      remoteEntry({ hostId: hostX.hostId, publicKey: "x-2" }),
      remoteEntry({ hostId: hostY.hostId, publicKey: "y-2" }),
    ]);

    expect(swept).toEqual([hostX.hostId, hostY.hostId]);
  });

  it("never sweeps a LOCAL entry - R-1 is a remote-only fact, local rows carry no publicKey", () => {
    const { sweep, swept } = buildSweepRecorder();
    sweep([localEntry("ws://127.0.0.1:4917/rpc")]);

    // Whatever else changes about a local row, `isRemoteHostDirectoryEntry`
    // excludes it before the key comparison ever runs.
    sweep([localEntry("ws://127.0.0.1:4918/rpc")]);

    expect(swept).toEqual([]);
  });

  it("keeps the last-seen key across an absence - reappearing with the SAME key does not sweep, reappearing with a DIFFERENT key does", () => {
    const { sweep, swept } = buildSweepRecorder();
    const hostId = mockRemoteHostEntry.hostId;

    // Arrival.
    sweep([remoteEntry({ hostId, publicKey: "pk-1" })]);
    expect(swept).toEqual([]);

    // The directory empties for a reason that has nothing to do with a
    // rebuild (an auth-era refresh, a failed-then-retried fetch).
    sweep([]);

    // Reappears with the SAME key - the map was never pruned on the way out,
    // so this reads as "nothing rotated", not as a second arrival.
    sweep([remoteEntry({ hostId, publicKey: "pk-1" })]);
    expect(swept).toEqual([]);

    // Absent again, then reappears with a DIFFERENT key - a genuine rotation
    // that happened to straddle the host's absence from the directory.
    sweep([]);
    sweep([remoteEntry({ hostId, publicKey: "pk-2" })]);

    expect(swept).toEqual([hostId]);
  });
});

/**
 * (B) THE NO-ANNOUNCE PIN, against a REAL `HostClient`. R-1's sweep runs
 * through `invalidateHostScopeUnannounced`
 * (`host-client.test.ts`'s "un-strands a host's scope without announcing a
 * change" pins that method generically); this proves the SWEEP itself, wired
 * end to end, produces exactly that shape - one unannounced invalidation, no
 * change event - and nothing more.
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

class RecordingInvalidator implements IHostQueryInvalidator {
  readonly calls: Array<string | null> = [];
  readonly options: HostQueryInvalidationOptions[] = [];
  invalidateHostScope(
    hostId: string | null,
    options: HostQueryInvalidationOptions,
  ): void {
    this.calls.push(hostId);
    this.options.push(options);
  }
}

function buildRealHostClient(): {
  readonly client: HostClient<typeof registry>;
  readonly invalidator: RecordingInvalidator;
  readonly events: HostClientChangeEvent[];
} {
  const invalidator = new RecordingInvalidator();
  const messenger = new MockHostMessenger<typeof registry>({
    registry,
    handlers: { "host.ping": () => ({ pong: true }) },
    requestId: () => "req-1",
  });
  const directory = new Map<string, HostDirectoryEntry>([
    [mockLocalHostEntry.hostId, mockLocalHostEntry],
    [mockRemoteHostEntry.hostId, mockRemoteHostEntry],
  ]);
  const client = new HostClient<typeof registry>({
    registry,
    messenger,
    invalidator,
    findHostById: (hostId) => directory.get(hostId) ?? null,
  });
  const events: HostClientChangeEvent[] = [];
  client.onChange((event) => {
    events.push(event);
  });
  return { client, invalidator, events };
}

/**
 * Host-scope sweeps are coalesced per host per microtask tick
 * (`HostClient.deliverHostScopeSweep`), so the invalidation/change-event
 * decision lands one microtask after the reporting call - see
 * `host-client.test.ts`'s identically-named helper.
 */
async function flushAvailabilityCoalescing(): Promise<void> {
  await Promise.resolve();
}

describe("buildHostKeyRotationSweep wired to a real HostClient", () => {
  it("invalidates the rotated host's scope WITHOUT announcing a change event", async () => {
    const { client, invalidator, events } = buildRealHostClient();
    const sweep = buildHostKeyRotationSweep({
      sweepHostScope: (hostId) => client.invalidateHostScopeUnannounced(hostId),
    });

    sweep([remoteEntry({ publicKey: "pk-1" })]);
    await flushAvailabilityCoalescing();
    // No rotation yet - only a first sighting - so nothing to flush.
    expect(invalidator.calls).toEqual([]);
    expect(events).toEqual([]);

    sweep([remoteEntry({ publicKey: "pk-2" })]);
    await flushAvailabilityCoalescing();

    expect(invalidator.calls).toEqual([mockRemoteHostEntry.hostId]);
    expect(invalidator.options).toEqual([{ refetchActive: true }]);
    // THE CLAIM: a rotation swept ALONE in its microtask tick must produce
    // zero change events. A reason-scoped consumer (an `availability-recovered`
    // subscriber) would otherwise be woken for an event that never happened -
    // nothing recovered availability here, a scope was merely invalidated.
    //
    // This does NOT claim a rotation sweep coalesced with a GENUINE
    // availability report stays silent - it would announce there, correctly,
    // because the availability caller asked and its announcement is true.
    // That composition is `host-client.test.ts`'s "coalesces same-tick
    // availability reports..." case, at the `HostClient` layer generically;
    // this file's subject is the sweep alone.
    expect(events).toEqual([]);
  });
});
