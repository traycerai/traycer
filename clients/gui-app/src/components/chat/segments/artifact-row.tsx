import { useCallback, useMemo, useState, type ReactNode } from "react";
import { PanelsTopLeft } from "lucide-react";
import { ArtifactExpansion } from "@/components/artifacts/artifact-expansion";
import type { ToolCallArtifactStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import type { HtmlArtifactVersionSelection } from "@traycer/protocol/host/epic/html-artifact-versions";
import {
  useChatAttachmentScope,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { ArtifactPagesFrame } from "@/components/html-artifact/artifact-pages-frame";
import {
  HtmlArtifactCommentSurface,
  HtmlArtifactOlderVersionComments,
} from "@/components/html-artifact/html-artifact-comment-surface";
import { HtmlArtifactLinks } from "@/components/html-artifact/html-artifact-links";
import { HtmlArtifactVersionPicker } from "@/components/html-artifact/html-artifact-version-picker";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { HtmlArtifactDownloadButton } from "@/components/html-artifact/html-artifact-download-button";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  selectedHtmlVersion,
  useHtmlArtifactVersion,
} from "@/hooks/epic/use-epic-html-artifact-version";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { artifactSourcePathsFor } from "@/lib/artifacts/artifact-object-paths";
import { useStableOutsideReferenceResolver } from "@/lib/artifacts/use-stable-outside-reference-resolver";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type {
  ArtifactProjection,
  ArtifactsSlice,
} from "@/stores/epics/open-epic/types";
import type {
  ArtifactManifest,
  ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";
import { NO_OUTSIDE_REFERENCE } from "@/lib/sandbox/artifact-serving";
import { createHostObjectReader } from "@/lib/sandbox/artifact-serving/host-object-reader";
import type { SandboxSize, SandboxStatus } from "@/lib/sandbox/bridge-host";
import {
  artifactManifestsEqual,
  selectArtifactRowState,
  type ArtifactRowState,
} from "./artifact-row-state";

const MIN_PAGE_HEIGHT_PX = 80;
const MAX_PAGE_HEIGHT_PX = 4000;

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

/**
 * What the reader picked from the card's version history. Until a pick the
 * card shows its turn's capture: the card is a record of that turn, so it
 * never moves to a newer version by itself.
 */
type CardPick =
  | { readonly kind: "capture" }
  | {
      readonly kind: "chosen";
      /** `null` is Latest, which follows the artifact's next save. */
      readonly version: HtmlArtifactVersionSelection | null;
    };

const CAPTURE: CardPick = { kind: "capture" };

interface ShownCardVersion {
  /** The version as the picker reads it: `null` is the current version. */
  readonly selected: HtmlArtifactVersionSelection | null;
  readonly manifest: ArtifactManifest;
  /** `null` serves the artifact's own entry page. */
  readonly entryPath: string | null;
  /**
   * Whether the page reaches the task's other artifacts as they are now. A
   * capture or an older version shows the page as it was, so it does not.
   */
  readonly outsideReferences: boolean;
}

function shownCardVersion(
  state: ArtifactRowState,
  stamp: ToolCallArtifactStamp,
  location: ArtifactLocation | null,
  pick: CardPick,
): ShownCardVersion | null {
  if (!("manifest" in state) || location === null) return null;
  // A capture whose bytes are gone shows the current version instead.
  const capture: ShownCardVersion =
    state.kind === "latest"
      ? {
          selected: null,
          manifest: state.manifest,
          entryPath: null,
          outsideReferences: true,
        }
      : {
          selected: selectedHtmlVersion(
            {
              manifest: {
                files: stamp.manifest.files,
                capturedAt: stamp.manifest.capturedAt,
              },
              entryPath: location.entryPath,
            },
            location.artifact,
          ),
          manifest: state.manifest,
          entryPath: null,
          outsideReferences: false,
        };
  if (pick.kind === "capture") return capture;
  if (pick.version === null) {
    const head = location.artifact.head;
    return head === undefined
      ? capture
      : {
          selected: null,
          manifest: head,
          entryPath: null,
          outsideReferences: true,
        };
  }
  const selected = selectedHtmlVersion(pick.version, location.artifact);
  return {
    selected,
    manifest: pick.version.manifest,
    entryPath: pick.version.entryPath,
    outsideReferences: selected === null,
  };
}

function ShownArtifact(props: {
  readonly stamp: ToolCallArtifactStamp;
  readonly scope: ChatAttachmentScopeValue;
}) {
  const { stamp, scope } = props;
  const viewTabId = useEpicViewTabId();
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
  // Held by this mounted card alone: a card that scrolls away and back opens
  // on its capture again.
  const [pick, setPick] = useState<CardPick>(CAPTURE);
  const pickVersion = useCallback(
    (version: HtmlArtifactVersionSelection | null): void => {
      setPick({ kind: "chosen", version });
    },
    [],
  );
  const record = resolved?.artifact ?? null;
  const state = selectArtifactRowState(
    stamp,
    record,
    missingManifest !== null &&
      artifactManifestsEqual(missingManifest, stampedManifest),
    confirmedDeleted,
  );
  const shown = shownCardVersion(state, stamp, resolved, pick);
  const source = useCardSource({
    artifactId: stamp.artifactId,
    scope,
    artifacts,
    stampedManifest,
    shown,
    location: resolved,
    onCaptureMissing: setMissingManifest,
  });
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
      <CardPage
        key={generation}
        stamp={stamp}
        scope={scope}
        viewTabId={viewTabId}
        artifact={record}
        source={source}
        selected={shown?.selected ?? null}
        captureMissing={state.kind === "latest"}
        pick={pick}
        height={height}
        onSize={handleSize}
        onStatus={handleStatus}
        onPick={pickVersion}
      />
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

type ArtifactFrameSource = Extract<SandboxSource, { kind: "artifact" }>;

/**
 * The frame's source for the version on show, read through the card's host;
 * `null` while there is nothing to show. A read that finds one of the
 * capture's own files gone tells `onCaptureMissing`.
 */
function useCardSource(props: {
  readonly artifactId: string;
  readonly scope: ChatAttachmentScopeValue;
  readonly artifacts: ArtifactsSlice;
  readonly stampedManifest: ArtifactManifest | null;
  readonly shown: ShownCardVersion | null;
  readonly location: ArtifactLocation | null;
  readonly onCaptureMissing: (manifest: ArtifactManifest | null) => void;
}): ArtifactFrameSource | null {
  const { artifactId, scope, stampedManifest, onCaptureMissing } = props;
  const manifest = useStableManifest(props.shown?.manifest ?? null);
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
        onCaptureMissing(stampedManifest);
      }
      return result;
    };
  }, [scope.client, scope.epicId, stampedManifest, onCaptureMissing]);
  const resolveOutsideReference = useStableOutsideReferenceResolver(
    props.artifacts,
  );
  const outsideReferences = props.shown?.outsideReferences ?? false;
  const treePath = props.location?.treePath;
  const entryPath = props.shown?.entryPath ?? props.location?.entryPath;
  return useMemo<ArtifactFrameSource | null>(() => {
    if (manifest === null || treePath === undefined || entryPath === undefined)
      return null;
    return {
      kind: "artifact",
      artifactId,
      manifest,
      treePath,
      entryPath,
      readSpan,
      resolveOutsideReference: outsideReferences
        ? resolveOutsideReference
        : NO_OUTSIDE_REFERENCE,
    };
  }, [
    treePath,
    entryPath,
    artifactId,
    manifest,
    readSpan,
    resolveOutsideReference,
    outsideReferences,
  ]);
}

