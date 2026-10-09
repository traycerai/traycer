import { describe, expect, it } from "vitest";
import {
  InMemoryAuthorityIdentitySource,
  InMemoryHostFleetSource,
  InMemoryPreferredHostStore,
  inertLocalHostOutageSignal,
  unavailableLocalHostEnsurePort,
} from "@traycer-clients/shared/host-selection/in-process-selection-authority";
import { SelectionAuthorityEngineImpl } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { SELECTION_AUTHORITY_CONTRACT_VERSION } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { createFakeAuthorityClock } from "@traycer-clients/shared/host-selection/__tests__/selection-authority-harness";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { HostDirectoryService } from "@/lib/host/host-directory-service";

/**
 * F6b, end to end: a host registered LATE - from the CLI, or from another
 * machine - must become activatable without waiting for an unrelated refresh.
 *
 * The renderer's directory learns about it on its own poll. The selection
 * authority, which lives in the desktop main process and holds its OWN fleet,
 * learns nothing - so `activate()` refuses `unknown-host` and the user is told
 * a machine they just registered is not on their account.
 *
 * This drives the REAL surfaces on both sides: the actual
 * `SelectionAuthorityEngineImpl.activate` refusal, and the actual
 * `IRunnerHost.refreshHostFleet()` contract member the directory announces
 * through. The only stand-in is the shell's implementation of that member,
 * which does here what a real shell does - re-read membership and republish
 * its snapshot.
 */

const IDENTITY_KEY = "user-1";

function directoryEntry(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "remote",
    websocketUrl: `wss://${hostId}.example.invalid/rpc`,
    version: "0.0.0-test",
    transportDialability: "dialable",
  };
}

function buildWorld() {
  // What the cloud registry currently says this account owns. The CLI
  // registering a host is a write to THIS, observed by whoever polls next.
  const registry: { current: readonly string[] } = { current: ["host-a"] };
  // What the next directory poll comes back as: the listing, or the fetcher
  // saying it had no bearer (`signed-out`) or could not ask (`failed`).
  const fetchKind: { current: "hosts" | "signed-out" | "failed" } = {
    current: "hosts",
  };

  const fleet = new InMemoryHostFleetSource({
    revision: 0,
    identityGeneration: 0,
    localHostId: null,
    hosts: registry.current.map((hostId) => ({
      hostId,
      kind: "remote" as const,
    })),
  });

  const engine = new SelectionAuthorityEngineImpl({
    fleet,
    identity: new InMemoryAuthorityIdentitySource(IDENTITY_KEY),
    localHostEnsure: unavailableLocalHostEnsurePort,
    localOutage: inertLocalHostOutageSignal,
    preferredStore: new InMemoryPreferredHostStore(),
    // The shared fake, not a hand-rolled one: `AuthorityClock` is P1.3's and
    // still moving, and a local stub would drift from it silently.
    clock: createFakeAuthorityClock(0),
    newIncarnationId: () => "incarnation-1",
    log: { debug: () => undefined, warn: () => undefined },
  });

  // The shell's half: republish the membership it can see. A real shell reads
  // its own source; the point is that it is driven by `refreshHostFleet()`,
  // not by anything the renderer invents.
  let fleetRefreshCount = 0;
  const runnerHost = createFakeRunnerHost({
    refreshHostFleet: () => {
      fleetRefreshCount += 1;
      fleet.publish(
        0,
        null,
        registry.current.map((hostId) => ({
          hostId,
          kind: "remote" as const,
        })),
      );
      return Promise.resolve();
    },
  });

  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: () => {
      if (fetchKind.current === "signed-out") {
        return Promise.resolve({ kind: "signed-out" as const });
      }
      if (fetchKind.current === "failed") {
        return Promise.resolve({ kind: "failed" as const });
      }
      return Promise.resolve({
        kind: "hosts" as const,
        entries: registry.current.map(directoryEntry),
      });
    },
    localHostIdSeeder: () => Promise.resolve(null),
    onRegistryPollTick: null,
    authContextId: () => IDENTITY_KEY,
    credentialGeneration: () => 1,
  });

  return {
    registry,
    fetchKind,
    fleet,
    engine,
    directory,
    fleetRefreshes: () => fleetRefreshCount,
  };
}

