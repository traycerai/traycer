import type { ReactNode } from "react";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  __getOpenEpicRegistryForTests,
  EpicSessionContext,
} from "@/lib/registries/epic-session-registry";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";

const openedHandles: OpenedStoreForTest[] = [];

/**
 * Provides a real open-epic store holding `artifacts`, which is what the
 * artifact rows of the chat change surfaces resolve their live title and
 * layout from.
 */
export function withArtifactEpicSession(
  artifacts: ReadonlyArray<ArtifactProjection>,
  children: ReactNode,
): ReactNode {
  const handle = openStoreForTest({
    epicId: "epic-1",
    userId: null,
    factories: {
      streamClientFactory: () => ({
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => undefined,
      }),
      laneSelection: null,
    },
    writeCommand: null,
  });
  openedHandles.push(handle);
  handle.store.setState({
    artifacts: {
      byId: Object.fromEntries(
        artifacts.map((artifact) => [artifact.id, artifact]),
      ),
      allIds: artifacts.map((artifact) => artifact.id),
    },
  });
  return (
    <TabHostContext.Provider value="host-1">
      <EpicSessionContext.Provider value={handle}>
        {children}
      </EpicSessionContext.Provider>
    </TabHostContext.Provider>
  );
}

export function disposeArtifactEpicSessions(): void {
  __getOpenEpicRegistryForTests().disposeAll();
  for (const handle of openedHandles) handle.dispose();
  openedHandles.length = 0;
}
