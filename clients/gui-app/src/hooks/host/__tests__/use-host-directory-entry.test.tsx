import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";

/**
 * Minimal directory stub that reproduces the production churn: `findById`
 * allocates a FRESH entry object on every call (mirrors `toLocalEntry` + the
 * IPC-bridge copy), and `onChange` fires listeners on every emit. The current
 * fields live in `state`; `emit()` is a same-content re-emit (new object, no
 * field delta - the respawn-in-place / new-pid case), `update()` changes a
 * field.
 */
class ChurningDirectory<T extends HostDirectoryEntry = HostDirectoryEntry> {
  state: T;
  private readonly listeners = new Set<() => void>();

  constructor(entry: T) {
    this.state = entry;
  }

  onChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  findById(hostId: string): T | null {
    if (this.state.hostId !== hostId) return null;
    // Fresh object every read - the worst case the hook must absorb.
    return { ...this.state };
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }

  update(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }
}

const directoryRef = vi.hoisted(() => ({
  value: null as ChurningDirectory | null,
}));

vi.mock("@/lib/host", () => ({
  useHostDirectory: () => {
    if (directoryRef.value === null) {
      throw new Error("test directory not configured");
    }
    return directoryRef.value;
  },
}));

import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";

describe("useHostDirectoryEntry", () => {
  afterEach(() => {
    cleanup();
    directoryRef.value = null;
    vi.restoreAllMocks();
  });

  it("keeps the same reference across a field-identical re-emit (benign churn)", () => {
    const directory = new ChurningDirectory(mockLocalHostEntry);
    directoryRef.value = directory;
    const { result } = renderHook(() =>
      useHostDirectoryEntry(mockLocalHostEntry.hostId),
    );
    const first = result.current;
    expect(first).not.toBeNull();

    // The exact event the "Force host re-emit" button fires: a new entry
    // object with identical fields. Consumers must NOT see a new reference.
    act(() => directory.emit());
    expect(result.current).toBe(first);

    act(() => directory.emit());
    expect(result.current).toBe(first);
  });

  it("returns a new reference when a field genuinely changes", () => {
    const directory = new ChurningDirectory(mockLocalHostEntry);
    directoryRef.value = directory;
    const { result } = renderHook(() =>
      useHostDirectoryEntry(mockLocalHostEntry.hostId),
    );
    const first = result.current;

    act(() => directory.update({ websocketUrl: "ws://127.0.0.1:60001/rpc" }));
    expect(result.current).not.toBe(first);
    expect(result.current?.websocketUrl).toBe("ws://127.0.0.1:60001/rpc");
  });

  it("returns null (stably) when the host is absent", () => {
    const directory = new ChurningDirectory(mockLocalHostEntry);
    directoryRef.value = directory;
    const { result } = renderHook(() => useHostDirectoryEntry("missing"));
    expect(result.current).toBeNull();
    act(() => directory.emit());
    expect(result.current).toBeNull();
  });

  it("(R-1) returns a new reference when a remote host's public key rotates, even though every base field stays identical", () => {
    const remoteEntry: RemoteHostDirectoryEntry = {
      hostId: "remote-host-a",
      label: "Remote Host A",
      kind: "remote",
      websocketUrl: "wss://relay.test/attach",
      version: "1.2.3",
      status: "available",
      publicKey: "pubkey-a",
      remoteStatus: {
        presenceLease: "fresh",
        hostRelayAttached: true,
        viewerReachability: "ok",
        clientCloud: "ok",
        busy: false,
        busySessionCount: 0,
        updateState: "current",
        appVersion: null,
        lastSeenAt: null,
      },
    };
    const directory = new ChurningDirectory(remoteEntry);
    directoryRef.value = directory;
    const { result } = renderHook(() =>
      useHostDirectoryEntry(remoteEntry.hostId),
    );
    const first = result.current;
    expect(first).not.toBeNull();

    // hostId / label / kind / websocketUrl / version / status all held
    // stable - the base-field equality check alone would (wrongly) treat
    // this as benign churn and keep serving the stale key.
    act(() => directory.update({ publicKey: "pubkey-b" }));
    expect(result.current).not.toBe(first);
    expect(
      result.current !== null && "publicKey" in result.current
        ? result.current.publicKey
        : null,
    ).toBe("pubkey-b");
  });
});
