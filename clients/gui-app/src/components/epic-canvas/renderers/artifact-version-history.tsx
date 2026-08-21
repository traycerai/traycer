import { useRef, useState, type ReactNode } from "react";
import {
  AlertTriangleIcon,
  HistoryIcon,
  InfoIcon,
  Maximize2Icon,
  Minimize2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import type {
  ArtifactVersionObservationEntry,
  ArtifactVersionsRestoreResponse,
} from "@traycer/protocol/host/epic/artifact-versions";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { ArtifactVersionHistoryErrorBoundary } from "@/components/epic-canvas/renderers/artifact-version-history-error-boundary";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";
import { buildSnapshotUnifiedPatch } from "@/lib/diff/snapshot-diff-patch";
import {
  pointerDragHandleAxisClassName,
  usePointerDragCommit,
} from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import {
  DEFAULT_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
  MAX_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
  MIN_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
  useArtifactVersionHistoryPanelStore,
  useArtifactVersionHistoryPanelWidthPx,
} from "@/stores/epics/artifact-version-history-panel-store";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useArtifactVersionHistoryAvailable } from "@/hooks/epic/use-artifact-version-history-available";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { epicNodeRefForNodeId } from "@/lib/epic-selectors";
import { epicMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";

interface RestorePreflight {
  readonly imagesMissing: readonly string[];
  readonly threadCount: number;
  readonly currentHash: string;
}

interface OutcomeNotice {
  readonly status: "clean" | "renormalized" | "degraded";
  readonly observationId: string;
}

interface HistoryPagination {
  readonly queryUpdatedAt: number;
  readonly entries: readonly ArtifactVersionObservationEntry[];
  readonly nextCursor: string | null;
}

const RESTORE_UNAVAILABLE_COPY: Readonly<
  Record<
    Extract<ArtifactVersionsRestoreResponse, { kind: "unavailable" }>["reason"],
    string
  >
> = {
  storage_full: "The host has no room to create the new version.",
  journal_cap: "The host's recovery journal is full.",
  target_not_found: "This version is no longer in history.",
  missing_blob: "The saved body for this version is missing.",
  artifact_not_live: "This artifact is no longer live.",
  kind_mismatch: "This version belongs to a different artifact kind.",
  body_unavailable: "The artifact body is currently unavailable.",
  missing_images: "Some referenced images are missing.",
};

const PROVENANCE_LABELS: Readonly<
  Record<ArtifactVersionObservationEntry["provenance"]["kind"], string>
> = {
  agent: "Agent edit",
  user_session: "Your edit",
  multiple_agents: "Several agents",
  external: "External edit",
  system: "System capture",
  remote_merge: "Remote merge",
  restore: "Restored version",
  revive: "Restored artifact",
  delete: "Deleted",
  clobber: "Recovered overwrite",
};

const CAPTURED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function formatCapturedAt(value: number): string {
  return CAPTURED_AT_FORMATTER.format(value);
}

function formatCapturedTime(value: number): string {
  return TIME_FORMATTER.format(value);
}

function dayLabel(value: number): string {
  return DAY_FORMATTER.format(value);
}

type Provenance = ArtifactVersionObservationEntry["provenance"];

function userSessionDetail(
  provenance: Extract<Provenance, { readonly kind: "user_session" }>,
): string {
  return provenance.hostId === undefined
    ? `User ${provenance.userId}`
    : `User ${provenance.userId} · host ${provenance.hostId}`;
}

function multipleAgentsDetail(
  provenance: Extract<Provenance, { readonly kind: "multiple_agents" }>,
): string {
  if (provenance.agents.length === 0) return "Several agents";
  return provenance.agents
    .map((agent) => agent.chatTitle ?? agent.chatId)
    .join(", ");
}

function externalDetail(
  provenance: Extract<Provenance, { readonly kind: "external" }>,
): string {
  const count = provenance.attemptedAgentWrites.length;
  if (count === 0) return "External edit";
  const noun = count === 1 ? "write" : "writes";
  return `${count} attempted agent ${noun}`;
}

function restoreDetail(
  provenance: Extract<Provenance, { readonly kind: "restore" }>,
): string {
  return provenance.restoredFromObservationId === null
    ? "Restored from an earlier version."
    : `Restored from version ${provenance.restoredFromObservationId}.`;
}

function reviveDetail(
  provenance: Extract<Provenance, { readonly kind: "revive" }>,
): string {
  return provenance.deletionEventId === null
    ? "Restored after deletion."
    : `Restored after deletion event ${provenance.deletionEventId}.`;
}

function deleteDetail(
  provenance: Extract<Provenance, { readonly kind: "delete" }>,
): string | null {
  const actor = provenance.actorKind?.replaceAll("_", " ") ?? null;
  if (actor === null) {
    return provenance.deleteOpId === null
      ? null
      : `Deleted · operation ${provenance.deleteOpId}`;
  }
  return provenance.deleteOpId === null
    ? `Deleted by ${actor}`
    : `Deleted by ${actor} · operation ${provenance.deleteOpId}`;
}

function provenanceDetailText(provenance: Provenance): string | null {
  switch (provenance.kind) {
    case "agent":
      return null;
    case "user_session":
      return userSessionDetail(provenance);
    case "multiple_agents":
      return multipleAgentsDetail(provenance);
    case "external":
      return externalDetail(provenance);
    case "system":
      return provenance.originalActorHint ?? provenance.trigger;
    case "remote_merge":
      return null;
    case "restore":
      return restoreDetail(provenance);
    case "revive":
      return reviveDetail(provenance);
    case "delete":
      return deleteDetail(provenance);
    case "clobber":
      return provenance.source;
  }
}

type AgentProvenance = Extract<
  ArtifactVersionObservationEntry["provenance"],
  { readonly kind: "agent" }
>;

function AgentProvenanceDetail(props: {
  readonly provenance: AgentProvenance;
  readonly onOpenChat: (chatId: string) => void;
}): ReactNode {
  return (
    <p className="px-3 pb-3 text-ui-xs text-muted-foreground">
      Agent ·{" "}
      {props.provenance.chatTitle === null ? (
        <span className="font-mono">{props.provenance.chatId}</span>
      ) : (
        <button
          type="button"
          className="font-medium underline underline-offset-2 hover:text-foreground"
          aria-label={`Open chat ${props.provenance.chatTitle}`}
          onClick={() => props.onOpenChat(props.provenance.chatId)}
        >
          {props.provenance.chatTitle}
        </button>
      )}{" "}
      · turn {props.provenance.turnId}
    </p>
  );
}

function ObservationProvenanceDetail(props: {
  readonly provenance: Provenance;
  readonly onOpenChat: (chatId: string) => void;
}): ReactNode {
  if (props.provenance.kind === "agent") {
    return (
      <AgentProvenanceDetail
        provenance={props.provenance}
        onOpenChat={props.onOpenChat}
      />
    );
  }
  const detail = provenanceDetailText(props.provenance);
  if (detail === null) return null;
  return <p className="px-3 pb-3 text-ui-xs text-muted-foreground">{detail}</p>;
}

function comparisonFor(
  entries: readonly ArtifactVersionObservationEntry[],
  selected: ArtifactVersionObservationEntry | null,
): {
  readonly entry: ArtifactVersionObservationEntry;
  readonly label: string;
} | null {
  if (selected === null) return null;
  if (selected.parentContentHash !== null) {
    const parent = entries.find(
      (entry) =>
        entry.available && entry.contentHash === selected.parentContentHash,
    );
    if (parent !== undefined)
      return { entry: parent, label: "Compared with parent version" };
  }
  const index = entries.findIndex(
    (entry) => entry.observationId === selected.observationId,
  );
  const previous = entries.slice(index + 1).find((entry) => entry.available);
  return previous === undefined
    ? null
    : { entry: previous, label: "Compared with previous entry" };
}

function mergeObservationPages(
  ...pages: ReadonlyArray<readonly ArtifactVersionObservationEntry[]>
): ArtifactVersionObservationEntry[] {
  const seen = new Set<string>();
  const merged: ArtifactVersionObservationEntry[] = [];
  for (const page of pages) {
    for (const entry of page) {
      if (seen.has(entry.observationId)) continue;
      seen.add(entry.observationId);
      merged.push(entry);
    }
  }
  return merged;
}

export function ArtifactVersionHistoryEntryPoint(props: {
  readonly artifactId: string;
}): ReactNode {
  return (
    <ArtifactVersionHistoryErrorBoundary>
      <ArtifactVersionHistoryEntryPointContent artifactId={props.artifactId} />
    </ArtifactVersionHistoryErrorBoundary>
  );
}

function ArtifactVersionHistoryEntryPointContent(props: {
  readonly artifactId: string;
}): ReactNode {
  const available = useArtifactVersionHistoryAvailable();
  const openEpicHandle = useMaybeOpenEpicHandle();
  const hostId = useTabHostId();
  const client = useTabHostClient();
  const [open, setOpen] = useState(false);

  if (!available || openEpicHandle === null) return null;

  if (!open) {
    return (
      <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center">
        <span className="pointer-events-auto flex shrink-0 items-center rounded-md border border-border/60 bg-canvas/80 px-0.5 shadow-sm backdrop-blur-sm">
          <TooltipWrapper
            label="Version history"
            side="bottom"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              aria-label="Version history"
              data-testid="artifact-version-history-entry"
              onClick={() => setOpen(true)}
            >
              <HistoryIcon className="size-3.5" />
            </Button>
          </TooltipWrapper>
        </span>
      </div>
    );
  }

  return (
    <ArtifactVersionHistoryPanel
      artifactId={props.artifactId}
      epicId={openEpicHandle.epicId}
      hostId={hostId}
      client={client}
      openEpicHandle={openEpicHandle}
      onClose={() => setOpen(false)}
    />
  );
}

// This coordinates the restore union and both panel modes as one state machine.
// eslint-disable-next-line complexity
function ArtifactVersionHistoryPanel(props: {
  readonly onClose: () => void;
  readonly artifactId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly openEpicHandle: OpenEpicStoreHandle;
}): ReactNode {
  const tileNavigation = useEpicTileNavigation();
  const viewTabId = useEpicViewTabId();
  const [maximized, setMaximized] = useState(false);
  const panelWidthPx = useArtifactVersionHistoryPanelWidthPx();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] =
    useState<ArtifactVersionObservationEntry | null>(null);
  const [preflight, setPreflight] = useState<RestorePreflight | null>(null);
  const [preflightRefreshing, setPreflightRefreshing] = useState(false);
  const [preflightFailed, setPreflightFailed] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OutcomeNotice | null>(null);
  const [pagination, setPagination] = useState<HistoryPagination | null>(null);

  const history = useHostQuery({
    client: props.client,
    method: "epic.artifactVersions.list",
    params: {
      epicId: props.epicId,
      artifactId: props.artifactId,
      limit: 200,
    },
    cacheKeyIdentity: undefined,
    options: { enabled: true },
  });
  const settings = useHostQuery({
    client: props.client,
    method: "epic.artifactVersionSettings.get",
    params: {},
    cacheKeyIdentity: undefined,
    options: { enabled: true },
  });
  const loadOlder = useHostScopedMutationForClient(props.client, {
    method: "epic.artifactVersions.list",
    mutationKey: epicMutationKeys.loadOlderArtifactVersions(),
    errorMessage: "Couldn't load older versions",
    invalidateMethods: [],
    onSuccess: (response) => {
      setPagination((current) => ({
        queryUpdatedAt: history.dataUpdatedAt,
        entries: mergeObservationPages(
          history.data?.entries ?? [],
          current?.queryUpdatedAt === history.dataUpdatedAt
            ? current.entries
            : [],
          response.entries,
        ),
        nextCursor: response.nextCursor,
      }));
    },
  });

  const currentPagination =
    pagination?.queryUpdatedAt === history.dataUpdatedAt ? pagination : null;
  const entries = mergeObservationPages(
    history.data?.entries ?? [],
    currentPagination?.entries ?? [],
  );
  const nextCursor =
    currentPagination === null
      ? (history.data?.nextCursor ?? null)
      : currentPagination.nextCursor;
  const availableEntries = entries.filter((entry) => entry.available);
  const unavailableCount = entries.length - availableEntries.length;
  const selected =
    entries.find((entry) => entry.observationId === selectedId) ??
    availableEntries.at(0) ??
    null;
  const comparison = comparisonFor(entries, selected);
  const selectedBlob = useHostQuery({
    client: props.client,
    method: "epic.artifactVersions.getBlob",
    params: {
      epicId: props.epicId,
      artifactId: props.artifactId,
      observationId: selected?.observationId ?? "unselected",
    },
    cacheKeyIdentity:
      selected?.contentHash === undefined ? undefined : [selected.contentHash],
    options: {
      enabled: selected !== null && selected.available,
    },
  });
  const comparisonBlob = useHostQuery({
    client: props.client,
    method: "epic.artifactVersions.getBlob",
    params: {
      epicId: props.epicId,
      artifactId: props.artifactId,
      observationId: comparison?.entry.observationId ?? "unselected",
    },
    cacheKeyIdentity:
      comparison?.entry.contentHash === undefined
        ? undefined
        : [comparison.entry.contentHash],
    options: {
      enabled: comparison !== null,
    },
  });

  const restore = useHostScopedMutationForClient(props.client, {
    method: "epic.artifactVersions.restore",
    mutationKey: epicMutationKeys.restoreArtifactVersion(),
    errorMessage: "Couldn't restore this version",
    invalidateMethods: ["epic.artifactVersions.list"],
  });
  const queryClient = useQueryClient();

  const requestPreflight = (
    entry: ArtifactVersionObservationEntry,
    conflict: boolean,
  ): void => {
    setRestoreTarget(entry);
    setUnavailable(null);
    setPreflightFailed(false);
    setPreflightRefreshing(conflict);
    restore.mutate(
      {
        epicId: props.epicId,
        artifactId: props.artifactId,
        targetObservationId: entry.observationId,
        mode: "preflight",
      },
      {
        onSuccess: (response) => {
          setPreflightRefreshing(false);
          setPreflightFailed(false);
          if (response.kind === "preflight") {
            setPreflight(response);
            return;
          }
          if (response.kind === "unavailable") {
            setPreflight(null);
            setUnavailable(RESTORE_UNAVAILABLE_COPY[response.reason]);
          }
        },
        onError: () => {
          setPreflightRefreshing(false);
          setPreflight(null);
          setPreflightFailed(true);
          setUnavailable("Couldn't check the current artifact. Try again.");
        },
      },
    );
  };

  const executeRestore = (): void => {
    if (restoreTarget === null || preflight === null) return;
    restore.mutate(
      {
        epicId: props.epicId,
        artifactId: props.artifactId,
        targetObservationId: restoreTarget.observationId,
        mode: "execute",
        expectedCurrentHash: preflight.currentHash,
        bodyOnly: preflight.imagesMissing.length > 0,
      },
      {
        onSuccess: (response) => {
          if (response.kind === "conflict") {
            requestPreflight(restoreTarget, true);
            return;
          }
          if (response.kind === "unavailable") {
            setPreflightFailed(false);
            setUnavailable(RESTORE_UNAVAILABLE_COPY[response.reason]);
            return;
          }
          if (response.kind !== "outcome") return;
          setOutcome({
            status: response.status,
            observationId: response.newObservationId,
          });
          setSelectedId(response.newObservationId);
          setRestoreTarget(null);
          setPreflight(null);
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              props.hostId,
              "epic.artifactVersions.list",
            ),
          });
        },
      },
    );
  };

  const openProvenanceChat = (chatId: string): void => {
    if (viewTabId === null) return;
    const ref = epicNodeRefForNodeId(
      props.openEpicHandle.store.getState(),
      chatId,
      props.hostId,
    );
    if (ref === null) return;
    tileNavigation.openTilePreviewInTab(viewTabId, ref);
  };

  return (
    <>
      <aside
        aria-label="Version history"
        data-testid="artifact-version-history-panel"
        data-artifact-version-history-panel
        // User-adjustable width (drag the left edge), persisted across tiles;
        // the `70%` cap mirrors the handle's live-drag cap so the artifact
        // body always keeps space. Maximized covers the tile instead.
        className={cn(
          "flex min-w-0 shrink-0 flex-col border-l border-border bg-background",
          maximized
            ? "absolute inset-0 z-20 w-full border-l-0"
            : "relative max-w-[70%]",
        )}
        style={maximized ? undefined : { width: panelWidthPx }}
      >
        {maximized ? null : <ArtifactVersionHistoryPanelResizeHandle />}
        <header className="flex min-w-0 shrink-0 items-center gap-2 border-b px-2 py-1.5">
          <h2 className="min-w-0 flex-1 truncate px-1 text-ui-sm font-medium">
            Version history
          </h2>
          <div className="flex shrink-0 items-center gap-0.5">
            <TooltipWrapper
              label={maximized ? "Restore panel size" : "Maximize panel"}
              side="bottom"
              sideOffset={undefined}
              align={undefined}
            >
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={maximized ? "Restore panel size" : "Maximize panel"}
                data-testid="artifact-version-history-maximize"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setMaximized((current) => !current)}
              >
                {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
              </Button>
            </TooltipWrapper>
            <TooltipWrapper
              label="Close history"
              side="bottom"
              sideOffset={undefined}
              align={undefined}
            >
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Close history"
                data-testid="artifact-version-history-close"
                className="text-muted-foreground hover:text-foreground"
                onClick={props.onClose}
              >
                <XIcon />
              </Button>
            </TooltipWrapper>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(13rem,0.7fr)_minmax(0,1.3fr)] overflow-hidden">
          <div className="min-h-0 overflow-y-auto border-r">
            {settings.data?.settings.enabled === false ? (
              <div className="m-3 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-ui-sm">
                <p className="font-medium">
                  Version history is off — turn it on in Settings.
                </p>
                <p className="mt-1 text-muted-foreground">
                  Existing versions remain available below.
                </p>
              </div>
            ) : null}
            {history.isLoading ? (
              <p className="p-4 text-muted-foreground">Loading history…</p>
            ) : null}
            {history.isError ? (
              <div className="p-4">
                <p className="text-muted-foreground">
                  Couldn&apos;t load version history.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void history.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {!history.isLoading && !history.isError && entries.length === 0 ? (
              <p className="p-4 text-muted-foreground">
                No versions captured yet.
              </p>
            ) : null}
            <VersionObservationList
              entries={availableEntries}
              selectedId={selected === null ? null : selected.observationId}
              outcome={outcome}
              onSelect={setSelectedId}
              onOpenChat={openProvenanceChat}
            />
            {nextCursor === null ? null : (
              <div className="border-t p-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={loadOlder.isPending}
                  onClick={() =>
                    loadOlder.mutate({
                      epicId: props.epicId,
                      artifactId: props.artifactId,
                      cursor: nextCursor,
                      limit: 200,
                    })
                  }
                >
                  Load older versions
                </Button>
              </div>
            )}
            {unavailableCount > 0 ? (
              <p className="border-t p-3 text-ui-xs text-muted-foreground">
                {unavailableCount} older{" "}
                {unavailableCount === 1 ? "version is" : "versions are"}{" "}
                unavailable from this machine.
              </p>
            ) : null}
          </div>
          <VersionDiffView
            artifactId={props.artifactId}
            selected={selected}
            comparisonLabel={comparison?.label ?? null}
            comparisonObservationId={comparison?.entry.observationId ?? null}
            beforeMarkdown={
              comparison === null
                ? null
                : (comparisonBlob.data?.markdown ?? null)
            }
            afterMarkdown={selectedBlob.data?.markdown ?? null}
            loading={selectedBlob.isLoading || comparisonBlob.isLoading}
            failed={selectedBlob.isError || comparisonBlob.isError}
            outcome={outcome?.status ?? null}
            onRetry={() => {
              if (selectedBlob.isError) void selectedBlob.refetch();
              if (comparisonBlob.isError) void comparisonBlob.refetch();
            }}
            onRestore={() => {
              if (selected !== null) requestPreflight(selected, false);
            }}
          />
        </div>
      </aside>

      <RestoreVersionDialog
        target={restoreTarget}
        preflight={preflight}
        unavailable={unavailable}
        retryable={preflightFailed}
        refreshing={preflightRefreshing}
        pending={restore.isPending}
        onCancel={() => {
          setRestoreTarget(null);
          setPreflight(null);
          setPreflightFailed(false);
          setUnavailable(null);
        }}
        onRetry={() => {
          if (restoreTarget !== null) requestPreflight(restoreTarget, false);
        }}
        onConfirm={executeRestore}
      />
    </>
  );
}

