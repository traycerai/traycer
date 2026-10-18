import { CanvasSelectionProvider } from "@/components/canvas-artifact/canvas-selection-provider";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import { CanvasArtifactSurface } from "@/components/canvas-artifact/canvas-artifact-surface";
import { isMobileApp } from "@/lib/mobile-app";
import { resolveDesktopPlatform } from "@/lib/windows/desktop-capabilities";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useMemo } from "react";
import {
  SandboxFrame,
  type SandboxSource,
} from "@/components/sandbox/sandbox-frame";
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
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";

const noop = (): void => undefined;
const NO_PERMISSIONS = [] as const;

export function ObjectArtifactTile(props: {
  readonly node: EpicArtifactRef;
  readonly epicId: string;
}) {
  const runnerHost = useRunnerHostOrNull();
  const artifact = useArtifactById(props.node.id);
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
  const source = useMemo<SandboxSource | null>(() => {
    if (artifact?.kind !== "html" || artifact.head === undefined) return null;
    const paths = artifactSourcePathsFor(artifact, artifacts);
    if (paths === null) return null;
    return {
      kind: "artifact",
      artifactId: artifact.id,
      manifest: artifact.head,
      readSpan,
      resolveOutsideReference,
      ...paths,
    };
  }, [artifact, artifacts, readSpan, resolveOutsideReference]);
  if (artifact === null)
    return (
      <div className="p-4 text-muted-foreground">Artifact unavailable.</div>
    );
  if (artifact.kind === "canvas") {
    const mobile = isMobileApp();
    if (
      !mobile &&
      (runnerHost === null || resolveDesktopPlatform(runnerHost) === null)
    )
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
  if (source !== null) {
    return (
      <SandboxFrame
        source={source}
        kind="page"
        title={artifact.title}
        appName={null}
        networkPolicy="https-only"
        appCsp={null}
        permissions={NO_PERMISSIONS}
        appRequests={null}
        className="h-full w-full"
        height={null}
        onSize={noop}
        onStatus={noop}
        onRequestTeardown={noop}
        displayMode="inline"
        onBridge={null}
        ref={null}
      />
    );
  }
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
  if (viewOnly || viewTabId === null) return surface;
  return (
    <CanvasSelectionProvider
      epicId={epicId}
      artifactId={artifact.id}
      artifactTitle={artifact.title}
      hostId={hostId}
      viewTabId={viewTabId}
    >
      {surface}
    </CanvasSelectionProvider>
  );
}
