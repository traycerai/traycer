import { anyAbortSignal } from "@traycer-clients/shared/auth/request-abort";
import {
  createContext,
  use,
  useContext,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { PanelsTopLeft } from "lucide-react";
import { ArtifactExpansion } from "@/components/artifacts/artifact-expansion";
import { useArtifactExpanded } from "@/components/artifacts/artifact-expanded-context";
import type { ToolCallArtifactStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import type { HtmlArtifactVersionSelection } from "@traycer/protocol/host/epic/html-artifact-versions";
import {
  useChatAttachmentScope,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { ArtifactPagesFrame } from "@/components/html-artifact/artifact-pages-frame";
import { HtmlArtifactCommentSurface } from "@/components/html-artifact/html-artifact-comment-surface";
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
import {
  NO_OUTSIDE_REFERENCE,
  resolveManifestPath,
} from "@/lib/sandbox/artifact-serving";
import {
  createHostObjectReader,
  type ArtifactObjectRequest,
} from "@/lib/sandbox/artifact-serving/host-object-reader";
import {
  artifactReadIsCurrent,
  assertArtifactReadLive,
  type ArtifactReadLifetime,
} from "@/lib/artifacts/artifact-read-lifetime";
import type { SandboxSize, SandboxStatus } from "@/lib/sandbox/bridge-host";
import {
  artifactManifestsEqual,
  selectArtifactRowState,
  type ArtifactRowState,
} from "./artifact-row-state";
import { LiveArtifactPresentationContext } from "./live-artifact-presentation-context";

const NO_PREVIEW_COPY = "No preview.";
export const SHOW_PREVIEW_COPY = "Show preview";
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
  const resolveOutsideReference = useStableOutsideReferenceResolver(artifacts);
  const source = useCardSource({
    artifactId: stamp.artifactId,
    scope,
    resolveOutsideReference,
    lifetime: null,
    onUnavailable: null,
    stampedManifest,
    shown,
    location: resolved,
    onCaptureMissing: setMissingManifest,
  });
  let frameState: "ready" | "deleted" | "pending" | "unavailable" = "ready";
  if (state.kind === "deleted") frameState = "deleted";
  else if (state.kind === "pending" || scope.client === null)
    frameState = "pending";
  else if (source === null) frameState = "unavailable";
  return (
    <ArtifactCardFrame
      title={stamp.title}
      state={frameState}
      source={source}
      lifetime={null}
      onRetry={null}
    >
      {source === null ? null : (
        <CardPage
          artifactId={stamp.artifactId}
          title={stamp.title}
          scope={scope}
          viewTabId={viewTabId}
          artifact={record}
          source={source}
          selected={shown?.selected ?? null}
          captureMissing={state.kind === "latest"}
          pick={pick}
          onPick={pickVersion}
        />
      )}
    </ArtifactCardFrame>
  );
}

type ArtifactFrameSource = Extract<SandboxSource, { kind: "artifact" }>;

interface CardFrameLayout {
  readonly height: number;
  readonly onSize: (size: SandboxSize) => void;
  readonly onStatus: (status: SandboxStatus) => void;
}

const CardFrameLayoutContext = createContext<CardFrameLayout | null>(null);

function useCardFrameLayout(): CardFrameLayout {
  const layout = useContext(CardFrameLayoutContext);
  if (layout === null) throw new Error("Artifact page needs its frame layout");
  return layout;
}

function ArtifactCardFrame(props: {
  readonly title: string;
  readonly state:
    | "pending"
    | "deleted"
    | "unavailable"
    | "no-preview"
    | "anchor"
    | "ready";
  readonly source: ArtifactFrameSource | null;
  readonly lifetime: ArtifactReadLifetime | null;
  readonly onRetry: (() => void) | null;
  readonly children: ReactNode;
}): ReactNode {
  const { source, lifetime } = props;
  const [height, setHeight] = useState(MIN_PAGE_HEIGHT_PX);
  const [crashedSource, setCrashedSource] = useState<SandboxSource | null>(
    null,
  );
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const currentSource = useRef(source);
  useLayoutEffect(() => {
    currentSource.current = source;
    return () => {
      currentSource.current = null;
    };
  }, [source]);
  const handleStatus = useCallback(
    (status: SandboxStatus): void => {
      if (
        lifetime !== null &&
        (!artifactReadIsCurrent(lifetime) || currentSource.current !== source)
      )
        return;
      if (status === "crashed") setCrashedSource(source);
    },
    [lifetime, source],
  );
  const handleSize = useCallback(
    (size: SandboxSize): void => {
      if (
        lifetime !== null &&
        (!artifactReadIsCurrent(lifetime) || currentSource.current !== source)
      )
        return;
      if (size.height === null) return;
      setHeight(
        Math.min(MAX_PAGE_HEIGHT_PX, Math.max(MIN_PAGE_HEIGHT_PX, size.height)),
      );
    },
    [lifetime, source],
  );
  let content: ReactNode;
  if (props.state === "deleted") {
    content = (
      <div className="p-4 text-ui-sm text-muted-foreground">
        This artifact was deleted.
      </div>
    );
  } else if (props.state === "pending") {
    // A live row keeps its authored title while it is admitted; a captured
    // card's page (its children) waits for the host instead.
    content = (
      <div className="flex flex-col items-start gap-2 p-4 text-ui-sm text-muted-foreground">
        {source === null ? props.children : null}
        <span>Loading artifact</span>
      </div>
    );
  } else if (props.state === "no-preview") {
    content = (
      <div className="flex flex-col items-start gap-2 p-4 text-ui-sm text-muted-foreground">
        <span>{props.title}</span>
        <span>{NO_PREVIEW_COPY}</span>
        {props.children}
      </div>
    );
  } else if (props.state === "anchor") {
    content = (
      <div className="flex flex-col items-start gap-2 p-4 text-ui-sm text-muted-foreground">
        <span>{props.title}</span>
        {props.children}
      </div>
    );
  } else if (props.state === "unavailable" || source === null) {
    content =
      props.onRetry === null ? (
        <div className="p-4 text-ui-sm text-muted-foreground">
          Artifact unavailable.
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2 p-4 text-ui-sm text-muted-foreground">
          {props.children}
          <span>Artifact unavailable.</span>
          <Button variant="outline" size="sm" onClick={props.onRetry}>
            Retry
          </Button>
        </div>
      );
  } else if (crashedSource === source) {
    content = (
      <div className="flex flex-col items-start gap-2 p-4 text-ui-sm text-muted-foreground">
        <span>This artifact stopped responding.</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (!artifactReadIsCurrent(lifetime)) return;
            setCrashedSource(null);
            setHeight(MIN_PAGE_HEIGHT_PX);
            setReloadGeneration((value) => value + 1);
          }}
        >
          Reload
        </Button>
      </div>
    );
  } else {
    content = (
      <CardFrameLayoutContext.Provider
        key={reloadGeneration}
        value={{
          height,
          onSize: handleSize,
          onStatus: handleStatus,
        }}
      >
        {props.children}
      </CardFrameLayoutContext.Provider>
    );
  }
  return (
    <figure
      aria-label={props.title === "" ? "Artifact" : `Artifact: ${props.title}`}
      data-testid="artifact-row"
      data-find-skip=""
      data-quote-exclude=""
      className="m-0 flex w-full flex-col"
    >
      {content}
    </figure>
  );
}

