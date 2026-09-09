import { describe, expect, it } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostRpcRegistry } from "@/lib/host";
import {
  composerHostLabel,
  resolveLandingPlacement,
  type LandingPlacementTarget,
} from "@/lib/composer/landing-placement";

/**
 * Submit-time re-validation for the landing composer (redesign P1.2,
 * selection model §54): "submit re-validates the resolved host is usable
 * (refuse with an inline error, never create on a silently different host)".
 *
 * The property under test is the second clause. Before P1.2 the composer's
 * picker moved the app-wide selection, so "the host the chip shows" and "the
 * host the create lands on" were the same thing by construction. Now they are
 * two values, and this is the gate that refuses to let them differ.
 */

/**
 * A client is only ever asked for its host IDENTITY here, so the fake answers
 * exactly that. Built through a typed factory rather than a cast: the ban on
 * `as any` / `as unknown` applies in tests too.
 */
function clientAddressing(
  hostId: string,
  websocketUrl: string | null = "ws://127.0.0.1:4917/rpc",
): HostClient<HostRpcRegistry> {
  const activeHost: HostDirectoryEntry = {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl,
    version: "0.0.0-test",
    transportDialability: websocketUrl === null ? "not-dialable" : "dialable",
  };
  const client: Pick<
    HostClient<HostRpcRegistry>,
    "getActiveHost" | "getActiveHostId"
  > = {
    getActiveHost: () => activeHost,
    getActiveHostId: () => hostId,
  };
  return client as HostClient<HostRpcRegistry>;
}

