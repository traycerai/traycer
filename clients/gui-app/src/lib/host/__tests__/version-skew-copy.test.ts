import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  describeVersionSkew,
  hostAppVersionFromDirectoryEntry,
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
      status: "available",
      publicKey: "pk",
      remoteStatus: {
        presenceLease: "fresh",
        hostRelayAttached: true,
        viewerReachability: "unknown",
        clientCloud: "ok",
        busy: false,
        busySessionCount: 0,
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
      status: "available",
    };

    expect(hostAppVersionFromDirectoryEntry(entry)).toBe("1.4.1");
  });
});
