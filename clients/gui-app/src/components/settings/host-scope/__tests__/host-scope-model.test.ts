import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  HostListItem,
  HostPresenceHealth,
} from "@traycer/protocol/host/host-status";
import {
  buildHostScopeOptions,
  resolveScopedHost,
  transientClientEntry,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { dialableHostEndpoint } from "@/lib/host/transport-key";

/**
 * `connectable` is the model's answer to "can this row be administered", and
 * every downstream decision leans on it: the scope's status machine, whether a
 * transient client is built, and whether the Add-host dialog announces a
 * machine as ready to run agents.
 *
 * It therefore has to agree with the layer that actually opens the socket. The
 * repository's canonical rule lives in `dialableHostEndpoint` /
 * `hostTransportKey`, and the case that separates them is a directory entry
 * that still carries a `websocketUrl` while its status has gone
 * `unavailable` — a stale address left behind by a host that went away.
 */

const HEALTHY: HostPresenceHealth = { status: "healthy", reason: null };

function entry(overrides: Partial<HostDirectoryEntry>): HostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "Host A",
    kind: "remote",
    websocketUrl: "wss://relay.example/host-a",
    version: "1.4.2",
    status: "available",
    ...overrides,
  };
}

function buildOne(input: {
  readonly entry: HostDirectoryEntry | null;
  readonly item: HostListItem | null;
  readonly localHostId: string | null;
  readonly remoteHostsPlanRestricted: boolean;
}): HostScopeOption {
  const [option] = buildHostScopeOptions({
    directory: input.entry === null ? [] : [input.entry],
    registry: input.item === null ? [] : [input.item],
    presenceHealth: HEALTHY,
    localHostId: input.localHostId,
    activeHostId: null,
    localService: undefined,
    hasLiveSession: () => false,
    viewerCheck: () => null,
    remoteHostsPlanRestricted: input.remoteHostsPlanRestricted,
    nowMs: 0,
  });
  return option;
}

function connectableFor(directoryEntry: HostDirectoryEntry): boolean {
  return buildOne({
    entry: directoryEntry,
    item: null,
    localHostId: null,
    remoteHostsPlanRestricted: false,
  }).connectable;
}

function registryItem(displayName: string | null): HostListItem {
  return {
    hostId: "host-a",
    displayName,
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      presenceLease: "fresh",
      hostRelayAttached: true,
      viewerReachability: "unknown",
      clientCloud: "ok",
      busy: false,
      busySessionCount: 0,
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  };
}

describe("buildHostScopeOptions connectable", () => {
  it("marks an available entry with a URL connectable", () => {
    expect(connectableFor(entry({}))).toBe(true);
  });

  it("refuses an unavailable entry even when it still carries a URL", () => {
    // The regression: URL-only said yes here, so the scope reached `ready` and
    // mounted host-RPC panels against a machine nothing could dial. The client
    // builder does not re-check status, so nothing downstream would have
    // caught it.
    expect(connectableFor(entry({ status: "unavailable" }))).toBe(false);
  });

  it("refuses an entry with no URL", () => {
    expect(connectableFor(entry({ websocketUrl: null }))).toBe(false);
  });

  it("agrees with the canonical transport rule on every combination", () => {
    // Pinned to the real helper rather than restated: if dialability changes,
    // this fails instead of quietly letting the two definitions drift.
    for (const status of ["available", "unavailable"] as const) {
      for (const websocketUrl of ["wss://relay.example/host-a", null]) {
        const candidate = entry({ status, websocketUrl });
        expect({
          status,
          websocketUrl,
          connectable: connectableFor(candidate),
        }).toEqual({
          status,
          websocketUrl,
          connectable: dialableHostEndpoint(candidate) !== null,
        });
      }
    }
  });

  it("refuses a remote route the account's plan does not include", () => {
    // The relay URL is present and `available`, but attaching is refused
    // server-side. The header and workspace pickers already disable these
    // rows; Settings classified the route as usable and mounted RPC panels
    // whose every call could only fail.
    expect(
      buildOne({
        entry: entry({ kind: "remote" }),
        item: null,
        localHostId: null,
        remoteHostsPlanRestricted: true,
      }).connectable,
    ).toBe(false);
  });

  it("does not let the remote plan gate touch this machine", () => {
    // The gate is about the relay, so a local host must stay administrable on
    // any plan — otherwise a free-plan user loses their own recovery surface.
    expect(
      buildOne({
        entry: entry({ hostId: "host-a", kind: "local" }),
        item: null,
        localHostId: "host-a",
        remoteHostsPlanRestricted: true,
      }).connectable,
    ).toBe(true);
  });
});