function attachedReporter(engine: SelectionAuthorityEngineImpl): {
  readonly reporterId: string;
  readonly incarnationId: string;
} {
  const reporterId = "window-1";
  const attach = engine.attach(reporterId, {
    attachSeq: engine.allocateAttachSeq(reporterId),
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions: [],
  });
  if (!attach.ok) throw new Error(`attach refused: ${attach.kind}`);
  return { reporterId, incarnationId: attach.incarnationId };
}

describe("a host registered late becomes activatable", () => {
  it("refuses activate for a host main has not heard of, then accepts it once the directory announces", async () => {
    const world = buildWorld();
    const { reporterId, incarnationId } = attachedReporter(world.engine);

    // The CLI registers host-b on another machine. Main's fleet still holds
    // only host-a, so Activate refuses - this is the user-visible defect.
    world.registry.current = ["host-a", "host-b"];
    const beforeAnnounce = await world.engine.activate(
      reporterId,
      incarnationId,
      "host-b",
    );
    expect(beforeAnnounce).toEqual({ ok: false, reason: "unknown-host" });

    // The renderer's directory poll observes the new membership and announces.
    await world.directory.refresh();

    const afterAnnounce = await world.engine.activate(
      reporterId,
      incarnationId,
      "host-b",
    );
    expect(afterAnnounce).toEqual({ ok: true });
  });

  it("announces once for the added id, not again on a no-change poll", async () => {
    const world = buildWorld();

    // First fetch finds hosts: one announce. Correct rather than noise - main's
    // fleet can be as stale at cold start as at any other moment.
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(1);

    // Same membership: nothing was added, so nothing is announced.
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(1);

    world.registry.current = ["host-a", "host-b"];
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(2);
  });

  it("announces when a host is REMOVED from the registry, so a sandbox that left the account stops being the selection's target", async () => {
    const world = buildWorld();
    world.registry.current = ["host-a", "host-b"];
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(1);

    // A sandbox leaves the registry on the server's own schedule (a destroy
    // that answered 202, the day-30 freeze): nothing in this client asked,
    // so the poll that sees it gone is the only thing that can tell main.
    world.registry.current = ["host-a"];
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(2);
    // The refresh republished main's membership without the removed host.
    expect(world.fleet.snapshot().hosts.map((host) => host.hostId)).toEqual([
      "host-a",
    ]);

    // Same membership again: the removal is announced once, not every poll.
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(2);
  });

  it("a host added and another removed in the same poll announces once", async () => {
    const world = buildWorld();
    world.registry.current = ["host-a", "host-b"];
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(1);

    world.registry.current = ["host-a", "host-c"];
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(2);
  });

  it("does not read a signed-out poll as every host removed", async () => {
    const world = buildWorld();
    world.registry.current = ["host-a", "host-b"];
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(1);

    // `signed-out` commits an EMPTY set. Without the `hosts` check that
    // would read as host-a and host-b both removed and refetch main's fleet
    // on every sign-out the poll observes.
    world.fetchKind.current = "signed-out";
    const afterSignOut = await world.directory.refresh();
    expect(afterSignOut).toEqual([]);
    expect(world.fleetRefreshes()).toBe(1);
  });

  it("does not announce for a failed poll, which keeps the last-known hosts", async () => {
    const world = buildWorld();
    world.registry.current = ["host-a", "host-b"];
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(1);

    world.fetchKind.current = "failed";
    await world.directory.refresh();
    expect(world.fleetRefreshes()).toBe(1);
  });
});
