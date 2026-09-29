import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Minimal directory stub for `useHostBinding()?.directory`: only the two
 * members `useAccountActivityCoverage` reads, `knownHostIds()` and
 * `onChange()`. Mirrors the pattern `use-host-directory-entry.test.tsx` uses
 * for `useHostDirectory` - a hand-written double rather than the real
 * `HostDirectoryService`, since the hook only ever touches this seam.
 */
class FakeAccountDirectory {
  private hostIds: readonly string[] | null;
  private readonly listeners = new Set<() => void>();

  constructor(hostIds: readonly string[] | null) {
    this.hostIds = hostIds;
  }

  knownHostIds(): readonly string[] | null {
    return this.hostIds;
  }

  onChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Settles the fleet with a host list, firing every subscriber. */
  settle(hostIds: readonly string[]): void {
    this.hostIds = hostIds;
    for (const listener of this.listeners) listener();
  }
}

const directoryRef = vi.hoisted((): { value: FakeAccountDirectory | null } => ({
  value: null,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () =>
    directoryRef.value === null ? null : { directory: directoryRef.value },
}));

import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
} from "@/stores/agent-activity-store";
import { useAccountActivityCoverage } from "@/hooks/agent/use-account-activity-coverage";

const HOST_A = "host-a";

describe("useAccountActivityCoverage", () => {
  afterEach(() => {
    cleanup();
    directoryRef.value = null;
    __resetAgentActivityStoreForTests();
  });

  it("reads indeterminate with no binding at all - a shell before its runtime resolves, or an unmounted host", () => {
    const { result } = renderHook(() => useAccountActivityCoverage());
    expect(result.current).toBe("indeterminate");
  });

  it("moves from indeterminate to covered when the directory settles, pinning the onChange subscription", () => {
    // A narrow (non-fleet-spanning) plane that covers its own host - the
    // discriminating input, since it answers `indeterminate` until the
    // directory names HOST_A as known, then `covered` once it does.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: true,
    });
    const directory = new FakeAccountDirectory(null);
    directoryRef.value = directory;

    const { result } = renderHook(() => useAccountActivityCoverage());
    expect(result.current).toBe("indeterminate");

    act(() => {
      directory.settle([HOST_A]);
    });

    expect(result.current).toBe("covered");
  });
});
