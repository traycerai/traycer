import { describe, expect, it } from "vitest";
import {
  isHostMaintenanceTargetPath,
  parseHostMaintenanceLeaseTarget,
} from "../host-maintenance-target";

describe("host maintenance lease target binding", () => {
  it("accepts the canonical staging slot and preserves its service uid", () => {
    expect(
      parseHostMaintenanceLeaseTarget(
        "/Users/alice/.traycer/host/staging",
        "501",
      ),
    ).toEqual({
      hostHomeDir: "/Users/alice/.traycer/host/staging",
      serviceUid: 501,
    });
  });

  it("uses the target platform path API instead of POSIX-only syntax", () => {
    expect(
      isHostMaintenanceTargetPath("C:\\Users\\alice\\.traycer\\host", "win32"),
    ).toBe(true);
    expect(
      isHostMaintenanceTargetPath("C:\\Users\\alice\\.traycer\\host", "linux"),
    ).toBe(false);
    expect(
      isHostMaintenanceTargetPath("/Users/alice/.traycer/host", "darwin"),
    ).toBe(true);
  });

  it("permits the no-getuid sentinel while rejecting malformed identities", () => {
    expect(
      parseHostMaintenanceLeaseTarget("/Users/alice/.traycer/host", "0"),
    ).toEqual({
      hostHomeDir: "/Users/alice/.traycer/host",
      serviceUid: 0,
    });
    expect(
      parseHostMaintenanceLeaseTarget(
        "/Users/alice/.traycer/host",
        "not-a-uid",
      ),
    ).toBeNull();
  });
});
