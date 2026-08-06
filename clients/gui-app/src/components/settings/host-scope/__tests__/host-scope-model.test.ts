import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostPresenceHealth } from "@traycer/protocol/host/host-status";
import { buildHostScopeOptions } from "@/components/settings/host-scope/host-scope-model";
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

function connectableFor(directoryEntry: HostDirectoryEntry): boolean {
  const [option] = buildHostScopeOptions({
    directory: [directoryEntry],
    registry: [],
    presenceHealth: HEALTHY,
    localHostId: null,
    activeHostId: null,
    localService: undefined,
    hasLiveSession: () => false,
    viewerCheck: () => null,
    nowMs: 0,
  });
  return option.connectable;
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
      connectableFor(entry({ status: "unavailable" })),
    ).toBe(false);
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
});