interface PanelDragState {
  readonly startWidth: number;
  readonly maxWidth: number;
  readonly panelElement: HTMLElement;
  readonly initialStyleWidth: string;
  latestWidth: number;
}

/**
 * Live drag additionally caps the panel at 70% of the tile so the artifact
 * body always keeps space; the shell's render-time `max-w-[70%]` mirrors it.
 */
const MAX_PANEL_DRAG_FRACTION = 0.7;
const KEYBOARD_RESIZE_STEP_PX = 24;

function isHistoryPanelElement(
  element: Element | null,
): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.dataset.artifactVersionHistoryPanel !== undefined
  );
}

/**
 * Width handle on the panel's LEFT edge, on the shared `usePointerDragCommit`
 * state machine - the same mechanics as the comm-graph detail panel's handle:
 * the panel is docked RIGHT, so dragging left GROWS it and the grow arrow key
 * is ArrowLeft. Per-frame direct `style.width` mutation, one store commit on
 * release, double-click resets to the default width.
 */
function ArtifactVersionHistoryPanelResizeHandle() {
  const panelWidthPx = useArtifactVersionHistoryPanelWidthPx();
  const setPanelWidthPx = useArtifactVersionHistoryPanelStore(
    (s) => s.setPanelWidthPx,
  );
  const dragRef = useRef<PanelDragState | null>(null);

  const sliderProps = usePointerDragCommit({
    axis: "horizontal",
    onDragStart: (event) => {
      const panelElement = event.currentTarget.parentElement;
      const container = panelElement?.parentElement ?? null;
      if (!isHistoryPanelElement(panelElement) || container === null) {
        return false;
      }
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth <= 0) return false;
      const startWidth = panelElement.getBoundingClientRect().width;
      dragRef.current = {
        startWidth,
        maxWidth: Math.min(
          MAX_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
          containerWidth * MAX_PANEL_DRAG_FRACTION,
        ),
        panelElement,
        initialStyleWidth: panelElement.style.width,
        latestWidth: startWidth,
      };
      return true;
    },
    onDragFrame: (deltaPx) => {
      const drag = dragRef.current;
      if (drag === null) return;
      // Right-docked: the pointer moving LEFT (negative delta) grows the panel.
      const nextWidth = Math.min(
        drag.maxWidth,
        Math.max(
          MIN_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX,
          drag.startWidth - deltaPx,
        ),
      );
      drag.latestWidth = nextWidth;
      // Direct DOM mutation - zero React renders while the pointer moves.
      drag.panelElement.style.width = `${nextWidth}px`;
    },
    onDragCommit: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      setPanelWidthPx(drag.latestWidth);
    },
    onDragCancel: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      drag.panelElement.style.width = drag.initialStyleWidth;
    },
    onReset: () => {
      setPanelWidthPx(DEFAULT_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX);
    },
    onKeyNudge: (nudgeDirection) => {
      // Mirrored axis: ArrowRight (direction 1) SHRINKS a right-docked panel.
      setPanelWidthPx(panelWidthPx - nudgeDirection * KEYBOARD_RESIZE_STEP_PX);
    },
  });

  return (
    <div
      {...sliderProps}
      aria-valuenow={panelWidthPx}
      aria-valuemin={MIN_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX}
      aria-valuemax={MAX_ARTIFACT_VERSION_HISTORY_PANEL_WIDTH_PX}
      aria-label="Resize version history panel"
      data-testid="artifact-version-history-resize-handle"
      className={cn(
        "absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 ring-offset-background focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:border-l before:border-transparent before:transition-colors before:content-[''] hover:before:border-ring/50 focus-visible:before:border-ring/50",
        pointerDragHandleAxisClassName("horizontal"),
      )}
    />
  );
}

