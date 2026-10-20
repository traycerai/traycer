import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  buildHostScopeOptions,
  resolveScopedHost,
  transientClientEntry,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import {
  hostLeaseFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
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

function entry(overrides: Partial<HostDirectoryEntry>): HostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "Host A",
    kind: "remote",
    websocketUrl: "wss://relay.example/host-a",
    version: "1.4.2",
    transportDialability: "dialable",
    ...overrides,
  };
}

function buildOne(input: {
  readonly entry: HostDirectoryEntry | null;
  readonly item: HostListItem | null;
  readonly localHostId: string | null;
}): HostScopeOption {
  const [option] = buildHostScopeOptions({
    leases: [],
    authorityAttached: false,
    directory: input.entry === null ? [] : [input.entry],
    registry: input.item === null ? [] : [input.item],
    localHostId: input.localHostId,
    activeHostId: null,
    localService: undefined,
    hasLiveSession: () => false,
    // The helper models one host at a time and none of these cases is about a
    // machine mid-install; the "setting up" row state has its own test.
    localHostSettingUp: false,
    sandboxes: null,
    nowMs: 0,
  });
  return option;
}

function connectableFor(directoryEntry: HostDirectoryEntry): boolean {
  return buildOne({
    entry: directoryEntry,
    item: null,
    localHostId: null,
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
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
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
    expect(
      connectableFor(entry({ transportDialability: "not-dialable" })),
    ).toBe(false);
  });

  it("refuses an entry with no URL", () => {
    expect(connectableFor(entry({ websocketUrl: null }))).toBe(false);
  });

  it("agrees with the canonical transport rule on every combination", () => {
    // Pinned to the real helper rather than restated: if dialability changes,
    // this fails instead of quietly letting the two definitions drift.
    for (const transportDialability of ["dialable", "not-dialable"] as const) {
      for (const websocketUrl of ["wss://relay.example/host-a", null]) {
        const candidate = entry({ transportDialability, websocketUrl });
        expect({
          transportDialability,
          websocketUrl,
          connectable: connectableFor(candidate),
        }).toEqual({
          transportDialability,
          websocketUrl,
          connectable: dialableHostEndpoint(candidate) !== null,
        });
      }
    }
  });

  it("keeps this machine's own host administrable", () => {
    // The relay never decides whether this machine's own host can be reached,
    // so a local host stays administrable whatever the cloud says about it.
    expect(
      buildOne({
        entry: entry({ hostId: "host-a", kind: "local" }),
        item: null,
        localHostId: "host-a",
      }).connectable,
    ).toBe(true);
  });
});

describe("buildHostScopeOptions connectable — the route, not the lease", () => {
  // `connectable` answers a ROUTE question and `health` answers a STATUS one.
  // A lease says what the authority concluded about a host; it never decides
  // whether this app has a route to it.
  it("takes connectable from the route alone, whatever the lease says", () => {
    const options = buildHostScopeOptions({
      directory: [entry({ hostId: "down" }), entry({ hostId: "healthy" })],
      registry: [],
      localHostId: null,
      activeHostId: null,
      localService: undefined,
      hasLiveSession: () => false,
      leases: [
        hostLeaseFixture("healthy", null),
        hostLeaseFixture("down", { reason: "offline" }),
      ],
      authorityAttached: true,
      localHostSettingUp: false,
      sandboxes: null,
      nowMs: 0,
    });
    const byId = new Map(options.map((option) => [option.hostId, option]));

    expect(byId.get("down")?.connectable).toBe(true);
    expect(byId.get("down")?.health.state).toBe("offline");
    expect(byId.get("healthy")?.connectable).toBe(true);
    expect(byId.get("healthy")?.health.state).toBe("online");
  });
});