/**
 * The page on show with the card's controls. In a task view the card carries
 * the tile's version picker; outside one there is no version history and
 * nowhere for a comment to go, so it is the plain page with its actions.
 */
function CardPage(props: {
  readonly stamp: ToolCallArtifactStamp;
  readonly scope: ChatAttachmentScopeValue;
  readonly viewTabId: string | null;
  readonly artifact: ArtifactProjection | null;
  readonly source: ArtifactFrameSource;
  /** The version on show as the picker reads it: `null` is the current one. */
  readonly selected: HtmlArtifactVersionSelection | null;
  /** The capture's bytes are gone, so the card stands in the current version. */
  readonly captureMissing: boolean;
  readonly pick: CardPick;
  readonly height: number;
  readonly onSize: (size: SandboxSize) => void;
  readonly onStatus: (status: SandboxStatus) => void;
  readonly onPick: (version: HtmlArtifactVersionSelection | null) => void;
}) {
  const { stamp, scope, viewTabId, source, selected } = props;
  const caption =
    props.captureMissing && props.pick.kind === "capture" ? (
      <figcaption className="mb-2 text-ui-xs text-muted-foreground">
        Showing latest
      </figcaption>
    ) : null;
  const actions = (
    <InlineArtifactActions
      source={source}
      scope={scope}
      title={stamp.title}
      htmlVersion={selected}
    />
  );
  const picker = (
    <CardVersionPicker
      epicId={scope.epicId}
      artifactId={stamp.artifactId}
      artifact={props.artifact}
      shown={selected}
      onPick={props.onPick}
    />
  );
  // Comments anchor to the live page, as in the tile: only the version the
  // artifact serves now takes one, and an older one keeps the toggle in its
  // place, unavailable.
  if (viewTabId !== null && selected === null) {
    return (
      <HtmlArtifactLinks epicId={scope.epicId} viewTabId={viewTabId}>
        <HtmlArtifactCommentSurface
          epicId={scope.epicId}
          artifactId={stamp.artifactId}
          artifactTitle={stamp.title}
          hostId={scope.hostId}
          viewTabId={viewTabId}
          source={source}
          caption={caption}
          height={props.height}
          className="w-full"
          onSize={props.onSize}
          onStatus={props.onStatus}
          toolbarControls={
            <>
              {picker}
              {actions}
            </>
          }
          menuItems={undefined}
          raiseToComment
        />
      </HtmlArtifactLinks>
    );
  }
  return (
    <ArtifactExpansion title={stamp.title}>
      {caption}
      <HtmlArtifactLinks epicId={scope.epicId} viewTabId={viewTabId}>
        <ArtifactPagesFrame
          source={source}
          title={stamp.title}
          className="w-full"
          height={props.height}
          commenting={false}
          onCommentPage={null}
          onSize={props.onSize}
          onStatus={props.onStatus}
          onBridge={null}
          onTextSelection={null}
          onFrame={null}
          overlay={null}
          sourceEquivalent={undefined}
          toolbarControls={
            viewTabId === null ? (
              actions
            ) : (
              <>
                {picker}
                {actions}
                <HtmlArtifactOlderVersionComments viewTabId={viewTabId} />
              </>
            )
          }
        />
      </HtmlArtifactLinks>
    </ArtifactExpansion>
  );
}