function VersionObservationList(props: {
  readonly entries: readonly ArtifactVersionObservationEntry[];
  readonly selectedId: string | null;
  readonly outcome: OutcomeNotice | null;
  readonly onSelect: (observationId: string) => void;
  readonly onOpenChat: (chatId: string) => void;
}): ReactNode {
  let previousDay: string | null = null;
  return props.entries.map((entry, index) => {
    const day = dayLabel(entry.capturedAt);
    const showDay = day !== previousDay;
    previousDay = day;
    const olderEntry = props.entries.at(index + 1);
    const renormalizedByEditorUpdate =
      olderEntry !== undefined &&
      entry.serializerVersion !== olderEntry.serializerVersion;
    const isNewOutcome = props.outcome?.observationId === entry.observationId;
    return (
      <div key={entry.observationId}>
        {showDay ? (
          <p className="sticky top-0 z-[1] border-b bg-background/95 px-3 py-1.5 text-ui-xs font-medium text-muted-foreground backdrop-blur-sm">
            {day}
          </p>
        ) : null}
        <div
          className={cn(
            "border-b border-l-2 border-l-transparent transition-colors hover:bg-foreground/5",
            props.selectedId === entry.observationId &&
              "border-l-primary bg-foreground/8",
          )}
        >
          <button
            type="button"
            aria-label={`Select version ${entry.observationId}`}
            data-testid={`artifact-version-observation-${entry.observationId}`}
            onClick={() => props.onSelect(entry.observationId)}
            className="w-full px-3 py-2.5 text-left"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-ui-sm font-medium">
                {PROVENANCE_LABELS[entry.provenance.kind]}
              </span>
              <span className="shrink-0 text-ui-xs text-muted-foreground tabular-nums">
                {formatCapturedTime(entry.capturedAt)}
              </span>
            </span>
            <span className="mt-1.5 flex flex-wrap gap-1 empty:hidden">
              {renormalizedByEditorUpdate ? (
                <Badge
                  variant="outline"
                  className="border-blue-500/30 text-blue-600 dark:text-blue-400"
                >
                  re-normalized by editor update
                </Badge>
              ) : null}
              {entry.degraded ? (
                <Badge variant="destructive">Body only — images missing</Badge>
              ) : null}
              {isNewOutcome && props.outcome.status === "clean" ? (
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                >
                  Restored
                </Badge>
              ) : null}
              {isNewOutcome && props.outcome.status === "renormalized" ? (
                <Badge
                  variant="outline"
                  className="border-blue-500/30 text-blue-600 dark:text-blue-400"
                >
                  re-normalized by a newer editor version — review
                </Badge>
              ) : null}
              {isNewOutcome && props.outcome.status === "degraded" ? (
                <Badge variant="destructive">
                  Restored with missing image content
                </Badge>
              ) : null}
            </span>
          </button>
          <ObservationProvenanceDetail
            provenance={entry.provenance}
            onOpenChat={props.onOpenChat}
          />
        </div>
      </div>
    );
  });
}

