import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";

/**
 * `useHostCredentialRefusal` is the single gate every credential control reads
 * (sign-in, provider key, env override, synced profile, MCP auth): the line
 * when the target host is a sandbox, `null` otherwise.
 */

class FakeDirectory {
  private readonly entries = new Map<string, HostDirectoryEntry>();
  private readonly listeners = new Set<() => void>();

  set(entry: HostDirectoryEntry): void {
    this.entries.set(entry.hostId, entry);
    for (const listener of this.listeners) listener();
  }

  findById(hostId: string): HostDirectoryEntry | null {
    return this.entries.get(hostId) ?? null;
  }

  onChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}

const world = vi.hoisted(() => ({
  directory: null as FakeDirectory | null,
  /** `useHostBinding()`'s answer; `null` is no host runtime at all. */
  bound: true,
  addressableHostId: null as string | null,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () =>
    world.bound && world.directory !== null
      ? { directory: world.directory }
      : null,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => world.addressableHostId,
}));

import { useHostCredentialRefusal } from "@/hooks/host/use-host-credential-refusal";

const REFUSAL = "Sandboxes don't take sign-ins";

function remote(
  hostId: string,
  kind: "personal" | "sandbox",
): HostDirectoryEntry {
  const item: HostListItem = {
    hostId,
    displayName: hostId,
    platform: "linux",
    kind,
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: null,
    },
    ...(kind === "sandbox"
      ? {
          sandboxState: "awake" as const,
          sandboxFrozen: false,
          profile: "agent" as const,
        }
      : {}),
  };
  return hostListItemToDirectoryEntry(item, "wss://relay.example.test");
}

beforeEach(() => {
  world.directory = new FakeDirectory();
  world.bound = true;
  world.addressableHostId = null;
});
afterEach(() => {
  cleanup();
  world.directory = null;
});

describe("useHostCredentialRefusal", () => {
  it("refuses a sandbox host named by id", () => {
    world.directory?.set(remote("sbx-1", "sandbox"));
    const { result } = renderHook(() => useHostCredentialRefusal("sbx-1"));
    expect(result.current).toBe(REFUSAL);
  });

  it("refuses nothing for a personal remote host or this machine's own host", () => {
    world.directory?.set(remote("laptop", "personal"));
    world.directory?.set(mockLocalHostEntry);
    expect(
      renderHook(() => useHostCredentialRefusal("laptop")).result.current,
    ).toBeNull();
    expect(
      renderHook(() => useHostCredentialRefusal(mockLocalHostEntry.hostId))
        .result.current,
    ).toBeNull();
  });

  it("resolves a null host id to the surface's own host (the binding's addressable host)", () => {
    world.directory?.set(remote("sbx-1", "sandbox"));
    world.directory?.set(remote("laptop", "personal"));

    world.addressableHostId = "sbx-1";
    expect(
      renderHook(() => useHostCredentialRefusal(null)).result.current,
    ).toBe(REFUSAL);

    world.addressableHostId = "laptop";
    expect(
      renderHook(() => useHostCredentialRefusal(null)).result.current,
    ).toBeNull();
  });

  it("prefers an explicit host id over the surface's own host", () => {
    world.directory?.set(remote("sbx-1", "sandbox"));
    world.directory?.set(remote("laptop", "personal"));
    world.addressableHostId = "laptop";

    expect(
      renderHook(() => useHostCredentialRefusal("sbx-1")).result.current,
    ).toBe(REFUSAL);
  });

  it("refuses nothing when no host can be resolved, or the directory has no row for it", () => {
    world.addressableHostId = null;
    expect(
      renderHook(() => useHostCredentialRefusal(null)).result.current,
    ).toBeNull();
    expect(
      renderHook(() => useHostCredentialRefusal("not-listed")).result.current,
    ).toBeNull();
  });

  it("answers null with no host binding at all, even for an id that would be a sandbox", () => {
    world.directory?.set(remote("sbx-1", "sandbox"));
    world.bound = false;
    expect(
      renderHook(() => useHostCredentialRefusal("sbx-1")).result.current,
    ).toBeNull();
  });

  it("follows the directory: a host that turns out to be a sandbox flips the answer, and back", () => {
    world.directory?.set(remote("host-x", "personal"));
    const { result } = renderHook(() => useHostCredentialRefusal("host-x"));
    expect(result.current).toBeNull();

    act(() => world.directory?.set(remote("host-x", "sandbox")));
    expect(result.current).toBe(REFUSAL);

    act(() => world.directory?.set(remote("host-x", "personal")));
    expect(result.current).toBeNull();
  });
});