/** The tile's version picker, over the version this card holds. */
function CardVersionPicker(props: {
  readonly epicId: string;
  readonly artifactId: string;
  readonly artifact: ArtifactProjection | null;
  readonly shown: HtmlArtifactVersionSelection | null;
  readonly onPick: (version: HtmlArtifactVersionSelection | null) => void;
}) {
  const version = useHtmlArtifactVersion({
    epicId: props.epicId,
    artifactId: props.artifactId,
    artifact: props.artifact,
    pinned: props.shown,
    onSelect: props.onPick,
  });
  return <HtmlArtifactVersionPicker version={version} />;
}

function InlineArtifactActions(props: {
  readonly source: Extract<SandboxSource, { kind: "artifact" }>;
  readonly scope: ChatAttachmentScopeValue;
  readonly title: string;
  /**
   * The version Open in panel opens the tile on: the one this card shows, or
   * `null` (Latest) when that is the artifact's current version, so the tile
   * reads as Latest and follows the next save instead of freezing on the
   * bundle that happened to be current at the click.
   */
  readonly htmlVersion: HtmlArtifactVersionSelection | null;
}) {
  const { openTile } = useEpicTileNavigation();
  const coarsePointer = useCoarsePointer();
  return (
    <>
      <HtmlArtifactDownloadButton
        source={props.source}
        title={props.title}
        hostId={props.scope.hostId}
      />
      <TooltipWrapper
        label="Open in panel"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          type="button"
          variant="ghost"
          size={coarsePointer ? "icon-touch" : "icon-sm"}
          aria-label="Open in panel"
          onClick={() => {
            openTile(
              {
                node: {
                  id: props.source.artifactId,
                  instanceId: crypto.randomUUID(),
                  type: "html",
                  name: props.title,
                  hostId: props.scope.hostId,
                  ...(props.htmlVersion === null
                    ? {}
                    : { htmlVersion: props.htmlVersion }),
                },
                target: { epicId: props.scope.epicId },
                gesture: "explicit",
                modifiers: null,
                placement: null,
                // One tile per artifact, like every other opener. A tile that
                // is already open adopts this card's version on the hit, Latest
                // included (`executeTileOpen`), so it shows what the card shows.
                dedupe: true,
                source: "direct_ui",
                adoptHtmlVersion: true,
              },
              "user",
            );
          }}
        >
          <PanelsTopLeft className="size-4" />
        </Button>
      </TooltipWrapper>
    </>
  );
}
