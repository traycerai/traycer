import { describe, expect, it, vi } from "vitest";
import type {
  RuntimeEnvironment,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime";
import {
  createMetadataOverlayStore,
  type MetadataOverlayStore,
} from "../metadata-overlay-store";
import type { PendingRename } from "../../pending-metadata-overlay";

interface ScheduledTimer {
  readonly wasCanceled: () => boolean;
  readonly fire: () => void;
}

function fixture() {
  const microtasks: Array<() => void> = [];
  const timers: ScheduledTimer[] = [];
  const onRetainedStateChanged = vi.fn();
  const environment: RuntimeEnvironment = {
    clock: { now: () => 0 },
    scheduler: {
      schedule: (_delayMs, callback): RuntimeTimer => {
        let canceled = false;
        const cancel = (): void => {
          canceled = true;
        };
        timers.push({
          wasCanceled: () => canceled,
          fire: () => {
            if (!canceled) callback();
          },
        });
        return { cancel };
      },
      scheduleMicrotask: (callback) => microtasks.push(callback),
    },
    logger: {
      debug: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
  const store: MetadataOverlayStore = createMetadataOverlayStore({
    environment,
    republish: () => undefined,
    isProjectorAttached: () => true,
    hasFreshRootSnapshotForOpenCycle: () => true,
    recordPlaneServesNode: () => true,
    isDisposed: () => false,
    onReconciled: () => undefined,
    onRetainedStateChanged,
  });
  return {
    store,
    microtasks,
    timers,
    onRetainedStateChanged,
    flushMicrotasks: (): void => {
      while (microtasks.length > 0) microtasks.shift()?.();
    },
  };
}

function rename(requestId: string, nodeId: string): PendingRename {
  return {
    kind: "rename",
    requestId,
    nodeId,
    title: `Renamed ${requestId}`,
    baseline: "Original",
    landed: false,
  };
}

describe("metadata overlay retained accounting", () => {
  it("has a nonzero empty floor and keeps rename stamps charged after chains retire", () => {
    const { store } = fixture();
    const empty = store.retainedSize();
    expect(empty.rawBytes).toBeGreaterThan(0);
    expect(empty.estimatedHeapBytes).toBeGreaterThan(0);

    for (let index = 0; index < 100; index += 1) {
      const requestId = `rename-request-${index}`;
      const nodeId = `node-${index}`;
      store.stamp(rename(requestId, nodeId));
      store.recordRenameStamp(nodeId, requestId);
      expect(store.retire(requestId, "failed")).toBe(true);
    }

    expect(store.overlay().size).toBe(0);
    expect(store.retainedSize().rawBytes).toBeGreaterThan(empty.rawBytes);
    expect(store.retainedSize().estimatedHeapBytes).toBeGreaterThan(
      empty.estimatedHeapBytes,
    );
    expect(store.isLatestRenameStamp("node-0", "rename-request-0")).toBe(true);
  });

  it("releases pending, registry, unknown-outcome, and timer charges on retire and clear", () => {
    const { store, timers } = fixture();
    const empty = store.retainedSize();

    store.stamp(rename("failed-request", "failed-node"));
    expect(store.retainedSize().estimatedHeapBytes).toBeGreaterThan(
      empty.estimatedHeapBytes,
    );
    expect(store.retire("failed-request", "failed")).toBe(true);
    expect(store.retainedSize()).toEqual(empty);

    store.stamp(rename("unknown-request", "unknown-node"));
    expect(store.markUnknownOutcome("unknown-request")).toBe(true);
    expect(timers).toHaveLength(1);
    expect(store.retainedSize().estimatedHeapBytes).toBeGreaterThan(
      empty.estimatedHeapBytes,
    );
    store.clear();

    expect(timers[0]?.wasCanceled()).toBe(true);
    expect(store.retainedSize()).toEqual(empty);
  });

  it("coalesces retained-size callbacks across one microtask burst", () => {
    const { store, microtasks, onRetainedStateChanged, flushMicrotasks } =
      fixture();
    store.stamp(rename("burst-request-a", "burst-node-a"));
    store.stamp(rename("burst-request-b", "burst-node-b"));
    store.recordRenameStamp("burst-node-a", "burst-request-a");
    store.markUnknownOutcome("burst-request-a");

    expect(onRetainedStateChanged).not.toHaveBeenCalled();
    expect(microtasks).toHaveLength(1);
    flushMicrotasks();
    expect(onRetainedStateChanged).toHaveBeenCalledOnce();
    expect(onRetainedStateChanged).toHaveBeenCalledWith(store.retainedSize());
  });
});