function remoteClientAddressing(
  overrides: Partial<RemoteHostDirectoryEntry>,
): HostClient<HostRpcRegistry> {
  const activeHost: RemoteHostDirectoryEntry = {
    hostId: "host-a",
    label: "Remote Mac",
    kind: "remote",
    websocketUrl: "wss://relay.test/attach",
    version: "0.0.0-test",
    transportDialability: "not-dialable",
    publicKey: "public-key",
    relayFuseGrace: false,
    recentHostCheckIn: false,
    planAllowsRemote: true,
    remoteStatus: {
      connectivity: "offline",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    ...overrides,
  };
  const client: Pick<
    HostClient<HostRpcRegistry>,
    "getActiveHost" | "getActiveHostId"
  > = {
    getActiveHost: () => activeHost,
    getActiveHostId: () => activeHost.hostId,
  };
  return client as HostClient<HostRpcRegistry>;
}

function targetWith(
  overrides: Partial<LandingPlacementTarget>,
): LandingPlacementTarget {
  return {
    resolvedHostId: "host-a",
    client: clientAddressing("host-a"),
    hostLabel: "Studio Mac",
    isPinned: false,
    namedHostDead: false,
    ...overrides,
  };
}

describe("resolveLandingPlacement", () => {
  it("is ready when the resolved host is exactly what the client addresses", () => {
    const client = clientAddressing("host-a");
    const placement = resolveLandingPlacement(targetWith({ client }));
    expect(placement).toEqual({
      kind: "ready",
      hostId: "host-a",
      client,
    });
  });

  it("is ready for a pin whose own requester addresses the pinned host", () => {
    const client = clientAddressing("host-b");
    const placement = resolveLandingPlacement(
      targetWith({ resolvedHostId: "host-b", client, isPinned: true }),
    );
    expect(placement.kind).toBe("ready");
  });

  it("refuses when nothing is resolvable (∅)", () => {
    const placement = resolveLandingPlacement(
      targetWith({ resolvedHostId: null, client: null }),
    );
    expect(placement.kind).toBe("refused");
    expect(placement.kind === "refused" ? placement.message : "").toContain(
      "No device is available",
    );
  });

  // `namedHostDead` is ONLY ever set for a caller-NAMED host (the row-scoped
  // modal's `overrideHostId`) - never for a pin. Naming a device IS the
  // request, so a dead one is refused rather than silently substituted.
  it("refuses a named (override) host that is dead, and names it", () => {
    const placement = resolveLandingPlacement(
      targetWith({
        isPinned: true,
        namedHostDead: true,
        hostLabel: "Build Box",
      }),
    );
    expect(placement.kind).toBe("refused");
    expect(placement.kind === "refused" ? placement.message : "").toContain(
      "Build Box is offline",
    );
  });

  it("refuses when the resolved host has no client to send on", () => {
    const placement = resolveLandingPlacement(targetWith({ client: null }));
    expect(placement.kind).toBe("refused");
    expect(placement.kind === "refused" ? placement.message : "").toContain(
      "Studio Mac",
    );
  });

  it("refuses with starting copy while the resolved host has no RPC endpoint", () => {
    const placement = resolveLandingPlacement(
      targetWith({ client: clientAddressing("host-a", null) }),
    );
    expect(placement).toEqual({
      kind: "refused",
      message: "Studio Mac is starting. Wait for it to come up and send again.",
    });
  });

  it("refuses a relay-addressed remote host with a confirmed offline verdict", () => {
    const placement = resolveLandingPlacement(
      targetWith({ client: remoteClientAddressing({}) }),
    );
    expect(placement).toEqual({
      kind: "refused",
      message: "Studio Mac is offline. Wait for it to come up and send again.",
    });
  });

  it("refuses a relay-addressed remote host restricted by the current plan", () => {
    const placement = resolveLandingPlacement(
      targetWith({
        client: remoteClientAddressing({
          planAllowsRemote: false,
          remoteStatus: {
            connectivity: "connectable",
            viewerReachability: "ok",
            clientCloud: "ok",
            updateState: "current",
            appVersion: null,
            lastSeenAt: null,
          },
        }),
      }),
    );
    expect(placement).toEqual({
      kind: "refused",
      message: "Studio Mac isn't available on your plan.",
    });
  });

  // The defect this whole row exists to prevent: the chip says one machine,
  // the client would send to another. Refusing is the ONLY correct answer -
  // proceeding would place the epic (for life) on a host the user never saw.
  it("refuses rather than creating on a host the chip never showed", () => {
    const placement = resolveLandingPlacement(
      targetWith({
        resolvedHostId: "host-b",
        client: clientAddressing("host-a"),
        isPinned: true,
        hostLabel: "Build Box",
      }),
    );
    expect(placement.kind).toBe("refused");
  });

  // A following composer takes the same arm: the authority can name the new
  // effective host before the directory row that makes it dialable arrives,
  // and the app-wide client is still on the old one in that window.
  it("refuses a following composer mid-switch, before the client rebinds", () => {
    const placement = resolveLandingPlacement(
      targetWith({
        resolvedHostId: "host-next",
        client: clientAddressing("host-previous"),
        isPinned: false,
      }),
    );
    expect(placement.kind).toBe("refused");
  });

  // D6: a pin is never blocked by the `namedHostDead` arm. A pinned host that
  // dies has already auto-followed to `effective` by the time this runs -
  // `resolvedHostId` names the live host, `namedHostDead` stays false, and a
  // good client for it resolves ready, exactly like an unpinned target.
  it("does not refuse a pinned target through the namedHostDead arm", () => {
    const client = clientAddressing("host-a");
    const placement = resolveLandingPlacement(
      targetWith({ isPinned: true, namedHostDead: false, client }),
    );
    expect(placement.kind).toBe("ready");
  });
});

describe("composerHostLabel", () => {
  const entries: ReadonlyArray<HostDirectoryEntry> = [
    {
      hostId: "host-a",
      label: "Studio Mac",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-test",
      transportDialability: "dialable",
    },
  ];

  it("names a listed host", () => {
    expect(composerHostLabel(entries, "host-a")).toBe("Studio Mac");
  });

  it("never leaks a raw host id for an unlisted host", () => {
    expect(composerHostLabel(entries, "host-unknown")).toBe(
      "The selected device",
    );
    expect(composerHostLabel(null, "host-a")).toBe("The selected device");
  });

  it("has copy for the ∅ case", () => {
    expect(composerHostLabel(entries, null)).toBe("This device");
  });
});