function VersionDiffView(props: {
  readonly artifactId: string;
  readonly selected: ArtifactVersionObservationEntry | null;
  readonly comparisonLabel: string | null;
  readonly comparisonObservationId: string | null;
  readonly beforeMarkdown: string | null;
  readonly afterMarkdown: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly outcome: OutcomeNotice["status"] | null;
  readonly onRetry: () => void;
  readonly onRestore: () => void;
}): ReactNode {
  const unchanged =
    props.comparisonLabel !== null &&
    props.afterMarkdown !== null &&
    props.beforeMarkdown === props.afterMarkdown;
  const patch =
    props.afterMarkdown === null
      ? null
      : buildSnapshotUnifiedPatch({
          filePath: `${props.artifactId}.md`,
          beforeContent: props.beforeMarkdown ?? "",
          afterContent: props.afterMarkdown,
          ignoreWhitespace: false,
        });
  if (props.selected === null) {
    return (
      <p className="p-5 text-muted-foreground">
        Select a version to inspect it.
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      {props.outcome === "clean" ? (
        <p className="border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-ui-sm text-emerald-700 dark:text-emerald-300">
          Restored as a new version.
        </p>
      ) : null}
      {props.outcome === "renormalized" ? (
        <p className="border-b border-blue-500/30 bg-blue-500/10 px-4 py-2 text-ui-sm text-blue-700 dark:text-blue-300">
          Restored. Content was re-normalized by a newer editor version —
          formatting may differ slightly.
        </p>
      ) : null}
      {props.outcome === "degraded" ? (
        <p className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-ui-sm text-amber-700 dark:text-amber-300">
          Restored as a new version with missing image content. The new row is
          marked Body only.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-ui-sm font-medium">
            {formatCapturedAt(props.selected.capturedAt)}
          </p>
          <p className="text-ui-xs text-muted-foreground">
            {props.comparisonLabel ?? "Oldest saved version — shown in full"}
          </p>
        </div>
        <Button size="sm" onClick={props.onRestore}>
          <RotateCcwIcon className="size-4" />
          Restore this version
        </Button>
      </div>
      <VersionDiffBody
        loading={props.loading}
        failed={props.failed}
        unchanged={unchanged}
        patch={patch}
        cacheScope={`artifact-version:${props.selected.observationId}:${props.comparisonObservationId ?? "none"}`}
        onRetry={props.onRetry}
      />
    </div>
  );
}

function VersionDiffBody(props: {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly unchanged: boolean;
  readonly patch: string | null;
  readonly cacheScope: string;
  readonly onRetry: () => void;
}): ReactNode {
  if (props.loading) {
    return <p className="p-4 text-muted-foreground">Loading comparison…</p>;
  }
  if (props.failed) {
    return (
      <div className="p-4">
        <p className="text-muted-foreground">
          Couldn&apos;t load this version&apos;s body.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={props.onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (props.patch === null) {
    return <p className="p-4 text-muted-foreground">Loading comparison…</p>;
  }
  if (props.unchanged) {
    return (
      <p className="p-4 text-muted-foreground">
        The body matches the compared version — this capture recorded a metadata
        change (title, status, or kind).
      </p>
    );
  }
  return (
    <DiffContentFrame
      sizing="fill"
      banner={null}
      scrollContainerRef={null}
      onScroll={null}
      fileIdentity={null}
    >
      <DiffContentPrimitive
        patch={props.patch}
        cacheScope={props.cacheScope}
        mode="unified"
        wordWrap
        backgrounds
        lineNumbers={false}
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
      />
    </DiffContentFrame>
  );
}

function RestoreVersionDialog(props: {
  readonly target: ArtifactVersionObservationEntry | null;
  readonly preflight: RestorePreflight | null;
  readonly unavailable: string | null;
  readonly retryable: boolean;
  readonly refreshing: boolean;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  return (
    <Dialog
      open={props.target !== null}
      onOpenChange={(open) => !open && props.onCancel()}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Restore this version?</DialogTitle>
          <DialogDescription>
            It becomes a new version at the top of history. Nothing is deleted.
          </DialogDescription>
        </DialogHeader>
        {props.refreshing ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-ui-sm">
            The artifact changed since you looked. Refreshing the checks before
            restoring…
          </div>
        ) : null}
        {props.preflight === null && props.unavailable === null ? (
          <p className="text-muted-foreground">
            Checking the current artifact…
          </p>
        ) : null}
        {props.preflight === null || props.refreshing ? null : (
          <div className="space-y-3">
            <p className="rounded-md bg-foreground/5 p-3 font-mono text-ui-xs break-all">
              Current hash: {props.preflight.currentHash}
            </p>
            {props.preflight.threadCount > 0 ? (
              <div className="flex gap-2 rounded-lg border p-3">
                <InfoIcon className="mt-0.5 size-4 shrink-0 text-blue-500" />
                <p>
                  {props.preflight.threadCount} anchored{" "}
                  {props.preflight.threadCount === 1 ? "comment" : "comments"}:
                  comments keep their text but may lose their place.
                </p>
              </div>
            ) : null}
            {props.preflight.imagesMissing.length > 0 ? (
              <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium">
                    {props.preflight.imagesMissing.length} image{" "}
                    {props.preflight.imagesMissing.length === 1
                      ? "pin is"
                      : "pins are"}{" "}
                    missing.
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    You can restore the body only, or cancel.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        )}
        {props.unavailable === null ? null : (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p>{props.unavailable}</p>
            {props.retryable ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={props.onRetry}
              >
                Retry
              </Button>
            ) : null}
          </div>
        )}
        <RestoreVersionDialogFooter {...props} />
      </DialogContent>
    </Dialog>
  );
}

function RestoreVersionDialogFooter(props: {
  readonly preflight: RestorePreflight | null;
  readonly unavailable: string | null;
  readonly refreshing: boolean;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const disabled =
    props.preflight === null ||
    props.unavailable !== null ||
    props.refreshing ||
    props.pending;
  const restoresBodyOnly =
    props.preflight !== null && props.preflight.imagesMissing.length > 0;

  return (
    <DialogFooter>
      <Button variant="outline" onClick={props.onCancel}>
        Cancel
      </Button>
      <Button onClick={props.onConfirm} disabled={disabled}>
        {restoresBodyOnly ? "Restore body only" : "Restore as new version"}
      </Button>
    </DialogFooter>
  );
}
