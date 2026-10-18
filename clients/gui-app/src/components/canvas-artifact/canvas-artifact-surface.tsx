import { useCallback, useContext, useMemo } from "react";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { deriveCollabUser } from "@/editor-core/awareness/derive-collab-user";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicStore } from "@/hooks/use-epic-store";
import { artifactTreePath } from "@/lib/artifacts/artifact-object-paths";
import { useStableOutsideReferenceResolver } from "@/lib/artifacts/use-stable-outside-reference-resolver";
import { useEpicArtifactBodyAwareness } from "@/lib/epic-selectors";
import { createHostObjectReader } from "@/lib/sandbox/artifact-serving/host-object-reader";
import type {
  ArtifactOutsideReferenceResolver,
  ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import { CanvasArtifactEditor } from "./canvas-artifact-editor";
import {
  FixtureContext,
  CanvasFrameEventsContext,
  type CanvasArtifactFixture,
} from "./canvas-surface-context";
import { LIVE_BOARD_LIMIT } from "./canvas-model";
import { useCanvasLayout, useCanvasLayoutDocument } from "./use-canvas-layout";

interface CanvasArtifactSurfaceProps {
  readonly epicId: string;
  readonly artifactId: string;
  readonly artifact: ArtifactProjection;
}
function useBoardSource(
  artifact: ArtifactProjection,
  treePath: string | null,
  readSpan: ArtifactReadSpan,
  resolveOutsideReference: ArtifactOutsideReferenceResolver,
) {
  return useCallback(
    (path: string): SandboxSource | null =>
      artifact.head === undefined || treePath === null
        ? null
        : {
            kind: "artifact",
            artifactId: artifact.id,
            treePath,
            entryPath: path,
            manifest: artifact.head,
            readSpan,
            resolveOutsideReference,
          },
    [artifact.head, artifact.id, treePath, readSpan, resolveOutsideReference],
  );
}
function LiveCanvasSurface({
  epicId,
  artifactId,
  artifact,
}: CanvasArtifactSurfaceProps) {
  const store = useCanvasLayout(artifactId);
  const awareness = useEpicArtifactBodyAwareness(artifactId);
  const artifacts = useEpicStore((state) => state.artifacts);
  const client = useTabHostClient();
  const profile = useAuthStore((state) => state.profile);
  const user = useMemo(
    () => deriveCollabUser(profile ?? { userName: null, email: null }),
    [profile],
  );
  const frameEvents = useContext(CanvasFrameEventsContext);
  const readSpan = useMemo(
    () =>
      createHostObjectReader({
        epicId,
        request: (method, params, signal) =>
          client === null
            ? Promise.resolve({ kind: "unavailable", reason: "missing" })
            : client.requestWithSignal(method, params, signal),
      }),
    [epicId, client],
  );
  const resolveOutsideReference = useStableOutsideReferenceResolver(artifacts);
  const sourceForBoard = useBoardSource(
    artifact,
    artifactTreePath(artifacts, artifactId),
    readSpan,
    resolveOutsideReference,
  );
  return store === null ? (
    <div role="status" className="p-4 text-ui-sm text-muted-foreground">
      Opening canvas…
    </div>
  ) : (
    <CanvasArtifactEditor
      key={artifactId}
      artifactId={artifactId}
      store={store}
      awareness={awareness}
      user={user}
      sourceForBoard={sourceForBoard}
      frameEvents={frameEvents}
      liveFrameLimit={LIVE_BOARD_LIMIT}
    />
  );
}
function FixtureCanvasSurface({
  artifactId,
  artifact,
  fixture,
}: {
  readonly artifactId: string;
  readonly artifact: ArtifactProjection;
  readonly fixture: CanvasArtifactFixture;
}) {
  const store = useCanvasLayoutDocument(fixture.doc, artifactId);
  const frameEvents = useContext(CanvasFrameEventsContext);
  const sourceForBoard = useBoardSource(
    artifact,
    fixture.treePath,
    fixture.readSpan,
    fixture.resolveOutsideReference,
  );
  return store === null ? null : (
    <CanvasArtifactEditor
      key={artifactId}
      artifactId={artifactId}
      store={store}
      awareness={fixture.awareness}
      user={fixture.user}
      sourceForBoard={sourceForBoard}
      frameEvents={frameEvents}
      liveFrameLimit={LIVE_BOARD_LIMIT}
    />
  );
}
export function CanvasArtifactSurface(props: CanvasArtifactSurfaceProps) {
  // TODO: tile wiring must enforce the mobile view-only gate (decision 22a).
  const fixture = useContext(FixtureContext);
  return fixture === null ? (
    <LiveCanvasSurface {...props} />
  ) : (
    <FixtureCanvasSurface
      artifactId={props.artifactId}
      artifact={props.artifact}
      fixture={fixture}
    />
  );
}
