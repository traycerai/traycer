import { useMemo, useSyncExternalStore } from "react";
import { CanvasArtifactSurface } from "@/components/canvas-artifact/canvas-artifact-surface";
import { CanvasArtifactFixtureProvider } from "@/components/canvas-artifact/canvas-surface-context";
import { createCanvasProofStore } from "@/components/canvas-artifact/canvas-proof-fixture";
function CanvasProof() {
  const store = useMemo(() => createCanvasProofStore(), []);
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
          Drag, resize, draw, switch pages, undo, and play.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        {fixture === null ? null : (
          <CanvasArtifactFixtureProvider value={fixture.binding}>
            <CanvasArtifactSurface
              epicId="canvas-proof"
              artifactId={fixture.artifact.id}
              artifact={fixture.artifact}
            />
          </CanvasArtifactFixtureProvider>
        )}
      </div>
    </main>
  );
}
export function CanvasProofRoute() {
  return import.meta.env.DEV ? <CanvasProof /> : <p>404 — Not found</p>;
}
