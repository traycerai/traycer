import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  describeVersionSkew,
  hostAppVersionFromDirectoryEntry,
  hostIsBehindClient,
} from "@/lib/host/version-skew-copy";

const HOST_UPGRADE = {
  hostShouldUpgrade: true,
  clientShouldUpgrade: false,
};
const CLIENT_UPGRADE = {
  hostShouldUpgrade: false,
  clientShouldUpgrade: true,
};

describe("describeVersionSkew", () => {
  it("uses DTO appVersion comparison before upgradeGuidance", () => {
    expect(
      describeVersionSkew({
        hostAppVersion: "1.4.0",
        clientAppVersion: "1.5.0",
        guidance: CLIENT_UPGRADE,
      }),
    ).toEqual({
      title: "Host update needed",
      action: "Update now",
      direction: "host-outdated",
    });
    expect(
      describeVersionSkew({
        hostAppVersion: "1.6.0",
        clientAppVersion: "1.5.0",
        guidance: HOST_UPGRADE,
      }),
    ).toEqual({
      title: "Your app is too old",
      action: "Update the app",
      direction: "client-outdated",
    });
  });

  it("falls back to upgradeGuidance when a version comparison is unavailable", () => {
    expect(
      describeVersionSkew({
        hostAppVersion: null,
        clientAppVersion: "1.5.0",
        guidance: CLIENT_UPGRADE,
      }),
    ).toEqual({
      title: "Your app is too old",
      action: "Update the app",
      direction: "client-outdated",
    });
  });

  it("never returns the below-floor Update required copy or the old generic mismatch", () => {
    expect(
      describeVersionSkew({
        hostAppVersion: null,
        clientAppVersion: null,
        guidance: null,
      }),
    ).toEqual({
      title: "Host update needed",
      action: "Update now",
      direction: "host-outdated",
    });
  });
});

describe("hostAppVersionFromDirectoryEntry", () => {
  it("reads the remote status DTO appVersion before the base entry version", () => {
    const entry: RemoteHostDirectoryEntry = {
      hostId: "remote-1",
      label: "Remote",
      kind: "remote",
      websocketUrl: "wss://relay.traycer.invalid/attach",
      version: "1.0.0",
      transportDialability: "dialable",
      publicKey: "pk",
      relayFuseGrace: false,
      recentHostCheckIn: false,
      planAllowsRemote: true,
      remoteStatus: {
        connectivity: "connectable",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.4.2",
        lastSeenAt: null,
      },
    };

    expect(hostAppVersionFromDirectoryEntry(entry)).toBe("1.4.2");
  });

  it("reads local directory entry version", () => {
    const entry: HostDirectoryEntry = {
      hostId: "local-1",
      label: "Local",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:5001/rpc",
      version: "1.4.1",
      transportDialability: "dialable",
    };

    expect(hostAppVersionFromDirectoryEntry(entry)).toBe("1.4.1");
  });
});

/**
 * `hostIsBehindClient` exists separately from `describeVersionSkew` because
 * that function's job is to produce copy for a failure ALREADY attributed to
 * a skew - its fallback branch warns and defaults to host-update copy for
 * versions it cannot compare, which is the right behavior for a caller that
 * has already decided something is wrong, and the wrong one for a caller that
 * is merely wondering whether an update would help. A surface with no
 * handshake verdict (the chat tile's stalled-load pane) must get a plain
 * `false` on unparsable or missing versions, never a warning and an update
 * offer aimed at a host that may be perfectly current.
 */
describe("hostIsBehindClient", () => {
  it("is true when the host version is older than the client", () => {
    expect(
      hostIsBehindClient({
        hostAppVersion: "1.2.0",
        clientAppVersion: "1.3.0",
      }),
    ).toBe(true);
  });

  it("is false when the host version is newer than the client", () => {
    expect(
      hostIsBehindClient({
        hostAppVersion: "1.4.0",
        clientAppVersion: "1.3.0",
      }),
    ).toBe(false);
  });

  it("is false when the versions are equal", () => {
    expect(
      hostIsBehindClient({
        hostAppVersion: "1.3.0",
        clientAppVersion: "1.3.0",
      }),
    ).toBe(false);
  });

  it("is false when either version is null", () => {
    expect(
      hostIsBehindClient({ hostAppVersion: null, clientAppVersion: "1.3.0" }),
    ).toBe(false);
    expect(
      hostIsBehindClient({ hostAppVersion: "1.2.0", clientAppVersion: null }),
    ).toBe(false);
  });

  it("is false when a version string is unparseable", () => {
    expect(
      hostIsBehindClient({
        hostAppVersion: "not-a-version",
        clientAppVersion: "1.3.0",
      }),
    ).toBe(false);
  });
});
