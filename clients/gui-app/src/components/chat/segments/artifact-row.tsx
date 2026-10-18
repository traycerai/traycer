import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ToolCallArtifactStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  useChatAttachmentScope,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import {
  SandboxFrame,
  type SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import { useEpicStore } from "@/hooks/use-epic-store";
import { artifactSourcePathsFor } from "@/lib/artifacts/artifact-object-paths";
import { useStableOutsideReferenceResolver } from "@/lib/artifacts/use-stable-outside-reference-resolver";
import { Button } from "@/components/ui/button";
import type {
  ArtifactProjection,
  ArtifactsSlice,
} from "@/stores/epics/open-epic/types";
import type {
  ArtifactManifest,
  ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";
import { createHostObjectReader } from "@/lib/sandbox/artifact-serving/host-object-reader";
import type { SandboxSize, SandboxStatus } from "@/lib/sandbox/bridge-host";
import {
  artifactManifestsEqual,
  selectArtifactRowState,
} from "./artifact-row-state";

const NO_PERMISSIONS = [] as const;
const MIN_PAGE_HEIGHT_PX = 80;
const MAX_PAGE_HEIGHT_PX = 4000;

function ignoreFrameEvent(): void {}

export function ArtifactRow(props: {
  readonly artifact: ToolCallArtifactStamp;
  readonly fallback: ReactNode;
}): ReactNode {
  const scope = useChatAttachmentScope();
  if (scope === null) return props.fallback;
  return (
    <ShownArtifact
      key={props.artifact.artifactId}
      stamp={props.artifact}
      scope={scope}
    />
  );
}

function useStableManifest(
  manifest: ArtifactManifest | null,
): ArtifactManifest | null {
  const [stable, setStable] = useState(manifest);
  if (!artifactManifestsEqual(stable, manifest)) {
    setStable(manifest);
    return manifest;
  }
  return stable;
}

interface ArtifactLocation {
  readonly artifact: ArtifactProjection;
  readonly treePath: string;
  readonly entryPath: string;
}

function useArtifactLocation(
  artifact: ArtifactProjection | null,
  artifacts: ArtifactsSlice,
): ArtifactLocation | null {
  const paths =
    artifact === null ? null : artifactSourcePathsFor(artifact, artifacts);
  const [location, setLocation] = useState<ArtifactLocation | null>(null);
  // The record lane can reconnect independently of the transcript. Keep the
  // mounted document's location until a new record or a tombstone arrives.
  let resolved = location;
  if (
    artifact !== null &&
    paths !== null &&
    (location?.artifact !== artifact ||
      location.treePath !== paths.treePath ||
      location.entryPath !== paths.entryPath)
  ) {
    resolved = { artifact, ...paths };
    setLocation(resolved);
  }
  return resolved;
}

function ShownArtifact(props: {
  readonly stamp: ToolCallArtifactStamp;
  readonly scope: ChatAttachmentScopeValue;
}) {
  const { stamp, scope } = props;
  const artifacts = useEpicStore((state) => state.artifacts);
  const artifact = Object.hasOwn(artifacts.byId, stamp.artifactId)
    ? artifacts.byId[stamp.artifactId]
    : null;
  const confirmedDeleted = useEpicStore((state) =>
    Object.hasOwn(state.deletedArtifacts.byId, stamp.artifactId),
  );
  const resolved = useArtifactLocation(artifact, artifacts);
  const stampedManifest = useStableManifest(stamp.manifest);
  const [missingManifest, setMissingManifest] =
    useState<ArtifactManifest | null>(null);
  const [height, setHeight] = useState(MIN_PAGE_HEIGHT_PX);
  const [crashedSource, setCrashedSource] = useState<SandboxSource | null>(
    null,
  );
  const [generation, setGeneration] = useState(0);
  const state = selectArtifactRowState(
    stamp,
    resolved?.artifact ?? null,
    missingManifest !== null &&
      artifactManifestsEqual(missingManifest, stampedManifest),
    confirmedDeleted,
  );
  const manifest = useStableManifest(
    "manifest" in state ? state.manifest : null,
  );
  const readSpan = useMemo<ArtifactReadSpan>(() => {
    const read = createHostObjectReader({
      epicId: scope.epicId,
      request: (method, params, signal) => {
        if (scope.client === null) {
          return Promise.reject(new Error("Artifact host is unavailable"));
        }
        return scope.client.requestWithSignal(method, params, signal);
      },
    });
    const stampedHashes = new Set(
      Object.values(stampedManifest?.files ?? {}).map((entry) => entry.sha256),
    );
    return async (sha256, offset, length, signal) => {
      const result = await read(sha256, offset, length, signal);
      // A missing sibling is not evidence that the captured document was evicted.
      if (
        "unavailable" in result &&
        result.unavailable === "missing" &&
        stampedHashes.has(sha256)
      ) {
        setMissingManifest(stampedManifest);
      }
      return result;
    };
  }, [scope.client, scope.epicId, stampedManifest]);
  const resolveOutsideReference = useStableOutsideReferenceResolver(artifacts);
  const treePath = resolved?.treePath;
  const entryPath = resolved?.entryPath;
  const source = useMemo<SandboxSource | null>(() => {
    if (manifest === null || treePath === undefined || entryPath === undefined)
      return null;
    return {
      kind: "artifact",
      artifactId: stamp.artifactId,
      manifest,
      treePath,
      entryPath,
      readSpan,
      resolveOutsideReference,
    };
  }, [
    treePath,
    entryPath,
    stamp.artifactId,
    manifest,
    readSpan,
    resolveOutsideReference,
  ]);
  const handleStatus = useCallback(
    (status: SandboxStatus): void => {
      if (status === "crashed") setCrashedSource(source);
    },
    [source],
  );
  const handleSize = useCallback((size: SandboxSize): void => {
    if (size.height === null) return;
    setHeight(
      Math.min(MAX_PAGE_HEIGHT_PX, Math.max(MIN_PAGE_HEIGHT_PX, size.height)),
    );
  }, []);

  let content: ReactNode;
  if (state.kind === "deleted") {
    content = (
      <div className="p-4 text-ui-sm text-muted-foreground">
        This artifact was deleted.
      </div>
    );
  } else if (state.kind === "pending" || scope.client === null) {
    content = (
      <div className="p-4 text-ui-sm text-muted-foreground">
        Loading artifact
      </div>
    );
  } else if (source !== null && crashedSource === source) {
    content = (
      <div className="flex flex-col items-start gap-2 p-4 text-ui-sm text-muted-foreground">
        <span>This artifact stopped responding.</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCrashedSource(null);
            setHeight(MIN_PAGE_HEIGHT_PX);
            setGeneration((value) => value + 1);
          }}
        >
          Reload
        </Button>
      </div>
    );
  } else if (source === null) {
    content = (
      <div className="p-4 text-ui-sm text-muted-foreground">
        Artifact unavailable.
      </div>
    );
  } else {
    content = (
      <>
        {state.kind === "latest" ? (
          <figcaption className="mb-2 text-ui-xs text-muted-foreground">
            Showing latest
          </figcaption>
        ) : null}
        <SandboxFrame
          key={generation}
          source={source}
          kind="page"
          title={stamp.title}
          appName={null}
          networkPolicy="https-only"
          appCsp={null}
          permissions={NO_PERMISSIONS}
          appRequests={null}
          className="w-full"
          height={height}
          onSize={handleSize}
          onStatus={handleStatus}
          onRequestTeardown={ignoreFrameEvent}
          displayMode="inline"
          onBridge={null}
          ref={null}
        />
      </>
    );
  }

  return (
    <figure
      aria-label={`Artifact: ${stamp.title}`}
      data-testid="artifact-row"
      data-find-skip=""
      data-quote-exclude=""
      className="m-0 flex w-full flex-col"
    >
      {content}
    </figure>
  );
}