export interface LiveArtifactReadyInput {
  readonly kind: "ready";
  readonly artifactId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly title: string;
  readonly manifest: ArtifactManifest;
  readonly treePath: string;
  readonly entryPath: string;
  /** A new admission or explicit Retry, never an ordinary snapshot transition. */
  readonly readerGeneration: number;
  /** Authority/path re-resolution; a head save changes only manifest. */
  readonly sourceGeneration: number;
}

export type LiveArtifactCardInput =
  | LiveArtifactReadyInput
  | {
      readonly kind: "pending" | "deleted" | "unavailable" | "no-preview";
      readonly title: string;
    };

/**
 * A card that is not presenting its content: the authored title only, and the
 * explicit button where nothing can observe whether the card is in view.
 */
export function ArtifactRowAnchor(props: {
  readonly title: string;
  readonly onShowPreview: (() => void) | null;
}): ReactNode {
  return (
    <ArtifactCardFrame
      title={props.title}
      state="anchor"
      source={null}
      lifetime={null}
      onRetry={null}
    >
      {props.onShowPreview === null ? null : (
        <Button variant="outline" size="sm" onClick={props.onShowPreview}>
          {SHOW_PREVIEW_COPY}
        </Button>
      )}
    </ArtifactCardFrame>
  );
}

