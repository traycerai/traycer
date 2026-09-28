import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpicStreamClientFactory } from "../legacy-epic-stream-adapter";
import {
  getProcessMemoryRuntime,
  resetProcessMemoryRuntimeForTests,
} from "@/stores/replica-memory/process-memory-accountant";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "../../test-support/open-store-for-test";

function openLegacyStore(epicId: string): OpenedStoreForTest {
  const factory: EpicStreamClientFactory = () => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    applyArtifactRoomUpdate: () => undefined,
    artifactRoomAwareness: () => undefined,
    retryMigration: () => undefined,
    close: () => undefined,
  });
  return openStoreForTest({
    epicId,
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
}

function replicaPlaneUsage(): {
  readonly settledBytes: number;
  readonly provisionalBytes: number;
} {
  const plane = getProcessMemoryRuntime()
    .accountant.snapshot()
    .planes.find((item) => item.planeId === BUDGET_PLANE_IDS.epicReplicas);
  if (plane === undefined)
    throw new Error("epic-replicas plane is not registered");
  return {
    settledBytes: plane.settledBytes,
    provisionalBytes: plane.provisionalBytes,
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  resetProcessMemoryRuntimeForTests();
});

describe("root Y.Doc byte settlement", () => {
  it("settles continuous edits by the maximum delay without encoding each edit", () => {
    vi.useFakeTimers();
    const handle = openLegacyStore("root-settle-max-delay");
    try {
      // Let any initial document-composition change finish before starting
      // the deliberately continuous edit burst.
      vi.advanceTimersByTime(2_100);
      const baselineProvisionalBytes = replicaPlaneUsage().provisionalBytes;
      for (let edit = 0; edit < 20; edit += 1) {
        if (edit > 0) vi.advanceTimersByTime(100);
        handle.doc.transact(() => {
          handle.doc
            .getMap("continuous-edits")
            .set(`key-${edit}`, "x".repeat(32));
        });
        expect(replicaPlaneUsage().provisionalBytes).toBeGreaterThan(
          baselineProvisionalBytes,
        );
      }

      // The last edit was at t=1,900ms. The idle timer is due at 2,150ms,
      // while the max-latency timer is due at 2,000ms.
      const provisionalBeforeMaxDeadline = replicaPlaneUsage().provisionalBytes;
      vi.advanceTimersByTime(100);
      expect(replicaPlaneUsage().settledBytes).toBeGreaterThan(0);
      expect(replicaPlaneUsage().provisionalBytes).toBeLessThan(
        provisionalBeforeMaxDeadline,
      );
    } finally {
      handle.dispose();
    }
  });

  it("cancels both pending settlement timers when the runtime is disposed", () => {
    vi.useFakeTimers();
    const handle = openLegacyStore("root-settle-dispose");
    const setTimeout = vi.spyOn(window, "setTimeout");
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    try {
      handle.doc.transact(() => {
        handle.doc.getMap("dispose-before-settle").set("key", "value");
      });
      const rootTimerIds: unknown[] = [];
      for (const [index, args] of setTimeout.mock.calls.entries()) {
        if (args[1] !== 250 && args[1] !== 2_000) continue;
        const timerId: unknown = setTimeout.mock.results[index]?.value;
        if (timerId !== undefined) rootTimerIds.push(timerId);
      }
      expect(rootTimerIds.length).toBeGreaterThanOrEqual(2);

      handle.dispose();
      for (const timerId of rootTimerIds) {
        expect(clearTimeout).toHaveBeenCalledWith(timerId);
      }
    } finally {
      setTimeout.mockRestore();
      clearTimeout.mockRestore();
      handle.dispose();
    }
  });
});
