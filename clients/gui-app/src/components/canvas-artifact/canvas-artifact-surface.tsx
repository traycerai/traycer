import type { CanvasPageError } from "@/lib/sandbox/canvas-bridge";
import { useCallback, useContext, useEffect, useMemo } from "react";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { deriveCollabUser } from "@/editor-core/awareness/derive-collab-user";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicStore } from "@/hooks/use-epic-store";
import { artifactTreePath } from "@/lib/artifacts/artifact-object-paths";
import { useStableOutsideReferenceResolver } from "@/lib/artifacts/use-stable-outside-reference-resolver";
import { useEpicArtifactBodyAwareness } from "@/lib/epic-selectors";
import { createArtifactByteCache } from "@/lib/sandbox/artifact-serving/artifact-byte-cache";
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
import { LIVE_BOARD_SLOT_BUDGET } from "./canvas-model";
import { useCanvasLayout, useCanvasLayoutDocument } from "./use-canvas-layout";

export interface CanvasErrorAttachment extends CanvasPageError {
  readonly artifact: ArtifactProjection;
  readonly boardPath: string;
}
interface CanvasArtifactSurfaceProps {
  readonly viewOnly?: boolean;
  readonly onAddError?: (error: CanvasErrorAttachment) => void;
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
            canvas: true,
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
function useBoardFiles(artifact: ArtifactProjection) {
  const head = artifact.head;
  return useMemo(
    () => ({
      boardFiles: head === undefined ? null : new Set(Object.keys(head.files)),
      boardByteLengths:
        head === undefined
          ? null
          : Object.fromEntries(
              Object.entries(head.files).map(([path, entry]) => [
                path,
                entry.byteLength,
              ]),
            ),
    }),
    [head],
  );
}
function useCachedBoardReader(readSpan: ArtifactReadSpan): ArtifactReadSpan {
  const cache = useMemo(() => createArtifactByteCache(readSpan), [readSpan]);
  useEffect(() => () => cache.clear(), [cache]);
  return cache.readSpan;
}
function LiveCanvasSurface({
  epicId,
  artifactId,
  artifact,
  viewOnly,
  onAddError,
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
  const cachedReadSpan = useCachedBoardReader(readSpan);
  const resolveOutsideReference = useStableOutsideReferenceResolver(artifacts);
  const sourceForBoard = useBoardSource(
    artifact,
    artifactTreePath(artifacts, artifactId),
    cachedReadSpan,
    resolveOutsideReference,
  );
  const { boardFiles, boardByteLengths } = useBoardFiles(artifact);
  return store === null ? (
    <div role="status" className="p-4 text-ui-sm text-muted-foreground">
      Opening canvas…
    </div>
  ) : (
    <CanvasArtifactEditor
      key={artifactId}
      artifactId={artifactId}
      viewOnly={viewOnly}
      onAddError={(path, error) =>
        onAddError?.({ artifact, boardPath: path, ...error })
      }
      store={store}
      awareness={awareness}
      user={user}
      sourceForBoard={sourceForBoard}
      boardFiles={boardFiles}
      boardByteLengths={boardByteLengths}
      frameEvents={frameEvents}
      liveSlotBudget={LIVE_BOARD_SLOT_BUDGET}
    />
  );
}
function FixtureCanvasSurface({
  artifactId,
  artifact,
  fixture,
  viewOnly,
  onAddError,
}: {
  readonly viewOnly: boolean | undefined;
  readonly onAddError: ((error: CanvasErrorAttachment) => void) | undefined;
  readonly artifactId: string;
  readonly artifact: ArtifactProjection;
  readonly fixture: CanvasArtifactFixture;
}) {
  const store = useCanvasLayoutDocument(fixture.doc, artifactId);
  const readSpan = useCachedBoardReader(fixture.readSpan);
  const frameEvents = useContext(CanvasFrameEventsContext);
  const sourceForBoard = useBoardSource(
    artifact,
    fixture.treePath,
    readSpan,
    fixture.resolveOutsideReference,
  );
  const { boardFiles, boardByteLengths } = useBoardFiles(artifact);
  return store === null ? null : (
    <CanvasArtifactEditor
      key={artifactId}
      artifactId={artifactId}
      viewOnly={viewOnly}
      onAddError={(path, error) =>
        onAddError?.({ artifact, boardPath: path, ...error })
      }
      store={store}
      awareness={fixture.awareness}
      user={fixture.user}
      sourceForBoard={sourceForBoard}
      boardFiles={boardFiles}
      boardByteLengths={boardByteLengths}
      frameEvents={frameEvents}
      liveSlotBudget={LIVE_BOARD_SLOT_BUDGET}
    />
  );
}
export function CanvasArtifactSurface(props: CanvasArtifactSurfaceProps) {
  const fixture = useContext(FixtureContext);
  return fixture === null ? (
    <LiveCanvasSurface key={props.artifactId} {...props} />
  ) : (
    <FixtureCanvasSurface
      key={props.artifactId}
      artifactId={props.artifactId}
      artifact={props.artifact}
      fixture={fixture}
      viewOnly={props.viewOnly}
      onAddError={props.onAddError}
    />
  );
}
