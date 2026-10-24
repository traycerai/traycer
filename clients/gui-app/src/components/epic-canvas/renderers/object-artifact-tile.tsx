import { FileArtifactViewer } from "./file-artifact-viewer";
import { CanvasSelectionProvider } from "@/components/canvas-artifact/canvas-selection-provider";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import { CanvasArtifactSurface } from "@/components/canvas-artifact/canvas-artifact-surface";
import { HtmlArtifactDownloadButton } from "@/components/html-artifact/html-artifact-download-button";
import { HtmlArtifactVersionPicker } from "@/components/html-artifact/html-artifact-version-picker";
import { useEpicHtmlArtifactVersion } from "@/hooks/epic/use-epic-html-artifact-version";
import { HtmlArtifactFrame } from "@/components/html-artifact/html-artifact-frame";
import { isMobileApp } from "@/lib/mobile-app";
import { resolveDesktopPlatform } from "@/lib/windows/desktop-capabilities";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useMemo } from "react";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicStore } from "@/hooks/use-epic-store";
import {
  useArtifactById,
  useEpicArtifactBodyLease,
} from "@/lib/epic-selectors";
import { EPIC_NODE_LABELS } from "@/lib/artifacts/node-display";
import { artifactSourcePathsFor } from "@/lib/artifacts/artifact-object-paths";
import { useStableOutsideReferenceResolver } from "@/lib/artifacts/use-stable-outside-reference-resolver";
import { createHostObjectReader } from "@/lib/sandbox/artifact-serving/host-object-reader";
import { NO_OUTSIDE_REFERENCE } from "@/lib/sandbox/artifact-serving";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";

export function ObjectArtifactTile(props: {
  readonly node: EpicArtifactRef;
  readonly epicId: string;
}) {
  const runnerHost = useRunnerHostOrNull();
  const hostId = useTabHostId();
  const desktop =
    runnerHost !== null && resolveDesktopPlatform(runnerHost) !== null;
  const artifact = useArtifactById(props.node.id);
  const version = useEpicHtmlArtifactVersion({
    epicId: props.epicId,
    node: props.node,
    artifact,
  });
  // An open html tile holds the same body lease a markdown tile holds, even
  // though it reads no body document: on the host that lease is the demand
  // that runs the epic's file work, so the folder on disk is captured and a
  // collaborator's head is materialised while the artifact is being looked
  // at. Without it a chat-only task never captures a hand-written folder. A
  // canvas tile leases through its surface; a file artifact has no room.
  useEpicArtifactBodyLease(artifact?.kind === "html" ? artifact.id : null);
  const artifacts = useEpicStore((state) => state.artifacts);
  const client = useTabHostClient();
  const readSpan = useMemo(
    () =>
      createHostObjectReader({
        epicId: props.epicId,
        request: (method, params, signal) =>
          client === null
            ? Promise.resolve({ kind: "unavailable", reason: "missing" })
            : client.requestWithSignal(method, params, signal),
      }),
    [client, props.epicId],
  );
  const resolveOutsideReference = useStableOutsideReferenceResolver(artifacts);
  const latest = version.selectedVersion === null;
  const source = useMemo<SandboxSource | null>(() => {
    if (artifact?.kind !== "html" || version.manifest === null) return null;
    const paths = artifactSourcePathsFor(artifact, artifacts);
    if (paths === null) return null;
    return {
      kind: "artifact",
      artifactId: artifact.id,
      manifest: version.manifest,
      readSpan,
      resolveOutsideReference: latest
        ? resolveOutsideReference
        : NO_OUTSIDE_REFERENCE,
      ...paths,
      entryPath: version.entryPath ?? paths.entryPath,
    };
  }, [
    artifact,
    artifacts,
    readSpan,
    resolveOutsideReference,
    version.manifest,
    version.entryPath,
    latest,
  ]);
  if (artifact === null)
    return (
      <div className="p-4 text-muted-foreground">Artifact unavailable.</div>
    );
  if (artifact.kind === "file" && artifact.object !== undefined) {
    return (
      <FileArtifactViewer
        key={`${artifact.id}:${artifact.object.sha256}`}
        epicId={props.epicId}
        hostId={hostId}
        name={artifact.folderName}
        object={artifact.object}
        readSpan={readSpan}
      />
    );
  }
  if (artifact.kind === "canvas") {
    const mobile = isMobileApp();
    if (!mobile && !desktop)
      return (
        <div className="p-4 text-muted-foreground">
          Open this canvas in the desktop or mobile app.
        </div>
      );
    return (
      <CanvasTileSurface
        epicId={props.epicId}
        artifact={artifact}
        viewOnly={mobile}
      />
    );
  }
  if (source?.kind === "artifact") {
    return (
      <HtmlArtifactFrame
        key={artifact.id}
        source={source}
        title={artifact.title}
        toolbarControls={
          <>
            <HtmlArtifactVersionPicker version={version} />
            <HtmlArtifactDownloadButton
              source={source}
              title={artifact.title}
              hostId={hostId}
            />
          </>
        }
      />
    );
  }
  return <ArtifactMetadata artifact={artifact} />;
}

function ArtifactMetadata({
  artifact,
}: {
  readonly artifact: ArtifactProjection;
}) {
  const byteLength =
    artifact.object?.byteLength ??
    (artifact.head === undefined
      ? null
      : Object.values(artifact.head.files).reduce(
          (total, file) => total + file.byteLength,
          0,
        ));
  return (
    <div className="flex min-w-0 flex-col gap-2 p-4">
      <div className="truncate">
        {artifact.title || EPIC_NODE_LABELS[artifact.kind]}
      </div>
      <div className="text-sm text-muted-foreground">
        {EPIC_NODE_LABELS[artifact.kind]}
        {byteLength === null ? "" : ` · ${byteLength.toLocaleString()} bytes`}
      </div>
    </div>
  );
}

function CanvasTileSurface({
  epicId,
  artifact,
  viewOnly,
}: {
  readonly epicId: string;
  readonly artifact: ArtifactProjection;
  readonly viewOnly: boolean;
}) {
  const hostId = useTabHostId();
  const viewTabId = useEpicViewTabId();
  const surface = (
    <CanvasArtifactSurface
      epicId={epicId}
      artifactId={artifact.id}
      artifact={artifact}
      viewOnly={viewOnly}
    />
  );
  if (viewTabId === null) return surface;
  return (
    <CanvasSelectionProvider
      epicId={epicId}
      artifactId={artifact.id}
      artifactTitle={artifact.title}
      hostId={hostId}
      viewTabId={viewTabId}
      viewOnly={viewOnly}
    >
      {surface}
    </CanvasSelectionProvider>
  );
}