describe("buildHostScopeOptions connectable — composed against real mapped entries", () => {
  // `entry()` above and `buildOne`'s hard-coded `hasLiveSession: () => false`
  // build synthetic literals with no `remoteStatus`. This composes the REAL
  // mapper output instead, so the route decision sees exactly the entry the
  // directory would hand it, and varies `hasLiveSession` to prove which cases
  // a ready session changes.
  function mappedItem(
    displayName: string,
    connectivity: HostConnectivity,
  ): HostListItem {
    return {
      hostId: "host-a",
      displayName,
      platform: "darwin-arm64",
      kind: "personal",
      publicKey: "pk-a",
      createdAt: "2026-01-01T00:00:00Z",
      updatePolicy: "manual",
      status: {
        connectivity,
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.4.2",
        lastSeenAt: "2026-01-01T00:00:00Z",
      },
    };
  }

  function buildMapped(
    item: HostListItem,
    hasLiveSession: boolean,
  ): HostScopeOption {
    const [option] = buildHostScopeOptions({
      leases: [],
      authorityAttached: false,
      directory: [
        hostListItemToDirectoryEntry(item, "wss://relay.example.test/attach"),
      ],
      registry: [item],
      localHostId: null,
      activeHostId: null,
      localService: undefined,
      hasLiveSession: () => hasLiveSession,
      localHostSettingUp: false,
      sandboxes: null,
      nowMs: 0,
    });
    return option;
  }

  it("is connectable for a host the cloud reports connectable, with or without a session", () => {
    const connectable = mappedItem("Desktop", "connectable");
    expect(buildMapped(connectable, false).connectable).toBe(true);
    expect(buildMapped(connectable, true).connectable).toBe(true);
  });

  it("is NOT connectable for a host the cloud reports OFFLINE, and reads Offline", () => {
    const option = buildMapped(mappedItem("Laptop", "offline"), false);
    expect(option.connectable).toBe(false);
    expect(option.health.state).toBe("offline");
  });

  it("keeps a host the cloud could not read dialable, and reads it as Status unknown", () => {
    // A blind liveness read is not a refusal: the transport tries, and the
    // row claims nothing about the machine. The retired `local-only` wire
    // value is the same absence of an answer and reads identically.
    for (const connectivity of ["unknown", "local-only"] as const) {
      const option = buildMapped(mappedItem("Blind", connectivity), false);
      expect({
        connectivity,
        connectable: option.connectable,
        state: option.health.state,
        label: option.health.label,
      }).toEqual({
        connectivity,
        connectable: true,
        state: "unknown",
        label: "Status unknown",
      });
    }
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
    // Panels read `scope.client` before their gate renders, so withholding an
    // unavailable row here prevents them mounting a client for a target the
    // scope has already ruled not administrable.
    const host = hostScopeOptionFixture({
      hostId: "host-a",
      connectable: false,
      entry: entry({ transportDialability: "not-dialable" }),
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
  it("prefers the registry name for THIS MACHINE too, with no local exception", () => {
    // The local-machine special case is gone, and this pins its absence.
    //
    // It existed because a rename wrote a local file the registry never learned
    // about — the registry name went stale for good, so the fresher directory
    // label was the only honest answer for this computer. The heartbeat now
    // publishes the host's `effectiveName` and authn writes it to
    // `displayName`, so the registry is kept fresh for every host and the two
    // sources agree. Re-adding the exception would reintroduce a way for them
    // not to, and this list is the UNREACHABLE-host answer: a reachable host is
    // named by `host.identity.get` at the panel, one layer up.
    expect(
      buildOne({
        entry: entry({ hostId: "host-a", kind: "local", label: "Old Label" }),
        item: registryItem("Registry Name"),
        localHostId: "host-a",
      }).name,
    ).toBe("Registry Name");
  });

  it("still prefers the registry name for a host that is not this machine", () => {
    expect(
      buildOne({
        entry: entry({ hostId: "host-a", label: "directory-label" }),
        item: registryItem("Deliberate Name"),
        localHostId: null,
      }).name,
    ).toBe("Deliberate Name");
  });

  it("falls back to the directory label when the registry has no name", () => {
    // The rung below: a directory-only host, or a registry row whose
    // `displayName` is empty, must still render something a person recognizes.
    expect(
      buildOne({
        entry: entry({ hostId: "host-a", label: "directory-label" }),
        item: registryItem(null),
        localHostId: "host-a",
      }).name,
    ).toBe("directory-label");
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
      }).name,
    ).toBe("Registry Name");
  });
});

describe("buildHostScopeOptions settingUp", () => {
  // M5's host-scope narration. The mutation lane belongs to the LOCAL host
  // controller, so it says nothing about any other machine — a fleet-wide
  // "setting up" would tell a user their colleague's laptop was mid-install.
  // Derived here rather than read per row: a runner-host read inside the row
  // component sits below the boundary every picker suite mocks.
  it("marks only THIS machine's row while the local mutation lane is busy", () => {
    const options = buildHostScopeOptions({
      leases: [],
      authorityAttached: false,
      directory: [
        entry({ hostId: "local-host", kind: "local" }),
        entry({ hostId: "remote-host", kind: "remote" }),
      ],
      registry: [],
      localHostId: "local-host",
      activeHostId: null,
      localService: undefined,
      hasLiveSession: () => false,
      localHostSettingUp: true,
      sandboxes: null,
      nowMs: 0,
    });

    const local = options.find((o) => o.hostId === "local-host");
    const remote = options.find((o) => o.hostId === "remote-host");
    expect(local?.settingUp).toBe(true);
    expect(remote?.settingUp).toBe(false);
  });

  it("marks nothing when the lane is idle", () => {
    const options = buildHostScopeOptions({
      leases: [],
      authorityAttached: false,
      directory: [entry({ hostId: "local-host", kind: "local" })],
      registry: [],
      localHostId: "local-host",
      activeHostId: null,
      localService: undefined,
      hasLiveSession: () => false,
      localHostSettingUp: false,
      sandboxes: null,
      nowMs: 0,
    });

    expect(options[0]?.settingUp).toBe(false);
  });
});

describe("buildHostScopeOptions health — leases are looked up PER HOST", () => {
  /**
   * The P12 pin, at the layer that does the lookup.
   *
   * Sealed probe P12 degraded `useHostLease`'s `find(hostId)` to `leases[0]`
   * and SURVIVED, because every suite seeded exactly one lease — so a
   * wrong-host answer and a right one produced identical output. The builder
   * does the same lookup for every row, so it inherits the same blind spot
   * unless a test arranges two hosts whose verdicts DIFFER.
   *
   * Both directions are asserted. Checking only the first row would pass under
   * `leases[0]`; checking only the second would pass under `leases[1]`.
   */
  it("gives each row its own lease, not the first one in the array", () => {
    const options = buildHostScopeOptions({
      leases: [
        hostLeaseFixture("host-b", { reason: "offline" }),
        hostLeaseFixture("host-a", null),
      ],
      authorityAttached: true,
      directory: [
        entry({ hostId: "host-a", label: "Host A" }),
        entry({ hostId: "host-b", label: "Host B" }),
      ],
      registry: [],
      localHostId: null,
      activeHostId: null,
      localService: undefined,
      hasLiveSession: () => false,
      localHostSettingUp: false,
      sandboxes: null,
      nowMs: 0,
    });

    const a = options.find((o) => o.hostId === "host-a");
    const b = options.find((o) => o.hostId === "host-b");
    expect(a?.health.state).toBe("online");
    expect(b?.health.state).toBe("offline");
    // The words a person reads, not just the internal states.
    expect(a?.health.label).toBe("Online");
    expect(b?.health.label).toBe("Offline");
  });

  /**
   * The fail-closed guard, at the builder rather than at the derivation.
   *
   * Before the authority attaches, EVERY host has no lease. If that read as
   * evidence, opening Settings during bootstrap would show an account's whole
   * fleet as dead — including in the picker a person would use to fix it.
   */
  it("does not manufacture a verdict for any row while the authority is unattached", () => {
    const options = buildHostScopeOptions({
      leases: [],
      authorityAttached: false,
      directory: [
        entry({ hostId: "host-a", label: "Host A" }),
        entry({ hostId: "host-b", label: "Host B" }),
      ],
      registry: [],
      localHostId: null,
      activeHostId: null,
      localService: undefined,
      hasLiveSession: () => false,
      localHostSettingUp: false,
      sandboxes: null,
      nowMs: 0,
    });

    for (const option of options) {
      expect(option.health.state).not.toBe("offline");
      expect(option.health.state).not.toBe("removed");
    }
  });
});
