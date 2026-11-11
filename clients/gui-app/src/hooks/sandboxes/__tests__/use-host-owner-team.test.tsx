import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { sandboxHostEntry } from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import type { LandingOwnerTeam } from "@/components/home/composer/landing-owner-model";
import { useLandingOwner } from "@/hooks/home/use-landing-owner";
import {
  useHostOwnerTeamId,
  useOnTeamSandbox,
} from "@/hooks/sandboxes/use-on-team-sandbox";
import { useAuthStore, type EpicShareableTeam } from "@/stores/auth/auth-store";

const HOST_ID = "physical-host";
const TEAM_ID = "team-a";
const TEAM_OWNER: HostOwnerPrincipal = {
  kind: "team",
  id: TEAM_ID,
  name: "Alpha",
};
const PERSONAL_OWNER: HostOwnerPrincipal = { kind: "user", id: "user-a" };
const SHAREABLE_TEAM: EpicShareableTeam = {
  teamId: TEAM_ID,
  slug: "alpha",
  avatarUrl: null,
};

interface OwnerProjection {
  readonly ownerTeamId: string | null;
  readonly landingOwner: LandingOwnerTeam | null;
  readonly onTeamSandbox: boolean;
}

function useOwnerProjection(hostId: string | null): OwnerProjection {
  return {
    ownerTeamId: useHostOwnerTeamId(hostId),
    landingOwner: useLandingOwner(hostId),
    onTeamSandbox: useOnTeamSandbox(hostId),
  };
}

function physicalHost(owner: HostOwnerPrincipal): RemoteHostDirectoryEntry {
  return {
    hostId: HOST_ID,
    label: "Physical host",
    kind: "remote",
    websocketUrl: "wss://relay.invalid/attach",
    version: "1.2.3",
    transportDialability: "dialable",
    publicKey: "physical-host-key",
    relayFuseGrace: false,
    owner,
    sandbox: null,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.2.3",
      lastSeenAt: null,
    },
  };
}

class PublishingHostDirectory {
  private rows: ReadonlyMap<string, HostDirectoryEntry>;
  private readonly listeners = new Set<() => void>();

  constructor(rows: ReadonlyArray<HostDirectoryEntry>) {
    this.rows = new Map(rows.map((row) => [row.hostId, row]));
  }

  findById(hostId: string): HostDirectoryEntry | null {
    return this.rows.get(hostId) ?? null;
  }

  onDirectoryChanged(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  publish(rows: ReadonlyArray<HostDirectoryEntry>): void {
    this.rows = new Map(rows.map((row) => [row.hostId, row]));
    for (const listener of [...this.listeners]) listener();
  }
}

function installPublishingDirectory(directory: PublishingHostDirectory): void {
  installHostConnectionRegistrySource({
    directory: {
      findById: (hostId) => directory.findById(hostId),
      onDirectoryChanged: (listener) => directory.onDirectoryChanged(listener),
    },
    leases: null,
  });
}

beforeEach(() => {
  useAuthStore.setState({ shareableTeams: [SHAREABLE_TEAM] });
});

afterEach(() => {
  cleanup();
  resetHostConnectionRegistryForTest();
  useAuthStore.setState({ shareableTeams: [] });
});

describe("team ownership from host directory rows", () => {
  it("resolves a physical team's owner without treating it as a team sandbox", () => {
    const directory = new PublishingHostDirectory([physicalHost(TEAM_OWNER)]);
    installPublishingDirectory(directory);

    const { result } = renderHook(() => useOwnerProjection(HOST_ID));

    expect(result.current).toEqual({
      ownerTeamId: TEAM_ID,
      landingOwner: { teamId: TEAM_ID, slug: "alpha" },
      onTeamSandbox: false,
    });
  });

  it("keeps a personal physical host personal", () => {
    const directory = new PublishingHostDirectory([
      physicalHost(PERSONAL_OWNER),
    ]);
    installPublishingDirectory(directory);

    const { result } = renderHook(() => useOwnerProjection(HOST_ID));

    expect(result.current).toEqual({
      ownerTeamId: null,
      landingOwner: null,
      onTeamSandbox: false,
    });
  });

  it("resolves a team sandbox as both team-owned and a team sandbox", () => {
    const directory = new PublishingHostDirectory([
      sandboxHostEntry(HOST_ID, { id: TEAM_ID, name: "Alpha" }),
    ]);
    installPublishingDirectory(directory);

    const { result } = renderHook(() => useOwnerProjection(HOST_ID));

    expect(result.current).toEqual({
      ownerTeamId: TEAM_ID,
      landingOwner: { teamId: TEAM_ID, slug: "alpha" },
      onTeamSandbox: true,
    });
  });

  it("reprojects ownership after the host row notification", () => {
    const directory = new PublishingHostDirectory([
      physicalHost(PERSONAL_OWNER),
    ]);
    installPublishingDirectory(directory);
    const { result } = renderHook(() => useOwnerProjection(HOST_ID));
    expect(result.current.ownerTeamId).toBeNull();
    expect(result.current.landingOwner).toBeNull();

    act(() => {
      directory.publish([physicalHost(TEAM_OWNER)]);
    });

    expect(result.current).toEqual({
      ownerTeamId: TEAM_ID,
      landingOwner: { teamId: TEAM_ID, slug: "alpha" },
      onTeamSandbox: false,
    });
  });

  it("returns no owner for an unresolved or local host", () => {
    const directory = new PublishingHostDirectory([mockLocalHostEntry]);
    installPublishingDirectory(directory);

    const { result: unknown } = renderHook(() => useOwnerProjection("missing"));
    const { result: local } = renderHook(() =>
      useOwnerProjection(mockLocalHostEntry.hostId),
    );

    expect(unknown.current).toEqual({
      ownerTeamId: null,
      landingOwner: null,
      onTeamSandbox: false,
    });
    expect(local.current).toEqual({
      ownerTeamId: null,
      landingOwner: null,
      onTeamSandbox: false,
    });
  });
});