interface ArtifactReadClient {
  readonly requestWithSignal: ArtifactObjectRequest;
}

export type ArtifactReadScope =
  | { readonly hostId: string; readonly client: null }
  | {
      readonly hostId: string;
      readonly client: ArtifactReadClient;
      readonly lifetime: ArtifactReadLifetime;
    };

type LiveReadScope = Extract<ArtifactReadScope, { client: ArtifactReadClient }>;

function useArtifactReadLive(lifetime: ArtifactReadLifetime | null): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (lifetime === null) return () => undefined;
      lifetime.signal.addEventListener("abort", listener);
      return () => lifetime.signal.removeEventListener("abort", listener);
    },
    [lifetime],
  );
  const snapshot = useCallback(
    () => lifetime !== null && artifactReadIsCurrent(lifetime),
    [lifetime],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The provider owns admission. Only a ready input and its live, matching-host
 * reader construct a source. A missing entry stays unavailable for that reader
 * generation; Retry asks the provider to admit and resolve it again.
 */
export function LiveArtifactRow(props: {
  readonly artifact: LiveArtifactCardInput;
  readonly readScope: ArtifactReadScope;
  readonly onOpen: (() => void) | null;
  readonly onRetry: () => void;
}): ReactNode {
  const { artifact, readScope } = props;
  const lifetime = readScope.client === null ? null : readScope.lifetime;
  const live = useArtifactReadLive(lifetime);
  if (artifact.kind !== "ready") {
    const noPreview = artifact.kind === "no-preview";
    const state = noPreview && !live ? "unavailable" : artifact.kind;
    // Only a no-preview title is projected from the task; the other states
    // carry the provider's authored title, which outlives a withdrawn reader.
    const title = live || !noPreview ? artifact.title : "";
    let detail: ReactNode = null;
    if (noPreview && live) {
      detail = <ArtifactOpenButton onOpen={props.onOpen} lifetime={lifetime} />;
    } else if (!noPreview && title !== "") {
      detail = <span>{title}</span>;
    }
    return (
      <ArtifactCardFrame
        title={title}
        state={state}
        source={null}
        lifetime={lifetime}
        onRetry={state === "unavailable" ? props.onRetry : null}
      >
        {detail}
      </ArtifactCardFrame>
    );
  }
  if (
    !live ||
    readScope.client === null ||
    readScope.hostId !== artifact.hostId
  ) {
    return (
      <ArtifactCardFrame
        title=""
        state="unavailable"
        source={null}
        lifetime={null}
        onRetry={props.onRetry}
        children={null}
      />
    );
  }
  return (
    <LiveArtifactAdmission
      key={JSON.stringify([
        artifact.hostId,
        artifact.epicId,
        artifact.artifactId,
        artifact.readerGeneration,
      ])}
      artifact={artifact}
      scope={readScope}
      onOpen={props.onOpen}
      onRetry={props.onRetry}
    />
  );
}

function LiveArtifactAdmission(props: {
  readonly artifact: LiveArtifactReadyInput;
  readonly scope: LiveReadScope;
  readonly onOpen: (() => void) | null;
  readonly onRetry: () => void;
}): ReactNode {
  // The entry object that missed, by hash: the provider latches only the
  // entry it still publishes, not a head that committed after the miss.
  const [missedEntry, setMissedEntry] = useState<string | null>(null);
  const refuse = useCallback((sha256: string) => setMissedEntry(sha256), []);
  const presentation = use(LiveArtifactPresentationContext);
  const reportMissing = useEffectEvent((sha256: string) => {
    presentation?.reportEntryMissing(props.artifact, sha256);
  });
  useEffect(() => {
    if (missedEntry !== null) reportMissing(missedEntry);
  }, [missedEntry]);
  if (missedEntry !== null) {
    return (
      <ArtifactCardFrame
        title={props.artifact.title}
        state="unavailable"
        source={null}
        lifetime={props.scope.lifetime}
        onRetry={props.onRetry}
        children={null}
      />
    );
  }
  return (
    <ReadyLiveArtifact
      key={JSON.stringify([
        props.artifact.sourceGeneration,
        props.artifact.treePath,
        props.artifact.entryPath,
      ])}
      {...props}
      onUnavailable={refuse}
    />
  );
}

function ReadyLiveArtifact(props: {
  readonly artifact: LiveArtifactReadyInput;
  readonly scope: LiveReadScope;
  readonly onOpen: (() => void) | null;
  readonly onRetry: () => void;
  readonly onUnavailable: (sha256: string) => void;
}): ReactNode {
  const { artifact, scope } = props;
  const source = useCardSource({
    artifactId: artifact.artifactId,
    scope: { epicId: artifact.epicId, client: scope.client },
    stampedManifest: null,
    shown: {
      manifest: artifact.manifest,
      entryPath: artifact.entryPath,
      outsideReferences: false,
    },
    location: { treePath: artifact.treePath, entryPath: artifact.entryPath },
    resolveOutsideReference: NO_OUTSIDE_REFERENCE,
    onCaptureMissing: null,
    lifetime: scope.lifetime,
    onUnavailable: props.onUnavailable,
  });
  return (
    <ArtifactCardFrame
      title={artifact.title}
      state={source === null ? "unavailable" : "ready"}
      source={source}
      lifetime={scope.lifetime}
      onRetry={props.onRetry}
    >
      {source === null ? null : (
        <PlainCardPage
          title={artifact.title}
          source={source}
          caption={null}
          actions={
            <InlineArtifactActions
              source={source}
              title={artifact.title}
              hostId={artifact.hostId}
              lifetime={scope.lifetime}
              onOpen={props.onOpen}
            />
          }
        />
      )}
    </ArtifactCardFrame>
  );
}

/**
 * The admitted lifetime fences dispatch and completion. Authority retirement,
 * not a manifest update or frame unmount, cancels a frozen download.
 * Stable readSpan identity lets a comment's stamped-ID manifest be adopted by
 * a running page. Only a live entry miss latches the whole card unavailable.
 */
function useCardSource(props: {
  readonly artifactId: string;
  readonly scope: {
    readonly epicId: string;
    readonly client: ArtifactReadClient | null;
  };
  readonly stampedManifest: ArtifactManifest | null;
  readonly shown: Pick<
    ShownCardVersion,
    "manifest" | "entryPath" | "outsideReferences"
  > | null;
  readonly location: {
    readonly treePath: string;
    readonly entryPath: string;
  } | null;
  readonly resolveOutsideReference: ArtifactFrameSource["resolveOutsideReference"];
  readonly onCaptureMissing:
    | ((manifest: ArtifactManifest | null) => void)
    | null;
  readonly lifetime: ArtifactReadLifetime | null;
  readonly onUnavailable: ((sha256: string) => void) | null;
}): ArtifactFrameSource | null {
  const {
    artifactId,
    scope,
    stampedManifest,
    onCaptureMissing,
    lifetime,
    onUnavailable,
  } = props;
  const manifest = useStableManifest(props.shown?.manifest ?? null);
  const entryPath = props.shown?.entryPath ?? props.location?.entryPath;
  const entryHash = useRef<string | null>(null);
  useLayoutEffect(() => {
    entryHash.current =
      manifest === null || entryPath === undefined
        ? null
        : (resolveManifestPath(
            manifest,
            entryPath === "" ? "index.html" : entryPath,
          )?.sha256 ?? null);
  }, [manifest, entryPath]);
  const readSpan = useMemo<ArtifactReadSpan>(() => {
    const read = createHostObjectReader({
      epicId: scope.epicId,
      request: async (method, params, signal) => {
        assertArtifactReadLive(lifetime);
        if (scope.client === null)
          throw new Error("Artifact host is unavailable");
        const requestSignal =
          lifetime === null
            ? signal
            : anyAbortSignal([signal, lifetime.signal]);
        const response = await scope.client.requestWithSignal(
          method,
          params,
          requestSignal,
        );
        requestSignal.throwIfAborted();
        assertArtifactReadLive(lifetime);
        return response;
      },
    });
    const stampedHashes = new Set(
      Object.values(stampedManifest?.files ?? {}).map((entry) => entry.sha256),
    );
    return async (sha256, offset, length, signal) => {
      assertArtifactReadLive(lifetime);
      const result = await read(sha256, offset, length, signal);
      assertArtifactReadLive(lifetime);
      if ("unavailable" in result && result.unavailable === "missing") {
        if (stampedHashes.has(sha256)) onCaptureMissing?.(stampedManifest);
        if (sha256 === entryHash.current) onUnavailable?.(sha256);
      }
      return result;
    };
  }, [
    scope.client,
    scope.epicId,
    stampedManifest,
    onCaptureMissing,
    lifetime,
    onUnavailable,
  ]);
  const outsideReferences = props.shown?.outsideReferences ?? false;
  const treePath = props.location?.treePath;
  const resolveOutsideReference = props.resolveOutsideReference;
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
  readonly artifactId: string;
  readonly title: string;
  readonly scope: ChatAttachmentScopeValue;
  readonly viewTabId: string | null;
  readonly artifact: ArtifactProjection | null;
  readonly source: ArtifactFrameSource;
  /** The version on show as the picker reads it: `null` is the current one. */
  readonly selected: HtmlArtifactVersionSelection | null;
  /** The capture's bytes are gone, so the card stands in the current version. */
  readonly captureMissing: boolean;
  readonly pick: CardPick;
  readonly onPick: (version: HtmlArtifactVersionSelection | null) => void;
}) {
  const { artifactId, title, scope, viewTabId, source, selected } = props;
  const layout = useCardFrameLayout();
  const { openTile } = useEpicTileNavigation();
  const caption =
    props.captureMissing && props.pick.kind === "capture" ? (
      <figcaption className="mb-2 text-ui-xs text-muted-foreground">
        Showing latest
      </figcaption>
    ) : null;
  const actions = (
    <InlineArtifactActions
      source={source}
      hostId={scope.hostId}
      title={title}
      lifetime={null}
      onOpen={() => {
        // One tile per artifact: an existing tile adopts this card's version,
        // including Latest, through executeTileOpen.
        openTile(
          {
            node: {
              id: source.artifactId,
              instanceId: crypto.randomUUID(),
              type: "html",
              name: title,
              hostId: scope.hostId,
              // null is Latest, so the tile follows the next save.
              ...(selected === null ? {} : { htmlVersion: selected }),
            },
            target: { epicId: scope.epicId },
            gesture: "explicit",
            modifiers: null,
            placement: null,
            dedupe: true,
            source: "direct_ui",
            adoptHtmlVersion: true,
          },
          "user",
        );
      }}
    />
  );
  if (viewTabId !== null) {
    // One surface whatever version is on show, so moving between versions,
    // by a pick or by a save that leaves the capture behind, never takes down
    // the raise or a draft. Comments anchor to the live page, as in the tile:
    // only the version the artifact serves now takes one, and an older one
    // keeps the toggle in its place, unavailable.
    return (
      <HtmlArtifactLinks epicId={scope.epicId} viewTabId={viewTabId}>
        <HtmlArtifactCommentSurface
          epicId={scope.epicId}
          artifactId={artifactId}
          artifactTitle={title}
          hostId={scope.hostId}
          viewTabId={viewTabId}
          source={source}
          caption={caption}
          height={layout.height}
          className="w-full"
          onSize={layout.onSize}
          onStatus={layout.onStatus}
          toolbarControls={
            <>
              <CardVersionPicker
                epicId={scope.epicId}
                artifactId={artifactId}
                artifact={props.artifact}
                shown={selected}
                onPick={props.onPick}
              />
              {actions}
            </>
          }
          menuItems={undefined}
          raiseToComment
          commentable={selected === null}
        />
      </HtmlArtifactLinks>
    );
  }
  return (
    <HtmlArtifactLinks epicId={scope.epicId} viewTabId={null}>
      <PlainCardPage
        title={title}
        source={source}
        caption={caption}
        actions={actions}
      />
    </HtmlArtifactLinks>
  );
}

