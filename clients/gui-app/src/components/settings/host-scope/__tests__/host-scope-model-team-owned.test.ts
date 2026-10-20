import { describe, expect, it } from "vitest";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  buildHostScopeOptions,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";

/**
 * A sandbox option says whether a team owns it (`teamOwned`), the
 * fact the wake confirm reads. The registry row's `owner` answers first; a
 * row the registry has not answered for falls back to its directory entry's
 * copy (`ownerTeamName`).
 */

const TEAM: HostOwnerPrincipal = { kind: "team", id: "team-a", name: "Alpha" };
const ME: HostOwnerPrincipal = { kind: "user", id: "user-me" };

function item(
  hostId: string,
  kind: HostListItem["kind"],
  owner: HostOwnerPrincipal | undefined,
): HostListItem {
  const base: HostListItem = {
    hostId,
    displayName: hostId,
    platform: "linux",
    kind,
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
    ...(kind === "sandbox" ? { sandboxState: "stopped" as const } : {}),
  };
  return owner === undefined ? base : { ...base, owner };
}

function build(input: {
  readonly registry: readonly HostListItem[];
  readonly directory: readonly HostListItem[];
}): ReadonlyMap<string, HostScopeOption> {
  const options = buildHostScopeOptions({
    leases: [],
    authorityAttached: false,
    directory: input.directory.map((row) =>
      hostListItemToDirectoryEntry(row, "wss://relay.example.test"),
    ),
    registry: input.registry,
    localHostId: null,
    activeHostId: null,
    localService: undefined,
    hasLiveSession: () => false,
    localHostSettingUp: false,
    sandboxes: null,
    nowMs: 0,
  });
  return new Map(options.map((option) => [option.hostId, option]));
}

describe("buildHostScopeOptions teamOwned", () => {
  it("is true for a sandbox whose registry row names a team owner", () => {
    const row = item("sbx", "sandbox", TEAM);
    const option = build({ registry: [row], directory: [row] }).get("sbx");
    expect(option?.sandbox?.teamOwned).toBe(true);
  });

  it("is false for a sandbox the person owns, and for one the registry sent without an owner", () => {
    const own = item("sbx-own", "sandbox", ME);
    const bare = item("sbx-bare", "sandbox", undefined);
    const options = build({
      registry: [own, bare],
      directory: [own, bare],
    });
    expect(options.get("sbx-own")?.sandbox?.teamOwned).toBe(false);
    expect(options.get("sbx-bare")?.sandbox?.teamOwned).toBe(false);
  });

  it("is true for a directory-only row whose entry names a team (no registry row at all)", () => {
    const row = item("sbx-dir", "sandbox", TEAM);
    const option = build({ registry: [], directory: [row] }).get("sbx-dir");
    expect(option?.item).toBeNull();
    expect(option?.sandbox?.teamOwned).toBe(true);
  });

  it("is false for a directory-only row whose entry names no team", () => {
    const row = item("sbx-dir", "sandbox", ME);
    const option = build({ registry: [], directory: [row] }).get("sbx-dir");
    expect(option?.item).toBeNull();
    expect(option?.sandbox?.teamOwned).toBe(false);
  });

  it("is true when the registry row names no owner but the directory entry names a team", () => {
    const registryRow = item("sbx", "sandbox", undefined);
    const entryRow = item("sbx", "sandbox", TEAM);
    const option = build({
      registry: [registryRow],
      directory: [entryRow],
    }).get("sbx");
    expect(option?.item?.owner).toBeUndefined();
    expect(option?.sandbox?.teamOwned).toBe(true);
  });

  it("leaves a team-owned personal host with no sandbox facts at all", () => {
    const row = item("host-p", "personal", TEAM);
    const option = build({ registry: [row], directory: [row] }).get("host-p");
    expect(option?.sandbox).toBeNull();
  });
});
