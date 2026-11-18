import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { useProvidersLoginOwnershipForClient } from "@/hooks/providers/use-providers-login-ownership";

/**
 * Failing-first coverage for
 * epics/368a3163-5475-4713-ad06-634f47cc913a/artifacts/v1-4-1-cherry-pick-list/login-cancel-ownership's
 * both-minor gate: ownership is safe only when the host negotiates BOTH
 * `providers.startLogin@1.4+` AND `providers.cancelLogin@1.2+` — a host that
 * upgraded only one half must still be treated as a released (non-owning)
 * host, since the GUI cannot tell "no cancel ownership" apart from
 * "this host doesn't understand a holder id" on the half it didn't upgrade.
 */

const HOST_ID = "host-under-test";

function fakeClient(hostId: string | null): HostClient<HostRpcRegistry> {
  return { getActiveHostId: () => hostId } as HostClient<HostRpcRegistry>;
}

function manifestWith(
  startMinor: number | null,
  cancelMinor: number | null,
): Record<string, { readonly major: number; readonly minor: number }> {
  const manifest: Record<
    string,
    { readonly major: number; readonly minor: number }
  > = {};
  if (startMinor !== null) {
    manifest["providers.startLogin"] = { major: 1, minor: startMinor };
  }
  if (cancelMinor !== null) {
    manifest["providers.cancelLogin"] = { major: 1, minor: cancelMinor };
  }
  return manifest;
}

/** A directory whose row for the host lands after the requester was made. */
class LateRowDirectory {
  private entry: HostDirectoryEntry | null = null;
  private readonly listeners = new Set<() => void>();

  findById(hostId: string): HostDirectoryEntry | null {
    return this.entry?.hostId === hostId ? this.entry : null;
  }

  onDirectoryChanged(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  publish(entry: HostDirectoryEntry): void {
    this.entry = entry;
    for (const listener of [...this.listeners]) listener();
  }
}

afterEach(() => {
  cleanup();
  resetHostConnectionRegistryForTest();
  resetNegotiatedManifests();
});

describe("useProvidersLoginOwnershipForClient — both-minor gate", () => {
  it("is true once the host negotiates both new minors", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWith(4, 2));

    const { result } = renderHook(() =>
      useProvidersLoginOwnershipForClient(fakeClient(HOST_ID)),
    );

    expect(result.current).toBe(true);
  });

  it("is false when only startLogin upgraded (cancelLogin still on the released minor)", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWith(4, 1));

    const { result } = renderHook(() =>
      useProvidersLoginOwnershipForClient(fakeClient(HOST_ID)),
    );

    expect(result.current).toBe(false);
  });

  it("is false when only cancelLogin upgraded (startLogin still on the released minor)", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWith(3, 2));

    const { result } = renderHook(() =>
      useProvidersLoginOwnershipForClient(fakeClient(HOST_ID)),
    );

    expect(result.current).toBe(false);
  });

  it("is false for a fully released 1.4.0/1.4.1-shaped host (neither minor upgraded)", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWith(3, 1));

    const { result } = renderHook(() =>
      useProvidersLoginOwnershipForClient(fakeClient(HOST_ID)),
    );

    expect(result.current).toBe(false);
  });

  // A requester pinned by host id answers `null` until that host's directory
  // row lands, and keeps its identity when it does. The compiled hook read the
  // id off the requester and kept the first answer, so a host whose row
  // arrived after the panel mounted never got login ownership.
  it("follows the requester's host once its directory row lands", () => {
    recordNegotiatedHostManifest(HOST_ID, manifestWith(4, 2));
    const directory = new LateRowDirectory();
    installHostConnectionRegistrySource({ directory, leases: null });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => {} },
      findHostById: (hostId) => directory.findById(hostId),
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {},
      }),
    });
    const pinnedRequester = spine.createRequesterForHostId(HOST_ID);
    const { result } = renderHook(() =>
      useProvidersLoginOwnershipForClient(pinnedRequester),
    );
    expect(result.current).toBe(false);

    act(() => {
      directory.publish({ ...mockLocalHostEntry, hostId: HOST_ID });
    });

    expect(result.current).toBe(true);
  });

  it("is false with no client, and false with no negotiated manifest yet", () => {
    const { result: noClient } = renderHook(() =>
      useProvidersLoginOwnershipForClient(null),
    );
    expect(noClient.current).toBe(false);

    const { result: unknownHost } = renderHook(() =>
      useProvidersLoginOwnershipForClient(fakeClient("host-never-negotiated")),
    );
    expect(unknownHost.current).toBe(false);
  });
});