function PlainCardPage(props: {
  readonly title: string;
  readonly source: ArtifactFrameSource;
  readonly caption: ReactNode;
  readonly actions: ReactNode;
}): ReactNode {
  const layout = useCardFrameLayout();
  return (
    <ArtifactExpansion title={props.title} commentsInline>
      <ArtifactRaiseReporter />
      {props.caption}
      <ArtifactPagesFrame
        source={props.source}
        title={props.title}
        className="w-full"
        height={layout.height}
        commenting={false}
        onCommentPage={null}
        onSize={layout.onSize}
        onStatus={layout.onStatus}
        onBridge={null}
        onTextSelection={null}
        onFrame={null}
        overlay={null}
        sourceEquivalent={undefined}
        toolbarControls={props.actions}
      />
    </ArtifactExpansion>
  );
}

/**
 * Tells a live card's provider when its surface is raised or lowered, and when
 * the surface leaves. Transitions only: a surface that mounts inline reports
 * nothing, so a provider's remembered raise survives a surface remount.
 */
function ArtifactRaiseReporter(): null {
  const report = use(LiveArtifactPresentationContext)?.reportRaise ?? null;
  const expanded = useArtifactExpanded();
  const reported = useRef(false);
  useLayoutEffect(() => {
    if (report === null || reported.current === expanded) return;
    reported.current = expanded;
    report(expanded ? "raised" : "lowered");
  }, [expanded, report]);
  useLayoutEffect(() => {
    if (report === null) return;
    return () => report("gone");
  }, [report]);
  return null;
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
  readonly source: ArtifactFrameSource;
  readonly hostId: string;
  readonly title: string;
  readonly lifetime: ArtifactReadLifetime | null;
  readonly onOpen: (() => void) | null;
}): ReactNode {
  return (
    <>
      <HtmlArtifactDownloadButton
        source={props.source}
        title={props.title}
        hostId={props.hostId}
        lifetime={props.lifetime}
      />
      <ArtifactOpenButton onOpen={props.onOpen} lifetime={props.lifetime} />
    </>
  );
}

function ArtifactOpenButton(props: {
  readonly onOpen: (() => void) | null;
  readonly lifetime: ArtifactReadLifetime | null;
}): ReactNode {
  const coarsePointer = useCoarsePointer();
  if (props.onOpen === null) return null;
  return (
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
          if (!artifactReadIsCurrent(props.lifetime)) return;
          props.onOpen?.();
        }}
      >
        <PanelsTopLeft className="size-4" />
      </Button>
    </TooltipWrapper>
  );
}
