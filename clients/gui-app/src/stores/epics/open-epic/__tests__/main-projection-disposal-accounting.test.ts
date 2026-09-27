import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { OpenEpicSessionRegistry } from "@/stores/epics/open-epic/session-registry";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
} from "@/stores/agent-activity-store";
import {
  DESKTOP_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { ensureProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

describe("main projection accounting during synchronous warm-session disposal", () => {
  afterEach(() => {
    __resetAgentActivityStoreForTests();
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
    vi.useRealTimers();
  });

  it("does not resurrect the projection holder after a registry listener disposes the store", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setRetentionProfile({
      ...DESKTOP_RETENTION_PROFILE,
      unknownActivityCapGraceMs: 0,
    });
    __setHostAgentActivityHealthForTests("test-host", {
      connectionStatus: "closed",
    });

    const memory = ensureProcessMemoryRuntime(
      createRendererRuntimeEnvironment(),
    );
    const baselineProjectionBytes =
      memory.epicReplicas.estimatedMainProjectionHeapBytes();
    let maxLive = 1;
    const registry = new OpenEpicSessionRegistry({ maxLive: () => maxLive });
    const opened = openStoreForTest({
      epicId: "projection-disposal-accounting",
      userId: null,
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    });
    try {
      registry.acquire(opened.epicId, () => opened);
      opened.projection.apply({ heldAttachmentHashes: ["before-disposal"] }, 1);
      expect(
        memory.epicReplicas.estimatedMainProjectionHeapBytes(),
      ).toBeGreaterThan(baselineProjectionBytes);

      // The only resident task is below this count cap. Lowering the cap makes
      // the clean transition itself synchronously evict that warm entry.
      // Dirty it while still under cap so the clean transition changes the
      // registry's eligibility key and runs its real warm-entry prune.
      opened.store.setState({ isDirty: true });
      maxLive = 0;
      opened.projection.apply(
        { isDirty: false, heldAttachmentHashes: ["during-disposal"] },
        2,
      );

      expect(registry.size()).toBe(0);
      expect(memory.epicReplicas.estimatedMainProjectionHeapBytes()).toBe(
        baselineProjectionBytes,
      );
    } finally {
      registry.disposeAll();
    }
  });
});
