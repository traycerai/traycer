import { useMemo, useSyncExternalStore } from "react";
import { CanvasArtifactSurface } from "@/components/canvas-artifact/canvas-artifact-surface";
import { CanvasArtifactFixtureProvider } from "@/components/canvas-artifact/canvas-surface-context";
import {
  CANVAS_PROOF_EPIC_ID,
  CANVAS_PROOF_VIEW_TAB_ID,
  createCanvasEditingProofStore,
} from "@/components/canvas-artifact/canvas-editing-proof-fixture";
import { CanvasSelectionProvider } from "@/components/canvas-artifact/canvas-selection-provider";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import { useSurfaceHostPin } from "@/hooks/host/use-surface-host-pin";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";

function CanvasProof({ hostId }: { readonly hostId: string }) {
  const store = useMemo(() => createCanvasEditingProofStore(), []);
  const fixture = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return (
    <main className="flex h-safe-dvh min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <h1 className="text-ui-sm font-semibold">Canvas proof</h1>
        <p className="text-ui-xs text-muted-foreground">
          Select page elements to inspect, retype, format, or add them to chat.
          Changes show a refusal because these pages are samples.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        {fixture === null ? null : (
          <EpicSessionContext value={fixture.epic}>
            <EpicViewTabContext value={CANVAS_PROOF_VIEW_TAB_ID}>
              <TabHostProvider hostId={hostId}>
                <CanvasArtifactFixtureProvider value={fixture.binding}>
                  <CanvasSelectionProvider
                    epicId={CANVAS_PROOF_EPIC_ID}
                    artifactId={fixture.artifact.id}
                    artifactTitle={fixture.artifact.title}
                    artifactType="canvas"
                    hostId={hostId}
                    viewTabId={CANVAS_PROOF_VIEW_TAB_ID}
                  >
                    <CanvasArtifactSurface
                      epicId={CANVAS_PROOF_EPIC_ID}
                      artifactId={fixture.artifact.id}
                      artifact={fixture.artifact}
                    />
                  </CanvasSelectionProvider>
                </CanvasArtifactFixtureProvider>
              </TabHostProvider>
            </EpicViewTabContext>
          </EpicSessionContext>
        )}
      </div>
    </main>
  );
}
export function CanvasProofRoute() {
  const { resolvedHostId: hostId } = useSurfaceHostPin(
    CANVAS_PROOF_VIEW_TAB_ID,
  );
  if (!import.meta.env.DEV) return <p>404 — Not found</p>;
  return hostId === null ? (
    <p role="status">Connect a device to open the canvas proof.</p>
  ) : (
    <CanvasProof key={hostId} hostId={hostId} />
  );
}