describe("buildHostScopeOptions planRestricted", () => {
  // `connectable: false` alone erased WHY, and consumers rendered a billing
  // limit as "unreachable" — sending people debugging their network when the
  // remedy is an upgrade. `planRestricted` is true exactly when the plan gate
  // is the ONLY thing costing the route.
  it("names the plan gate when it alone costs a live remote route", () => {
    const option = buildOne({
      entry: entry({ kind: "remote" }),
      item: null,
      localHostId: null,
      remoteHostsPlanRestricted: true,
    });
    expect(option.connectable).toBe(false);
    expect(option.planRestricted).toBe(true);
  });

  it("stays false for a genuinely unreachable route, restricted plan or not", () => {
    // No URL / stale status is connectivity, not billing: an upgrade would
    // not fix it, so the upgrade affordance must not appear.
    expect(
      buildOne({
        entry: entry({ kind: "remote", websocketUrl: null }),
        item: null,
        localHostId: null,
        remoteHostsPlanRestricted: true,
      }).planRestricted,
    ).toBe(false);
    expect(
      buildOne({
        entry: entry({ kind: "remote", status: "unavailable" }),
        item: null,
        localHostId: null,
        remoteHostsPlanRestricted: true,
      }).planRestricted,
    ).toBe(false);
  });

  it("stays false on a plan that includes remote hosts", () => {
    expect(
      buildOne({
        entry: entry({ kind: "remote" }),
        item: null,
        localHostId: null,
        remoteHostsPlanRestricted: false,
      }).planRestricted,
    ).toBe(false);
  });
});

describe("resolveScopedHost", () => {
  const PINNED = hostScopeOptionFixture({ hostId: "host-pinned" });
  const ACTIVE = hostScopeOptionFixture({ hostId: "host-active" });

  function resolve(input: {
    readonly hosts: readonly HostScopeOption[];
    readonly scopedHostId: string | null;
    readonly listsResolved: boolean;
    readonly listsFailed: boolean;
  }): {
    readonly hostId: string | null;
    readonly vanishedHostId: string | null;
  } {
    const result = resolveScopedHost({
      hosts: input.hosts,
      scopedHostId: input.scopedHostId,
      activeHostId: ACTIVE.hostId,
      listsResolved: input.listsResolved,
      listsFailed: input.listsFailed,
    });
    return {
      hostId: result.host?.hostId ?? null,
      vanishedHostId: result.vanishedHostId,
    };
  }

  it("withholds the vanished verdict when a host list failed", () => {
    // The fix-induced regression. Counting a rejection as "settled" is right
    // for leaving `connecting`, but wrong as evidence of ABSENCE: a directory
    // failure hides every directory-only host, so the pinned host is missing
    // from the union for a reason that has nothing to do with it. Claiming
    // `vanished` here tells someone their machine is no longer registered on
    // the strength of a request that never came back.
    expect(
      resolve({
        hosts: [ACTIVE],
        scopedHostId: PINNED.hostId,
        listsResolved: true,
        listsFailed: true,
      }),
    ).toEqual({ hostId: null, vanishedHostId: null });
  });

  it("still names a host that genuinely left a healthy list", () => {
    // The counterweight: suppressing the verdict on failure must not suppress
    // it when both lists answered cleanly, or deregistering a host would go
    // unreported and the surface would sit blank.
    expect(
      resolve({
        hosts: [ACTIVE],
        scopedHostId: PINNED.hostId,
        listsResolved: true,
        listsFailed: false,
      }),
    ).toEqual({ hostId: null, vanishedHostId: PINNED.hostId });
  });

  it("says nothing at all while the lists are still in flight", () => {
    expect(
      resolve({
        hosts: [],
        scopedHostId: PINNED.hostId,
        listsResolved: false,
        listsFailed: false,
      }),
    ).toEqual({ hostId: null, vanishedHostId: null });
  });

  it("never silently retargets a failed pick at the active host", () => {
    // The whole reason this resolution exists: a pick that cannot be honoured
    // resolves to NOTHING. Falling through to the active host would aim an
    // administration surface — and any destructive dialog on it — at a machine
    // the user never chose.
    for (const listsFailed of [true, false]) {
      expect(
        resolve({
          hosts: [ACTIVE],
          scopedHostId: PINNED.hostId,
          listsResolved: true,
          listsFailed,
        }).hostId,
      ).toBeNull();
    }
  });

  it("follows the active host when nothing was pinned", () => {
    expect(
      resolve({
        hosts: [ACTIVE, PINNED],
        scopedHostId: null,
        listsResolved: true,
        listsFailed: false,
      }),
    ).toEqual({ hostId: ACTIVE.hostId, vanishedHostId: null });
  });
});

