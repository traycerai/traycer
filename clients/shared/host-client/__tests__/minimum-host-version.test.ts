import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "../host-directory";
import type { RemoteHostDirectoryEntry } from "../remote-fetcher";
import { localEntry, remoteEntry } from "./routing-entry-fixtures";
import {
  hostDirectoryEntryNeedsUpdate,
  hostVersionNeedsUpdate,
} from "../minimum-host-version";

/**
 * Each case passes its own floor. The exported sentinel is not the assertion:
 * passing `"0.0.0"` as an argument checks the helper's admit-all arm.
 */

const FLOOR = "2.0.0";

function localAt(version: string): HostDirectoryEntry {
  return { ...localEntry, version };
}

function remoteAt(
  appVersion: string | null,
  version: string,
): RemoteHostDirectoryEntry {
  const base = remoteEntry("host-remote", null);
  return {
    ...base,
    version,
    remoteStatus: { ...base.remoteStatus, appVersion },
  };
}

describe("hostVersionNeedsUpdate", () => {
  it("asks for an update when the host is below the caller's floor", () => {
    expect(hostVersionNeedsUpdate("1.5.4", FLOOR)).toBe(true);
  });

  it("admits a host equal to or newer than the caller's floor", () => {
    expect(hostVersionNeedsUpdate("2.0.0", FLOOR)).toBe(false);
    expect(hostVersionNeedsUpdate("2.1.0", FLOOR)).toBe(false);
  });

  it("admits an unknown host version", () => {
    expect(hostVersionNeedsUpdate(null, FLOOR)).toBe(false);
    expect(hostVersionNeedsUpdate(undefined, FLOOR)).toBe(false);
  });

  it("admits every host when the caller passes the initial floor", () => {
    expect(hostVersionNeedsUpdate("1.5.4", "0.0.0")).toBe(false);
  });
});

describe("hostDirectoryEntryNeedsUpdate", () => {
  it("reads a remote row's app version, not the entry version", () => {
    expect(
      hostDirectoryEntryNeedsUpdate(remoteAt("1.5.4", "9.9.9"), FLOOR),
    ).toBe(true);
    expect(
      hostDirectoryEntryNeedsUpdate(remoteAt("2.0.0", "1.0.0"), FLOOR),
    ).toBe(false);
    expect(hostDirectoryEntryNeedsUpdate(remoteAt(null, "1.0.0"), FLOOR)).toBe(
      false,
    );
  });

  it("reads a local row's own version", () => {
    expect(hostDirectoryEntryNeedsUpdate(localAt("1.5.4"), FLOOR)).toBe(true);
    expect(hostDirectoryEntryNeedsUpdate(localAt("2.0.0"), FLOOR)).toBe(false);
  });
});
