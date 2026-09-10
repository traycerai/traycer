import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  __getOpenEpicRegistryForTests,
  useEpicLocalHomeReading,
} from "@/lib/registries/epic-session-registry";
import {
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

/**
 * `useEpicLocalHomeReading` is the three-state read the `unverified` recency
 * carve-out (`7d521991d`) decides on: `epic-tab-route-components.tsx` must
 * tell "nobody has answered yet" (`unstated`) apart from "the host answered,
 * and it is not a local home" (`no-local-claim`), because only the first one
 * is worth waiting on. This pins `readEpicLocalHomeReading`'s classification
 * directly, independent of the route's bounded wait
 * (`epic-tab-route-recency-wait.test.tsx` pins that half).
 */

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function mountSession(epicId: string): OpenEpicStoreHandle {
  return __getOpenEpicRegistryForTests().acquireMounted(epicId, () =>
    openStoreForTest({
      epicId,
      userId: null,
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    }),
  );
}

afterEach(() => {
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
});

describe("useEpicLocalHomeReading", () => {
  it("reads `unstated` when no session exists for the epic", () => {
    const { result } = renderHook(() =>
      useEpicLocalHomeReading("epic-no-session"),
    );

    expect(result.current).toBe("unstated");
  });

  it("reads `unstated` while the session exists but the status is still null and the stream is healthy", () => {
    mountSession("epic-pending");

    const { result } = renderHook(() =>
      useEpicLocalHomeReading("epic-pending"),
    );

    expect(result.current).toBe("unstated");
  });

  it.each(["local", "promoting"] as const)(
    "reads `local` for durability status `%s`",
    (status) => {
      const handle = mountSession(`epic-${status}`);
      handle.store.setState({ durabilityStatus: status });

      const { result } = renderHook(() =>
        useEpicLocalHomeReading(`epic-${status}`),
      );

      expect(result.current).toBe("local");
    },
  );

  it.each(["cloud", "paused", "offline", "unknown"] as const)(
    "reads `no-local-claim` for durability status `%s`",
    (status) => {
      const handle = mountSession(`epic-${status}`);
      handle.store.setState({ durabilityStatus: status });

      const { result } = renderHook(() =>
        useEpicLocalHomeReading(`epic-${status}`),
      );

      expect(result.current).toBe("no-local-claim");
    },
  );

  it("reads `no-local-claim` when the status is null and the snapshot fetch failed", () => {
    const handle = mountSession("epic-snapshot-error");
    handle.store.setState({
      durabilityStatus: null,
      snapshotFetchError: {
        code: "NOT_FOUND",
        message: "room lookup is unavailable",
        upgradeGuidance: null,
      },
    });

    const { result } = renderHook(() =>
      useEpicLocalHomeReading("epic-snapshot-error"),
    );

    expect(result.current).toBe("no-local-claim");
  });

  it("reads `no-local-claim` when the status is null and access was lost", () => {
    const handle = mountSession("epic-access-lost");
    handle.store.setState({ durabilityStatus: null, accessLost: true });

    const { result } = renderHook(() =>
      useEpicLocalHomeReading("epic-access-lost"),
    );

    expect(result.current).toBe("no-local-claim");
  });

  it("reads `no-local-claim` when the status is null and the epic was deleted", () => {
    const handle = mountSession("epic-deleted");
    handle.store.setState({
      durabilityStatus: null,
      epicDeleted: { deletedByDisplayName: null, deletedByTraycerUserId: null },
    });

    const { result } = renderHook(() =>
      useEpicLocalHomeReading("epic-deleted"),
    );

    expect(result.current).toBe("no-local-claim");
  });

  it("keeps reading `local` once stated, even after the stream later fails - the status check runs first", () => {
    // `readEpicLocalHomeReading` checks `durabilityStatus ?? retainedDurabilityStatus`
    // BEFORE the stream-failure arm, on purpose: where an epic is durable is a
    // property of the epic, not of the connection, so a session that already
    // stated a local home must not un-state it just because the stream later
    // dropped. `retainedDurabilityStatus` carries the statement through the
    // reconnect for exactly this reason.
    const handle = mountSession("epic-local-then-failed");
    handle.store.setState({ durabilityStatus: "local" });

    const { result } = renderHook(() =>
      useEpicLocalHomeReading("epic-local-then-failed"),
    );
    expect(result.current).toBe("local");

    act(() => {
      handle.store.setState({
        durabilityStatus: null,
        retainedDurabilityStatus: "local",
        snapshotFetchError: {
          code: "NOT_FOUND",
          message: "room lookup is unavailable",
          upgradeGuidance: null,
        },
      });
    });

    expect(result.current).toBe("local");
  });
});