describe("transientClientEntry", () => {
  it("withholds the entry for a non-connectable host, URL or not", () => {
    // The leak this closes: `buildTransientHostClient` checks only that a
    // websocketUrl exists, so handing it the entry of an unavailable or
    // plan-restricted row produced a live-looking client the status machine
    // had already ruled unreachable — and panels that read `scope.client`
    // before their gate renders fired real queries through it.
    const host = hostScopeOptionFixture({
      hostId: "host-a",
      connectable: false,
      entry: entry({ status: "unavailable" }),
    });
    expect(transientClientEntry(host, false)).toBeNull();
  });

  it("hands out the entry for a connectable non-followed host", () => {
    const directoryEntry = entry({});
    const host = hostScopeOptionFixture({
      hostId: "host-a",
      connectable: true,
      entry: directoryEntry,
    });
    expect(transientClientEntry(host, false)).toBe(directoryEntry);
  });

  it("builds nothing while following — the ambient client already exists", () => {
    const host = hostScopeOptionFixture({
      hostId: "host-a",
      connectable: true,
      entry: entry({}),
    });
    expect(transientClientEntry(host, true)).toBeNull();
  });

  it("builds nothing for no host at all", () => {
    expect(transientClientEntry(null, false)).toBeNull();
  });
});

describe("buildHostScopeOptions name resolution", () => {
  it("prefers this machine's fresh directory label over a stale registry name", () => {
    // Renaming the local host rewrites its directory label at once, while the
    // registry only catches up after a check-in and the ~15s poll. Preferring
    // the registry left the sidebar showing the old name for tens of seconds
    // after a rename the user had just watched succeed.
    expect(
      buildOne({
        entry: entry({ hostId: "host-a", kind: "local", label: "New Name" }),
        item: registryItem("Stale Registry Name"),
        localHostId: "host-a",
        remoteHostsPlanRestricted: false,
      }).name,
    ).toBe("New Name");
  });

  it("still prefers the registry name for a host that is not this machine", () => {
    // The registry display name is what "Edit name" writes for remote hosts,
    // so the exception must stay scoped to the local machine.
    expect(
      buildOne({
        entry: entry({ hostId: "host-a", label: "directory-label" }),
        item: registryItem("Deliberate Name"),
        localHostId: null,
        remoteHostsPlanRestricted: false,
      }).name,
    ).toBe("Deliberate Name");
  });

  it("falls back to the registry name for a local host that is down", () => {
    // While the local host is stopped the directory carries the registry
    // twin's label, so the local branch resolves to the registry name rather
    // than to nothing.
    expect(
      buildOne({
        entry: entry({ hostId: "host-a", kind: "local", label: "" }),
        item: registryItem("Registry Name"),
        localHostId: "host-a",
        remoteHostsPlanRestricted: false,
      }).name,
    ).toBe("Registry Name");
  });
});
