import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MINIMUM_HOST_VERSION } from "@traycer-clients/shared/host-client/minimum-host-version";
import {
  fakeDurableStreamTransports,
  resetFakeDurableStreamTransports,
} from "@/lib/host/test-support/fake-durable-stream-transport";
import { remoteAwareOwnerIdentity } from "@/lib/host/transport-key";
import {
  hasSimulatorSessionsCoordinator,
  resetSimulatorSessionsCoordinatorsForTests,
  simulatorSessionsCoordinatorKey,
} from "@/lib/simulator-view/simulator-sessions-coordinator";
import { useSimulatorSessionsForHost } from "@/lib/simulator-view/use-simulator-sessions";

vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return { ...actual, MINIMUM_HOST_VERSION: "2.0.0" };
  },
);

const HOST_ID = "host-1";
const EPIC_ID = "epic-1";
const USER_ID = "user-1";
const AT_FLOOR_ROW: HostDirectoryEntry = {
  hostId: HOST_ID,
  label: "Host",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: MINIMUM_HOST_VERSION,
  transportDialability: "dialable",
};

const rowRef = vi.hoisted(() => ({
  current: null as HostDirectoryEntry | null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => rowRef.current,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({}),
}));
vi.mock("@/hooks/host/use-request-context-user-id", () => ({
  useRequestContextUserId: () => USER_ID,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => null,
}));
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => fakeDurableStreamTransports().opener,
}));

const OWNER_KEY = simulatorSessionsCoordinatorKey({
  hostId: HOST_ID,
  epicId: EPIC_ID,
  identityKey: remoteAwareOwnerIdentity(AT_FLOOR_ROW, USER_ID),
});

describe("useSimulatorSessionsForHost below the version floor", () => {
  beforeEach(() => {
    resetFakeDurableStreamTransports();
    rowRef.current = AT_FLOOR_ROW;
  });

  afterEach(() => {
    cleanup();
    resetSimulatorSessionsCoordinatorsForTests();
  });

  it("releases a held coordinator when its host falls below the floor", () => {
    const { rerender } = renderHook(() =>
      useSimulatorSessionsForHost({ hostId: HOST_ID, epicId: EPIC_ID }),
    );
    const { records } = fakeDurableStreamTransports();
    // A host exactly at the floor may own the stream.
    expect(records).toHaveLength(1);

    act(() => {
      rowRef.current = { ...AT_FLOOR_ROW, version: "1.9.0" };
      rerender();
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.closeCount).toBe(1);
    expect(hasSimulatorSessionsCoordinator(OWNER_KEY)).toBe(false);
  });

  it("keeps a held coordinator while an at-floor host has no endpoint", () => {
    const { rerender } = renderHook(() =>
      useSimulatorSessionsForHost({ hostId: HOST_ID, epicId: EPIC_ID }),
    );
    const { records } = fakeDurableStreamTransports();

    act(() => {
      rowRef.current = { ...AT_FLOOR_ROW, websocketUrl: null };
      rerender();
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.closeCount).toBe(0);
    expect(hasSimulatorSessionsCoordinator(OWNER_KEY)).toBe(true);
  });
});
